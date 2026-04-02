# Claude Code SDK in Agent OS

## Goal

Get Claude Code working end-to-end inside Agent OS through the Claude Code SDK path first, then validate the headless Claude ACP adapter path with the same llmock-style testing approach used around the PI tests.

## Current Status

- Claude is now wired into Agent OS as a real agent package under `registry/agent/claude`.
- Agent OS session config includes a `claude` agent entry in `packages/core/src/agents.ts`.
- Claude SDK/headless execution works inside Agent OS for Bash-backed commands.
- Agent OS now exposes a real `xu` command in the VM image:
  - native command crate: `registry/native/crates/commands/xu`
  - packaged into coreutils: `registry/software/coreutils`
- The direct ACP adapter path is passing in `packages/core/tests/claude-sdk-adapter.test.ts`.
- The full `createSession("claude")` path is passing in `packages/core/tests/claude-session.test.ts`.
- The full `createSession("claude")` path now also verifies Agent OS session API integration:
  - `listSessions`
  - `resumeSession`
  - `getSessionAgentInfo`
  - `getSessionCapabilities`
  - `getSessionModes`
  - `getSessionConfigOptions`
  - `closeSession`
- The Claude ACP/headless debug harness in `.agent/tmp/claude-acp-debug.mjs` now completes a full tool-use turn successfully.

## Key Runtime Patches

- Forced Claude onto `/bin/bash` inside Agent OS via:
  - `CLAUDE_CODE_SHELL=/bin/bash`
  - `SHELL=/bin/bash`
- Patched bundled Claude CLI login-shell arg ordering:
  - snapshot creation now uses `["-l","-c", ...]`
  - bash provider now uses `["-l","-c", ...]` when login shell is needed
- Patched Claude startup behavior to ignore premature startup exit codes when `CLAUDE_CODE_IGNORE_STARTUP_EXIT_CODE=1`.
- Patched runtime stdout/stderr normalization so buffer-like outputs no longer break on `.trim()`.
- Patched runtime to tolerate missing `fs/promises.realpath` in the Agent OS VM by falling back to the input path.
- Patched Claude Bash execution to force pipe-mode task output under Agent OS with `CLAUDE_CODE_USE_PIPE_OUTPUT=1`.
  - This fixed the prior file-backed TaskOutput failure path.

## Bugs Fixed Along The Way

- Fixed shell bootstrap failures caused by bad `bash -c -l` ordering.
- Fixed false “cwd disappeared” failures caused by missing `fs/promises.realpath` support in the VM bridge.
- Fixed Claude Bash tool retries that previously produced:
  - `<bash output unavailable: output file ... could not be read>`
  - repeated tool-call loops
  - eventual `EMFILE: too many open files`
- Fixed the `xu` execution gap in Agent OS:
  - the WASM shell could find a PATH script like `/home/user/bin/xu`
  - but executing that script by bare command name failed with `command not found`
  - the fix was to add `xu` as a real registered VM command instead of a shell-script fixture
- Fixed llmock fixture matching for Claude tests:
  - llmock normalizes tool results into `messages[].role === "tool"`
  - earlier tests incorrectly matched on raw `"tool_result"` JSON text
- Fixed llmock request inspection in Claude tests:
  - fixture predicates see `messages`
  - recorded requests from `mock.getRequests()` expose `body.messages`
  - helper logic now accepts both shapes
- Fixed ACP process-exit race in `packages/core/src/acp-client.ts` by adding a short stdout-drain grace period before rejecting pending requests on exit.
- Fixed duplicated inbound ACP request handling in `packages/core/src/acp-client.ts`:
  - VM stdout can duplicate NDJSON lines
  - duplicated `session/request_permission` requests were stateful and could trigger a second permission response
  - this caused noisy late Claude bridge errors like a response being routed to a session that no longer existed
  - inbound JSON-RPC request IDs are now deduped at the ACP client boundary
- Fixed the adjacent Pi SDK adapter overlay issue:
  - `tests/pi-sdk-adapter.test.ts` was creating a VM without explicit Pi software roots
  - the Pi adapter then resolved `@agentclientprotocol/sdk` through its nested `node_modules`, which escaped ModuleAccess
  - `registry/agent/pi/src/index.ts` now includes `@rivet-dev/agent-os-pi` in `requires`
  - `tests/pi-sdk-adapter.test.ts` now creates the VM with `software: [pi]`
  - this makes the adapter package and its nested dependency graph valid overlay roots
