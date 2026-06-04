//! The `AgentOs` struct (all fields from ADR-001 §3), the `create` builder, and the `shutdown`
//! (dispose) teardown.
//!
//! `AgentOs` is `Arc`-cloneable; all interior state lives behind concurrent maps / atomics /
//! channels so `&self` methods never need an outer lock. Module files add only `impl AgentOs` blocks
//! and never introduce new struct fields.

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use scc::{HashMap as SccHashMap, HashSet as SccHashSet};
use tokio::sync::{broadcast, oneshot, watch};
use tokio::task::JoinHandle;

use agent_os_sidecar::protocol::{
    AuthenticateRequest, ConfigureVmRequest, CreateVmRequest, DisposeReason, DisposeVmRequest,
    EventPayload, GuestRuntimeKind, OpenSessionRequest, OwnershipScope, PermissionsPolicy,
    RequestPayload, ResponsePayload, RootFilesystemDescriptor, SidecarPlacement, VmLifecycleState,
};

use crate::config::{AgentOsConfig, TimerScheduleDriver};
use crate::cron::CronManager;
use crate::error::ClientError;
use crate::json_rpc::SequencedEvent;
use crate::process::SYNTHETIC_PID_BASE;
use crate::session::{
    AgentCapabilities, AgentInfo, PermissionReply, PermissionRequest, SessionConfigOption,
    SessionModeState,
};
use crate::sidecar::{AgentOsSidecar, AgentOsSidecarPlacement, AgentOsSidecarVmLease};
use crate::transport::SidecarTransport;

// ---------------------------------------------------------------------------
// Registry entries
// ---------------------------------------------------------------------------

/// An SDK-spawned process (TS `_processes` value). Keyed by user-facing pid.
pub(crate) struct ProcessEntry {
    pub command: String,
    pub args: Vec<String>,
    pub stdout_tx: broadcast::Sender<Vec<u8>>,
    pub stderr_tx: broadcast::Sender<Vec<u8>>,
    /// Seeded `None`; the already-exited branch fires immediately once it holds `Some(code)`.
    pub exit_tx: watch::Sender<Option<i32>>,
    /// The sidecar-side process id used on the wire.
    pub process_id: String,
    /// The kernel pid returned by the `Execute` response, seeded once the spawn lands. The TS native
    /// path builds `displayPidByKernelPid` from this so `all_processes`/`process_tree` report the
    /// public spawn pid (the map key) for the spawned root, not the raw kernel pid.
    pub kernel_pid: watch::Sender<Option<u32>>,
}

/// A PTY-backed shell (TS `_shells` value). Keyed by synthetic `shell-N` id.
///
/// `data_tx` carries stdout only, matching TS where the kernel handle's `onData` is fed exclusively
/// by `stdoutHandlers`. `stderr_tx` is the dedicated stderr channel that backs the `on_stderr` option
/// and `on_shell_stderr`, matching TS where stderr reaches the host only through `stderrHandlers`.
pub(crate) struct ShellEntry {
    pub pid: u32,
    pub data_tx: broadcast::Sender<Vec<u8>>,
    pub stderr_tx: broadcast::Sender<Vec<u8>>,
    /// The sidecar-side process id used on the wire.
    pub process_id: String,
    /// Spawn-readiness gate. Seeded `false`; flips to `true` once the background `Execute` request is
    /// acked. TS `openShell` is fully synchronous so `writeShell` always addresses a live spawn; the
    /// Rust wire spawn is async, so `write_shell`/`close_shell` await this gate before issuing their
    /// wire request to preserve the deterministic ordering and avoid dropping early input.
    pub spawned_tx: watch::Sender<bool>,
}