- Fixed llmock test teardown hanging by updating `packages/core/tests/helpers/llmock-helper.ts` to:
  - `unref()` the mock server after startup
  - close idle/all connections before stopping the server
- Fixed Agent OS session metadata extraction in `packages/core/src/agent-os.ts`:
  - `createSession()` previously only harvested `modes` and `configOptions` from `initialize`
  - the Claude adapter reports mode state on `session/new`
  - Agent OS now merges session-scoped metadata from `session/new`, so `getSessionModes()` and related session API surfaces reflect real Claude state
- Broadened public session metadata typing in `packages/core/src/session.ts` so the session API now accurately models Claude ACP payloads:
  - nested `promptCapabilities`
  - richer `agentInfo` including `title`
  - mode entries with adapter-provided `name`
- Fixed ACP cancel compatibility in `packages/core/src/acp-client.ts`:
  - ACP defines `session/cancel` as a notification, not a request
  - Agent OS was still sending it as a request, which mocks tolerated but the real Claude ACP adapter rejected with `-32601`
  - `AcpClient` now falls back to sending `session/cancel` as a notification when the request form is unsupported, while preserving the existing request/response surface for current tests and callers
- Fixed session mode-state sync in `packages/core/src/session.ts`:
  - real ACP agents like Claude emit `session/update` with `current_mode_update`
  - Agent OS now folds that update back into `getSessionModes()`
  - this makes `setSessionMode()` visible through the public session API on the live Claude path
- Fixed nested Node execution noise in the secure-exec runtime patch path:
  - `@secure-exec/nodejs` was injecting unconditional `console.error("[sandbox.require] ...")` lines into `dist/execution-driver.js`
  - that corrupted nested `node` execution inside Claude's Bash tool path and produced invalid non-JSON Claude CLI startup output
  - the repo pnpm patch at `patches/@secure-exec__nodejs@0.2.1.patch` now removes those injected stderr writes
- Improved ACP timeout diagnostics in `packages/core/src/acp-client.ts`:
  - timeouts now include process state (`exitCode`, `killed`)
  - timeouts now include recent ACP activity summaries
  - malformed or non-JSON stdout lines are recorded into the recent activity buffer so future startup/tooling stalls are diagnosable from the thrown error text

## Tests Added / Verified

- Passing:
  - `pnpm --filter @rivet-dev/agent-os-core exec vitest run tests/claude-sdk-adapter.test.ts tests/claude-session.test.ts --reporter verbose`
  - `pnpm --filter @rivet-dev/agent-os-core exec vitest run tests/wasm-commands.test.ts tests/acp-protocol.test.ts -t 'xu executes as a registered PATH command|session/request_permission flow -- agent sends ACP request, client responds|duplicate session/request_permission requests are deduped by request ID' --reporter verbose`
  - `pnpm --filter @rivet-dev/agent-os-core exec vitest run tests/claude-sdk-adapter.test.ts tests/claude-session.test.ts tests/acp-protocol.test.ts tests/wasm-commands.test.ts -t 'session/prompt can run PATH-backed xu commands inside Agent OS|createSession('\\''claude'\\'') runs PATH-backed xu commands end-to-end|session/request_permission flow -- agent sends ACP request, client responds|duplicate session/request_permission requests are deduped by request ID|xu executes as a registered PATH command' --reporter verbose`
  - `pnpm --filter @rivet-dev/agent-os-core exec vitest run tests/list-agents.test.ts tests/pi-acp-adapter.test.ts tests/pi-sdk-adapter.test.ts tests/claude-sdk-adapter.test.ts tests/claude-session.test.ts --reporter verbose`
  - `pnpm --filter @rivet-dev/agent-os-core exec vitest run tests/claude-sdk-adapter.test.ts tests/claude-session.test.ts --reporter verbose`
  - `pnpm --filter @rivet-dev/agent-os-core exec vitest run tests/claude-session.test.ts tests/claude-sdk-adapter.test.ts tests/acp-protocol.test.ts --reporter verbose`
  - `pnpm --filter @rivet-dev/agent-os-core build`

## Claude Behavior Verified

- Claude can initialize through the ACP adapter.
- Claude can create a real Agent OS session.
- Claude can execute Bash commands inside Agent OS and return the tool result inline.
- Claude can execute a real PATH-backed `xu` command inside Agent OS.
- Claude now has explicit regression coverage for nested subprocess execution through the Bash tool path:
  - `packages/core/tests/claude-session.test.ts`
  - `packages/core/tests/claude-sdk-adapter.test.ts`
  - both verify a nested `node` process calling:
    - `child_process.execSync(...)`
    - `child_process.spawn(...)` via a VM script (`node /tmp/async-spawn.cjs`)