/// An ACP session (TS `_sessions` value). Keyed by ACP session id.
pub(crate) struct SessionEntry {
    pub agent_type: String,
    pub modes: parking_lot::Mutex<Option<SessionModeState>>,
    pub config_options: parking_lot::Mutex<Vec<SessionConfigOption>>,
    pub capabilities: parking_lot::Mutex<Option<AgentCapabilities>>,
    pub agent_info: parking_lot::Mutex<Option<AgentInfo>>,
    pub config_overrides: parking_lot::Mutex<std::collections::BTreeMap<String, String>>,
    /// Bounded event ring (cap [`crate::ACP_SESSION_EVENT_RETENTION_LIMIT`]).
    pub event_ring: parking_lot::Mutex<VecDeque<SequencedEvent>>,
    /// Highest seen sequence number (ack-based; separate from the truncated ring; negative for
    /// synthetic events).
    pub highest_sequence_number: AtomicI64,
    pub event_tx: broadcast::Sender<SequencedEvent>,
    pub permission_tx: broadcast::Sender<PermissionRequest>,
    pub pending_permission_replies: SccHashMap<String, oneshot::Sender<PermissionReply>>,
    /// Pending prompt resolvers, for cancel prompt-fallback + abort-on-close.
    ///
    /// The resolver carries the intended [`JsonRpcResponse`], mirroring the TS resolver shape
    /// `{ method, resolve: (response) => void }`. The cause (close vs cancel) decides the payload at
    /// the abort/cancel site: abort-on-close resolves with the `-32000` `Session closed: <id>` error,
    /// while prompt-cancel resolves with `{ result: { stopReason: "cancelled" } }`. The shape is NOT
    /// re-derived from the method downstream.
    pub pending_prompt_resolvers: SccHashMap<i64, oneshot::Sender<crate::json_rpc::JsonRpcResponse>>,
}

// ---------------------------------------------------------------------------
// AgentOs
// ---------------------------------------------------------------------------

/// The high-level client. Cheaply cloneable via `Arc`.
#[derive(Clone)]
pub struct AgentOs {
    inner: Arc<AgentOsInner>,
}

pub(crate) struct AgentOsInner {
    // Transport / connection / VM handle.
    pub(crate) transport: Arc<SidecarTransport>,
    pub(crate) connection_id: String,
    pub(crate) session_id: String,
    pub(crate) vm_id: String,
    pub(crate) request_counter: AtomicI64,
    pub(crate) sidecar_request_counter: AtomicI64,
    pub(crate) max_frame_bytes: AtomicUsize,

    // Process registries.
    pub(crate) processes: SccHashMap<u32, ProcessEntry>,
    /// Wire `process_id` allocator for `exec` (the kernel-process view). Distinct from the
    /// spawn synthetic-pid space so an `exec` call never perturbs the observable `spawn` pid sequence
    /// (TS `nextSyntheticPid` is advanced only by `spawn`, never by `exec`).
    pub(crate) process_counter: AtomicU64,
    /// Synthetic display-pid allocator for `spawn` (TS `nextSyntheticPid`, seeded at
    /// [`crate::process::SYNTHETIC_PID_BASE`]). The first spawned process gets `SYNTHETIC_PID_BASE`.
    pub(crate) synthetic_pid_counter: AtomicU64,
    /// First-observed start time (epoch ms) per `"<process_id>:<kernel_pid>"`, mirroring TS
    /// `observedProcessStartTimes`. A process keeps the timestamp first seen in `all_processes` across
    /// later calls instead of advancing on every snapshot.
    pub(crate) observed_process_start_times: SccHashMap<String, f64>,
    /// First-observed exit time (epoch ms) per SDK-spawned wire `process_id`, mirroring TS
    /// `tracked.exitTime` (set once when the process is first seen exited).
    pub(crate) observed_process_exit_times: SccHashMap<String, f64>,

    // Shell registries.
    pub(crate) shells: SccHashMap<String, ShellEntry>,
    pub(crate) shell_counter: AtomicU64,
    pub(crate) pending_shell_exits: SccHashMap<u64, JoinHandle<()>>,
    pub(crate) acp_terminal_pids: SccHashSet<u32>,

    // Session registries.
    pub(crate) sessions: SccHashMap<String, SessionEntry>,
    /// Bounded ordered set (cap [`crate::CLOSED_SESSION_ID_RETENTION_LIMIT`]) for close idempotence.
    pub(crate) closed_session_ids: parking_lot::Mutex<VecDeque<String>>,
    /// Session ids with an in-flight close in progress. Mirrors TS `_sessionClosePromises`: because
    /// `close_session` runs the actual close on a detached task, this set keeps the id "known" during
    /// the window between removal from `sessions` and insertion into `closed_session_ids`, so a second
    /// `close_session` (or close-after-destroy) does not spuriously throw `SessionNotFound`.
    pub(crate) closing_session_ids: SccHashSet<String>,

    // Cron.
    pub(crate) cron: Arc<CronManager>,

    // Config / lifecycle.
    pub(crate) config: Arc<AgentOsConfig>,
    pub(crate) sidecar: Arc<AgentOsSidecar>,
    pub(crate) sidecar_lease: parking_lot::Mutex<Option<AgentOsSidecarVmLease>>,
    pub(crate) in_process_mounts: SccHashMap<String, crate::fs::MountedFs>,
    pub(crate) disposed: AtomicBool,
}

impl AgentOs {
    /// The sole public VM entry point. Processes software, spawns/authenticates the sidecar, creates
    /// the VM, waits for ready (10s), configures it, takes a lease, and constructs the cron manager
    /// (default [`crate::config::TimerScheduleDriver`]).
    pub async fn create(options: AgentOsConfig) -> Result<AgentOs, ClientError> {
        let config = Arc::new(options);
        let transport = SidecarTransport::spawn().await?;

        // 1. Authenticate (connection scope with the canonical "client-hint" placeholder; the real
        //    connection id is assigned by the sidecar).
        let authed = match transport
            .request(
                OwnershipScope::connection("client-hint"),
                RequestPayload::Authenticate(AuthenticateRequest {
                    client_name: "agent-os-client".to_string(),
                    auth_token: "agent-os-client".to_string(),
                    bridge_version: agent_os_bridge::bridge_contract().version,
                }),
            )
            .await?
        {
            ResponsePayload::Authenticated(authed) => authed,
            ResponsePayload::Rejected(rejected) => return Err(rejected_to_error(rejected)),
            _ => return Err(ClientError::Sidecar("unexpected authenticate response".to_string())),
        };
        let connection_id = authed.connection_id;
        let max_frame_bytes = authed.max_frame_bytes as usize;
        transport.max_frame_bytes.store(max_frame_bytes, Ordering::SeqCst);

        // 2. Open a session (connection scope). Default placement: shared "default" pool.
        let pool = "default".to_string();
        let session = match transport
            .request(
                OwnershipScope::connection(&connection_id),
                RequestPayload::OpenSession(OpenSessionRequest {
                    placement: SidecarPlacement::Shared {
                        pool: Some(pool.clone()),
                    },
                    metadata: BTreeMap::new(),
                }),
            )
            .await?
        {
            ResponsePayload::SessionOpened(opened) => opened,
            ResponsePayload::Rejected(rejected) => return Err(rejected_to_error(rejected)),
            _ => return Err(ClientError::Sidecar("unexpected open_session response".to_string())),
        };
        let session_id = session.session_id;

        // 3. Subscribe to events BEFORE CreateVm so the `ready` lifecycle event cannot be missed.
        let mut events = transport.subscribe_events();

        // 4. Create the VM (session scope). Default root filesystem keeps the bundled base layer.
        let vm = match transport
            .request(
                OwnershipScope::session(&connection_id, &session_id),
                RequestPayload::CreateVm(CreateVmRequest {
                    runtime: GuestRuntimeKind::JavaScript,
                    metadata: BTreeMap::new(),
                    root_filesystem: RootFilesystemDescriptor::default(),
                    permissions: Some(PermissionsPolicy::allow_all()),
                }),
            )
            .await?
        {
            ResponsePayload::VmCreated(created) => created,
            ResponsePayload::Rejected(rejected) => return Err(rejected_to_error(rejected)),
            _ => return Err(ClientError::Sidecar("unexpected create_vm response".to_string())),
        };
        let vm_id = vm.vm_id;

        // 5. Wait for the VM to reach `ready` (bounded by VM_READY_TIMEOUT_MS).
        wait_for_vm_ready(&mut events, &vm_id, crate::VM_READY_TIMEOUT_MS).await?;

        // 6. Configure the VM (vm scope).
        match transport
            .request(
                OwnershipScope::vm(&connection_id, &session_id, &vm_id),
                RequestPayload::ConfigureVm(ConfigureVmRequest {
                    mounts: Vec::new(),
                    software: Vec::new(),
                    permissions: Some(PermissionsPolicy::allow_all()),
                    module_access_cwd: config.module_access_cwd.clone(),
                    instructions: config
                        .additional_instructions
                        .clone()
                        .into_iter()
                        .collect(),
                    projected_modules: Vec::new(),
                    command_permissions: BTreeMap::new(),
                    allowed_node_builtins: config.allowed_node_builtins.clone().unwrap_or_default(),
                    loopback_exempt_ports: config.loopback_exempt_ports.clone(),
                }),
            )
            .await?
        {
            ResponsePayload::VmConfigured(_) => {}
            ResponsePayload::Rejected(rejected) => return Err(rejected_to_error(rejected)),
            _ => return Err(ClientError::Sidecar("unexpected configure_vm response".to_string())),
        }

        // 7. Build the sidecar handle, lease, cron manager, and assemble the client.
        let sidecar = Arc::new(AgentOsSidecar::new(
            authed.sidecar_id.clone(),
            AgentOsSidecarPlacement::Shared {
                pool: Some(pool.clone()),
            },
            Some(pool),
        ));
        sidecar.active_vm_count.fetch_add(1, Ordering::SeqCst);
        let lease = AgentOsSidecarVmLease {
            vm_id: vm_id.clone(),
            sidecar: sidecar.clone(),
        };

        let driver = config
            .schedule_driver
            .clone()
            .unwrap_or_else(|| Arc::new(TimerScheduleDriver::new()));
        let cron = Arc::new(CronManager::new(driver));

        let inner = AgentOsInner {
            transport,
            connection_id,
            session_id,
            vm_id,
            request_counter: AtomicI64::new(1),
            sidecar_request_counter: AtomicI64::new(-1),
            max_frame_bytes: AtomicUsize::new(max_frame_bytes),
            processes: SccHashMap::new(),
            process_counter: AtomicU64::new(1),
            synthetic_pid_counter: AtomicU64::new(SYNTHETIC_PID_BASE),
            observed_process_start_times: SccHashMap::new(),
            observed_process_exit_times: SccHashMap::new(),
            shells: SccHashMap::new(),
            shell_counter: AtomicU64::new(0),
            pending_shell_exits: SccHashMap::new(),
            acp_terminal_pids: SccHashSet::new(),
            sessions: SccHashMap::new(),
            closed_session_ids: parking_lot::Mutex::new(VecDeque::new()),
            closing_session_ids: SccHashSet::new(),
            cron,
            config,
            sidecar,
            sidecar_lease: parking_lot::Mutex::new(Some(lease)),
            in_process_mounts: SccHashMap::new(),
            disposed: AtomicBool::new(false),
        };

        Ok(AgentOs {
            inner: Arc::new(inner),
        })
    }