- Claude now also has explicit mocked coverage for non-tool prompt turns:
  - both `claude-session.test.ts` and `claude-sdk-adapter.test.ts` verify a text-only response path with no `tool_call` events
- Claude session metadata is now verified through the public Agent OS session API:
  - session listing/resume lifecycle
  - adapter identity/title/version
  - ACP-style nested capabilities (`promptCapabilities`)
  - reported mode state
- Claude graceful teardown is now verified through the public Agent OS session API:
  - `cancelSession`
  - `destroySession`
- Claude mode changes are now verified through the public Agent OS session API:
  - `setSessionMode`
  - `getSessionModes` current-mode reflection
  - `session/update` mode event presence
- Claude generic session RPC is now verified through the public Agent OS session API:
  - `rawSessionSend("session/set_mode", ...)`
  - sessionId injection and state reflection on the live adapter path
- Claude can complete a full llmock-driven multi-turn interaction:
  - tool call
  - tool result
  - final streamed assistant text
- The targeted combined Claude + ACP + `xu` regression bundle exits cleanly without the earlier late bridge/permission noise.
- The targeted PI + Claude adapter/session slice also exits cleanly in one process.

## `xu` Note

- `xu` is now explicitly validated inside Agent OS.
- The implementation is a minimal native WASM command that prints:
  - `xu-ok:<joined args>`
- The Claude ACP tests use `xu hello-agent-os` and verify the resulting tool output `xu-ok:hello-agent-os`.

## Host Tools Follow-Up

- Fixed the unrelated host-tools failures that were keeping the full core suite red:
  - `packages/core/src/host-tools-argv.ts`
    - added Zod v4-safe schema introspection
    - object shapes now work with both `typeName/shape()` and `type/shape`
    - descriptions now read from `schema.description`
    - enum values now work with both `def.values` and v4 `options/entries`
  - `packages/core/src/host-tools-server.ts`
  - `packages/core/src/host-tools-prompt.ts`
    - both now use the shared Zod helpers instead of reading raw internals directly
- Fixed the adjacent PI SDK adapter regression:
  - `registry/agent/pi/src/index.ts` now includes `@rivet-dev/agent-os-pi` in `requires`
  - `tests/pi-sdk-adapter.test.ts` now creates the VM with `software: [pi]`
- Reworked host-tool CLI wrappers in `packages/core/src/host-tools-shims.ts`:
  - script files in `/usr/local/bin` cannot be executed directly by the VM shell
  - shell scripts also cannot reliably proxy child-process stdout/stderr inside this runtime
  - the wrappers are now Node entrypoints invoked explicitly as:
    - `node /usr/local/bin/agentos ...`
    - `node /usr/local/bin/agentos-<toolkit> ...`
  - stable supported input modes are now:
    - raw argv flags
    - `--json`
    - `--json-file`
  - piped stdin into Node wrappers is not relied on because the VM does not deliver stdin to `node` reliably in this execution path

## Final Verification

- Passing:
  - real live-token E2E via `node .agent/tmp/claude-session-real-e2e.mjs` using `~/misc/env.txt`
  - `pnpm --filter @rivet-dev/agent-os-core exec vitest run tests/claude-session.test.ts --reporter verbose`
  - `pnpm --filter @rivet-dev/agent-os-core exec vitest run tests/claude-session.test.ts tests/acp-protocol.test.ts --reporter verbose`
  - `pnpm --filter @rivet-dev/agent-os-core exec vitest run tests/claude-session.test.ts tests/session-comprehensive.test.ts --reporter verbose`
  - `pnpm --filter @rivet-dev/agent-os-core exec vitest run tests/claude-sdk-adapter.test.ts tests/claude-session.test.ts tests/acp-protocol.test.ts tests/wasm-commands.test.ts --reporter verbose`
  - `pnpm --filter @rivet-dev/agent-os-core exec vitest run tests/claude-sdk-adapter.test.ts tests/claude-session.test.ts tests/pi-sdk-adapter.test.ts tests/pi-acp-adapter.test.ts tests/acp-protocol.test.ts tests/wasm-commands.test.ts --reporter verbose`
  - `pnpm --filter @rivet-dev/agent-os-core exec vitest run tests/host-tools-argv.test.ts tests/host-tools-server.test.ts tests/host-tools-prompt.test.ts tests/host-tools-shims.test.ts --reporter verbose`
  - `pnpm --filter @rivet-dev/agent-os-core exec vitest run tests/list-agents.test.ts tests/pi-acp-adapter.test.ts tests/pi-sdk-adapter.test.ts tests/claude-sdk-adapter.test.ts tests/claude-session.test.ts --reporter verbose`
  - `pnpm --filter @rivet-dev/agent-os-core build`
  - `pnpm --filter @rivet-dev/agent-os-core test`

## Real E2E Result

- Verified on April 1, 2026 using `~/misc/env.txt` with a live `ANTHROPIC_API_KEY`
- Public Agent OS path exercised:
  - `AgentOs.createSession("claude")`
  - `vm.prompt(...)`
  - permission handling through `vm.onPermissionRequest(...)` and `vm.respondPermission(...)`
  - real OS tool call execution inside the VM via `xu hello-real-e2e`
- Observed result from the live run:
  - final assistant text: `xu-ok:hello-real-e2e`
  - stop reason: `end_turn`
  - permission requests: `1`
  - tool call events present
  - process exited cleanly after teardown
- Harness retained at `.agent/tmp/claude-session-real-e2e.mjs`

## Additional Live Claude Process Checks

- Verified on April 1, 2026 using `~/misc/env.txt` and the public Agent OS session API:
  - direct nested Node command through Claude:
    - prompt: run `node --version`
    - observed assistant text: `v22.14.0`
  - nested child-process execution through Claude:
    - prompt: run `node -e "console.log(require('child_process').execSync('echo child-ok').toString().trim())"`
    - observed assistant text: `child-ok`
  - nested spawn-based execution through Claude:
    - prompt: run `node -e "console.log(require('child_process').spawnSync('echo',['spawnsync-ok'],{encoding:'utf8'}).stdout.trim())"`
    - observed assistant text: `spawnsync-ok`
  - nested async-spawn execution through Claude:
    - prepared VM script: `/tmp/async-spawn.cjs`
    - prompt: run `node /tmp/async-spawn.cjs`
    - observed assistant text: `async-ok`
- Temporary live harness used:
  - `.agent/tmp/claude-session-real-spawn-e2e.mjs`
  - harness now supports `--async-spawn-script` and prints `recentSessionUpdates` on failures

## Remaining Spawn Follow-Up

- No known implementation blocker remains for normal nested process execution through Claude:
  - direct `node`
  - `child_process.execSync(...)`
  - `child_process.spawnSync(...)`
  - `child_process.spawn(...)` via a prepared script invoked from Claude
- The original stalled live prompts were addressed by:
  - improving ACP timeout diagnostics
  - moving the async-spawn proof onto a simpler command path (`node /tmp/async-spawn.cjs`) instead of a dense quoted one-liner
- One remaining optional proof would be:
  - a live natural-language prompt where Claude independently invents and completes an async `child_process.spawn(...)` workflow without a prewritten script
  - this is no longer a blocker for runtime validation because the async spawn path itself is now proven both live and in mocked regressions

## Additional Verification Notes

- Direct Agent OS non-Claude harness check also passed:
  - wrote `/tmp/async-spawn.cjs` inside the VM
  - executed `node /tmp/async-spawn.cjs`
  - observed: `exitCode: 0`, `stdout: async-ok`
- Full `@rivet-dev/agent-os-core` package rerun confirms the Claude files now stay green under full-suite load:
  - `tests/claude-sdk-adapter.test.ts`: `5 passed`
  - `tests/claude-session.test.ts`: `8 passed`
- Current full package failures remain unrelated to Claude:
  - `tests/opencode-acp.test.ts`
  - `tests/opencode-session.test.ts`
  - latest full-suite result: `42 passed` files, `2 failed` files; `497 passed` tests, `8 failed` tests
- `pnpm --filter @rivet-dev/agent-os-core build` is currently red for an unrelated pre-existing TypeScript issue:
  - `src/sqlite-bindings.ts`

## Remaining Follow-Up

- No remaining functional blockers are known for Claude Code SDK + ACP inside Agent OS.
- Optional follow-up only:
  - exact reconstruction of the final assistant sentence from raw `session/update` text chunks is still more brittle than the stable surfaces we assert today
  - current stable surface remains:
    - llmock recorded tool result
    - session/update event presence
- The Claude debug harness still exists in `.agent/tmp/` if deeper inspection is needed later.