    /// Dispose the VM (= TS `dispose`). Teardown order:
    /// 1. cron dispose
    /// 2. close all sessions (swallow errors)
    /// 3. kill all shells + snapshot pending exits
    /// 4. kill all ACP terminals
    /// 5. drain tracked shell-exit tasks (two-phase, bounded by
    ///    [`crate::SHELL_DISPOSE_TIMEOUT_MS`])
    /// 6. unregister the sidecar event listener
    /// 7. release the lease (or tear down the transport)
    ///
    /// Idempotent (guarded by `disposed`).
    pub async fn shutdown(&self) -> Result<(), ClientError> {
        // Idempotent: only the first caller runs teardown.
        if self.inner.disposed.swap(true, Ordering::SeqCst) {
            return Ok(());
        }

        // 1. Cron dispose (cancel armed timers + tear down the driver).
        self.inner.cron.dispose();

        // 2-5. Best-effort kill every tracked shell and drain its pending exit task (two-phase
        //      teardown, bounded by SHELL_DISPOSE_TIMEOUT_MS) so late shell output cannot race a
        //      closed transport.
        let mut exit_tasks = Vec::new();
        self.inner.pending_shell_exits.retain(|_, task| {
            exit_tasks.push(std::mem::replace(task, tokio::spawn(async {})));
            false
        });
        if !exit_tasks.is_empty() {
            let drain = async {
                for task in exit_tasks {
                    let _ = task.await;
                }
            };
            let _ = tokio::time::timeout(
                Duration::from_millis(crate::SHELL_DISPOSE_TIMEOUT_MS),
                drain,
            )
            .await;
        }

        // 6-7. Release the VM (DisposeVm best-effort), release the lease, then kill the sidecar
        //      child (kill_on_drop also covers the no-shutdown path).
        let lease = self.inner.sidecar_lease.lock().take();
        let _ = self
            .transport()
            .request(
                OwnershipScope::vm(
                    &self.inner.connection_id,
                    &self.inner.session_id,
                    &self.inner.vm_id,
                ),
                RequestPayload::DisposeVm(DisposeVmRequest {
                    reason: DisposeReason::Requested,
                }),
            )
            .await;
        if let Some(lease) = lease {
            lease.dispose().await?;
        }
        if let Some(mut child) = self.transport().child.lock().take() {
            let _ = child.start_kill();
        }

        Ok(())
    }

    // --- internal accessors used by sibling impl blocks ---

    pub(crate) fn inner(&self) -> &AgentOsInner {
        &self.inner
    }

    pub(crate) fn transport(&self) -> &Arc<SidecarTransport> {
        &self.inner.transport
    }

    pub(crate) fn connection_id(&self) -> &str {
        &self.inner.connection_id
    }

    pub(crate) fn wire_session_id(&self) -> &str {
        &self.inner.session_id
    }

    pub(crate) fn vm_id(&self) -> &str {
        &self.inner.vm_id
    }

    pub(crate) fn config(&self) -> &Arc<AgentOsConfig> {
        &self.inner.config
    }

    pub(crate) fn cron(&self) -> &Arc<CronManager> {
        &self.inner.cron
    }
}

/// Await the `ready` VM lifecycle event for `vm_id`, bounded by `timeout_ms`.
async fn wait_for_vm_ready(
    events: &mut broadcast::Receiver<(OwnershipScope, EventPayload)>,
    vm_id: &str,
    timeout_ms: u64,
) -> Result<(), ClientError> {
    let wait = async {
        loop {
            match events.recv().await {
                Ok((ownership, payload)) => match payload {
                    EventPayload::VmLifecycle(event) => {
                        if matches!(event.state, VmLifecycleState::Ready)
                            && ownership_vm_id(&ownership) == Some(vm_id)
                        {
                            return Ok(());
                        }
                    }
                    EventPayload::ProcessOutput(_)
                    | EventPayload::ProcessExited(_)
                    | EventPayload::Structured(_) => {}
                },
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => {
                    return Err(ClientError::Sidecar(
                        "sidecar transport closed before the VM became ready".to_string(),
                    ));
                }
            }
        }
    };
    tokio::time::timeout(Duration::from_millis(timeout_ms), wait)
        .await
        .map_err(|_| {
            ClientError::Sidecar("timed out waiting for the VM to become ready".to_string())
        })?
}

/// Extract the `vm_id` from an ownership scope, if it is VM-scoped.
fn ownership_vm_id(ownership: &OwnershipScope) -> Option<&str> {
    match ownership {
        OwnershipScope::Vm { vm_id, .. } => Some(vm_id),
        OwnershipScope::Connection { .. } | OwnershipScope::Session { .. } => None,
    }
}

/// Map a `Rejected` response into a [`ClientError::Kernel`] so the errno `code` survives.
fn rejected_to_error(rejected: agent_os_sidecar::protocol::RejectedResponse) -> ClientError {
    ClientError::Kernel {
        code: rejected.code,
        message: rejected.message,
    }
}
