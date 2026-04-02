/**
 * Tests for TCP socket RPC handlers in WasmVmRuntimeDriver.
 *
 * Verifies net_socket, net_connect, net_send, net_recv, net_close
 * lifecycle through the driver's _handleSyscall method. Uses a local
 * TCP echo server for realistic integration testing.
 *
 * Socket operations route through kernel SocketTable with a real
 * HostNetworkAdapter (node:net backed) for external TCP connections.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, connect as tcpConnect, type Server, type Socket as NetSocket } from 'node:net';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWasmVmRuntime } from '../src/driver.ts';
import type { WasmVmRuntimeOptions } from '../src/driver.ts';
import {
  SIGNAL_BUFFER_BYTES,
  DATA_BUFFER_BYTES,
  SIG_IDX_STATE,
  SIG_IDX_ERRNO,
  SIG_IDX_INT_RESULT,
  SIG_IDX_DATA_LEN,
  SIG_STATE_READY,
  type SyscallRequest,
} from '../src/syscall-rpc.ts';
import { ERRNO_MAP } from '../src/wasi-constants.ts';
import { PipeManager, SocketTable, SOL_SOCKET, SO_REUSEADDR, SO_RCVBUF } from '@secure-exec/core';
import type { HostNetworkAdapter, HostSocket } from '@secure-exec/core';

// -------------------------------------------------------------------------
// Node.js HostNetworkAdapter for tests (real TCP connections)
// -------------------------------------------------------------------------

class TestHostSocket implements HostSocket {
  private socket: NetSocket;
  private readQueue: (Uint8Array | null)[] = [];
  private waiters: ((v: Uint8Array | null) => void)[] = [];
  private ended = false;

  constructor(socket: NetSocket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      const data = new Uint8Array(chunk);
      const w = this.waiters.shift();
      if (w) w(data); else this.readQueue.push(data);
    });
    socket.on('end', () => {
      this.ended = true;
      const w = this.waiters.shift();
      if (w) w(null); else this.readQueue.push(null);
    });
    socket.on('error', () => {
      if (!this.ended) {
        this.ended = true;
        for (const w of this.waiters.splice(0)) w(null);
        this.readQueue.push(null);
      }
    });
  }

  async write(data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(data, (err) => err ? reject(err) : resolve());
    });
  }

  async read(): Promise<Uint8Array | null> {
    const q = this.readQueue.shift();
    if (q !== undefined) return q;
    if (this.ended) return null;
    return new Promise<Uint8Array | null>((r) => this.waiters.push(r));
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.destroyed) { resolve(); return; }
      this.socket.once('close', () => resolve());
      this.socket.destroy();
    });
  }

  setOption(): void { /* no-op for tests */ }
  shutdown(how: 'read' | 'write' | 'both'): void {
    if (how === 'write' || how === 'both') this.socket.end();
  }
}

function createTestHostAdapter(): HostNetworkAdapter {
  return {
    async tcpConnect(host: string, port: number): Promise<HostSocket> {
      return new Promise((resolve, reject) => {
        const s = tcpConnect({ host, port }, () => resolve(new TestHostSocket(s)));
        s.on('error', reject);
      });
    },
    async tcpListen() { throw new Error('not implemented'); },
    async udpBind() { throw new Error('not implemented'); },
    async udpSend() { throw new Error('not implemented'); },
    async dnsLookup() { throw new Error('not implemented'); },
  };
}

/** Create a mock kernel with a real SocketTable + HostNetworkAdapter for tests. */
function createMockKernel() {
  const hostAdapter = createTestHostAdapter();
  const socketTable = new SocketTable({
    hostAdapter,
    networkCheck: () => ({ allow: true }),
  });
  const pipeManager = new PipeManager();
  const pipeDescriptions = new Map<number, number>();
  let nextPipeFd = 10_000;

  const getPipeDescription = (fd: number) => pipeDescriptions.get(fd);

  return {
    socketTable,
    createPipe() {
      const { read, write } = pipeManager.createPipe();
      const readFd = nextPipeFd++;
      const writeFd = nextPipeFd++;
      pipeDescriptions.set(readFd, read.description.id);
      pipeDescriptions.set(writeFd, write.description.id);
      return { readFd, writeFd };
    },
    fdWrite(_pid: number, fd: number, data: Uint8Array) {
      const descriptionId = getPipeDescription(fd);
      if (descriptionId === undefined) {
        throw new Error(`unknown pipe fd ${fd}`);
      }
      return pipeManager.write(descriptionId, data);
    },
    fdPoll(_pid: number, fd: number) {
      const descriptionId = getPipeDescription(fd);
      if (descriptionId === undefined) {
        return { invalid: true, readable: false, writable: false, hangup: false };
      }
      const state = pipeManager.pollState(descriptionId);
      return state
        ? { ...state, invalid: false }
        : { invalid: true, readable: false, writable: false, hangup: false };
    },
    async fdPollWait(_pid: number, fd: number, timeoutMs?: number) {
      const descriptionId = getPipeDescription(fd);
      if (descriptionId === undefined) {
        return;
      }
      await pipeManager.waitForPoll(descriptionId, timeoutMs);
    },
    dispose() {
      for (const descriptionId of pipeDescriptions.values()) {
        pipeManager.close(descriptionId);
      }
      pipeDescriptions.clear();
      socketTable.disposeAll();
    },
  };
}

// -------------------------------------------------------------------------
// TCP echo server helper
// -------------------------------------------------------------------------

function createEchoServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((conn: NetSocket) => {
      conn.on('data', (chunk) => conn.write(chunk)); // Echo back
      conn.on('error', () => {}); // Ignore client errors
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind'));
        return;
      }
      resolve({ server, port: addr.port });
    });
    server.on('error', reject);
  });
}

// -------------------------------------------------------------------------
// _handleSyscall test helper
// -------------------------------------------------------------------------

/**
 * Call _handleSyscall on a driver and extract the response from the SAB.
 * This simulates what the worker thread does: post a syscall request,
 * then read the response from the shared buffers.
 */
async function callSyscall(
  driver: ReturnType<typeof createWasmVmRuntime>,
  call: string,
  args: Record<string, unknown>,
  kernel?: unknown,
): Promise<{ errno: number; intResult: number; data: Uint8Array }> {
  const signalBuf = new SharedArrayBuffer(SIGNAL_BUFFER_BYTES);
  const dataBuf = new SharedArrayBuffer(DATA_BUFFER_BYTES);

  const msg: SyscallRequest = { type: 'syscall', call, args };

  // Access private method — safe for testing
  await (driver as any)._handleSyscall(msg, 1, kernel ?? {}, signalBuf, dataBuf);

  const signal = new Int32Array(signalBuf);
  const data = new Uint8Array(dataBuf);

  const errno = Atomics.load(signal, SIG_IDX_ERRNO);
  const intResult = Atomics.load(signal, SIG_IDX_INT_RESULT);
  const dataLen = Atomics.load(signal, SIG_IDX_DATA_LEN);
  const responseData = dataLen > 0 ? data.slice(0, dataLen) : new Uint8Array(0);

  return { errno, intResult, data: responseData };
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe('TCP socket RPC handlers', () => {
  let echoServer: Server;
  let echoPort: number;
  let driver: ReturnType<typeof createWasmVmRuntime>;
  let kernel: ReturnType<typeof createMockKernel>;

  beforeEach(async () => {
    const echo = await createEchoServer();
    echoServer = echo.server;
    echoPort = echo.port;

    driver = createWasmVmRuntime({ commandDirs: [] });
    kernel = createMockKernel();
  });

  afterEach(async () => {
    kernel.dispose();
    await driver.dispose();
    await new Promise<void>((resolve) => echoServer.close(() => resolve()));
  });

  // Scoped helper that binds the kernel for all socket operations
  const call = (name: string, args: Record<string, unknown>) =>
    callSyscall(driver, name, args, kernel);

  it('netSocket allocates a socket ID', async () => {
    const res = await call('netSocket', { domain: 2, type: 1, protocol: 0 });
    expect(res.errno).toBe(0);
    expect(res.intResult).toBeGreaterThan(0);
  });

  it('netConnect to local echo server succeeds', async () => {
    const socketRes = await call('netSocket', { domain: 2, type: 1, protocol: 0 });
    expect(socketRes.errno).toBe(0);
    const fd = socketRes.intResult;

    const connectRes = await call('netConnect', {
      fd,
      addr: `127.0.0.1:${echoPort}`,
    });
    expect(connectRes.errno).toBe(0);
  });

  it('netConnect to invalid address returns ECONNREFUSED', async () => {
    const socketRes = await call('netSocket', { domain: 2, type: 1, protocol: 0 });
    const fd = socketRes.intResult;

    const connectRes = await call('netConnect', {
      fd,
      addr: '127.0.0.1:1',
    });
    expect(connectRes.errno).toBe(ERRNO_MAP.ECONNREFUSED);
  });

  it('netConnect with bad address format returns EINVAL', async () => {
    const socketRes = await call('netSocket', { domain: 2, type: 1, protocol: 0 });
    const fd = socketRes.intResult;

    const connectRes = await call('netConnect', {
      fd,
      addr: 'invalid-no-port',
    });
    expect(connectRes.errno).toBe(ERRNO_MAP.EINVAL);
  });

  it('netSend and netRecv echo round-trip', async () => {
    const socketRes = await call('netSocket', { domain: 2, type: 1, protocol: 0 });
    const fd = socketRes.intResult;
    await call('netConnect', { fd, addr: `127.0.0.1:${echoPort}` });

    const message = 'hello TCP';
    const sendData = Array.from(new TextEncoder().encode(message));
    const sendRes = await call('netSend', { fd, data: sendData, flags: 0 });
    expect(sendRes.errno).toBe(0);
    expect(sendRes.intResult).toBe(sendData.length);

    const recvRes = await call('netRecv', { fd, length: 1024, flags: 0 });
    expect(recvRes.errno).toBe(0);
    expect(new TextDecoder().decode(recvRes.data)).toBe(message);
  });

  it('netSetsockopt stores little-endian integer values in the kernel socket table', async () => {
    const socketRes = await call('netSocket', { domain: 2, type: 1, protocol: 0 });
    const fd = socketRes.intResult;

    const setRes = await call('netSetsockopt', {
      fd,
      level: SOL_SOCKET,
      optname: SO_REUSEADDR,
      optval: [1, 0, 0, 0],
    });

    expect(setRes.errno).toBe(0);
    expect(kernel.socketTable.getsockopt(fd, SOL_SOCKET, SO_REUSEADDR)).toBe(1);
  });

  it('netGetsockopt returns little-endian integer bytes from the kernel socket table', async () => {
    const socketRes = await call('netSocket', { domain: 2, type: 1, protocol: 0 });
    const fd = socketRes.intResult;
    kernel.socketTable.setsockopt(fd, SOL_SOCKET, SO_RCVBUF, 4096);

    const getRes = await call('netGetsockopt', {
      fd,
      level: SOL_SOCKET,
      optname: SO_RCVBUF,
      optvalLen: 4,
    });

    expect(getRes.errno).toBe(0);
    expect(getRes.intResult).toBe(4);
    expect(Array.from(getRes.data)).toEqual([0, 16, 0, 0]);
  });

  it('kernelSocketGetLocalAddr and kernelSocketGetRemoteAddr return loopback socket addresses', async () => {
    const listenerRes = await call('netSocket', { domain: 2, type: 1, protocol: 0 });
    const listenerFd = listenerRes.intResult;
    const bindRes = await call('netBind', { fd: listenerFd, addr: '127.0.0.1:0' });
    expect(bindRes.errno).toBe(0);

    const listenerAddrRes = await call('kernelSocketGetLocalAddr', { fd: listenerFd });
    expect(listenerAddrRes.errno).toBe(0);
    const listenerAddr = new TextDecoder().decode(listenerAddrRes.data);
    expect(listenerAddr).toMatch(/^127\.0\.0\.1:\d+$/);

    const listenRes = await call('netListen', { fd: listenerFd, backlog: 8 });
    expect(listenRes.errno).toBe(0);

    const clientRes = await call('netSocket', { domain: 2, type: 1, protocol: 0 });
    const clientFd = clientRes.intResult;

    const connectRes = await call('netConnect', { fd: clientFd, addr: listenerAddr });
    expect(connectRes.errno).toBe(0);

    const acceptRes = await call('netAccept', { fd: listenerFd });
    expect(acceptRes.errno).toBe(0);
    const acceptedFd = acceptRes.intResult;

    const clientRemoteRes = await call('kernelSocketGetRemoteAddr', { fd: clientFd });
    expect(clientRemoteRes.errno).toBe(0);
    expect(new TextDecoder().decode(clientRemoteRes.data)).toBe(listenerAddr);

    const acceptedLocalRes = await call('kernelSocketGetLocalAddr', { fd: acceptedFd });
    expect(acceptedLocalRes.errno).toBe(0);
    expect(new TextDecoder().decode(acceptedLocalRes.data)).toBe(listenerAddr);
  });

  it('netClose cleans up socket', async () => {
    const socketRes = await call('netSocket', { domain: 2, type: 1, protocol: 0 });
    const fd = socketRes.intResult;
    await call('netConnect', { fd, addr: `127.0.0.1:${echoPort}` });

    const closeRes = await call('netClose', { fd });
    expect(closeRes.errno).toBe(0);

    // Subsequent operations on closed socket return EBADF
    const sendRes = await call('netSend', { fd, data: [1, 2, 3], flags: 0 });
    expect(sendRes.errno).toBe(ERRNO_MAP.EBADF);

    const recvRes = await call('netRecv', { fd, length: 1024, flags: 0 });
    expect(recvRes.errno).toBe(ERRNO_MAP.EBADF);
  });

  it('netClose with invalid fd returns EBADF', async () => {
    const res = await call('netClose', { fd: 9999 });
    expect(res.errno).toBe(ERRNO_MAP.EBADF);
  });

  it('netSend on invalid fd returns EBADF', async () => {
    const res = await call('netSend', { fd: 9999, data: [1], flags: 0 });
    expect(res.errno).toBe(ERRNO_MAP.EBADF);
  });

  it('netRecv on invalid fd returns EBADF', async () => {
    const res = await call('netRecv', { fd: 9999, length: 1024, flags: 0 });
    expect(res.errno).toBe(ERRNO_MAP.EBADF);
  });

  it('full lifecycle: socket → connect → send → recv → close', async () => {
    const socketRes = await call('netSocket', { domain: 2, type: 1, protocol: 0 });
    expect(socketRes.errno).toBe(0);
    const fd = socketRes.intResult;

    const connectRes = await call('netConnect', { fd, addr: `127.0.0.1:${echoPort}` });
    expect(connectRes.errno).toBe(0);

    const payload = 'ping';
    const sendRes = await call('netSend', {
      fd,
      data: Array.from(new TextEncoder().encode(payload)),
      flags: 0,
    });
    expect(sendRes.errno).toBe(0);

    const recvRes = await call('netRecv', { fd, length: 256, flags: 0 });
    expect(recvRes.errno).toBe(0);
    expect(new TextDecoder().decode(recvRes.data)).toBe(payload);

    const closeRes = await call('netClose', { fd });
    expect(closeRes.errno).toBe(0);
  });

  it('multiple concurrent sockets work independently', async () => {
    const s1 = await call('netSocket', { domain: 2, type: 1, protocol: 0 });
    const s2 = await call('netSocket', { domain: 2, type: 1, protocol: 0 });
    expect(s1.intResult).not.toBe(s2.intResult);

    await call('netConnect', { fd: s1.intResult, addr: `127.0.0.1:${echoPort}` });
    await call('netConnect', { fd: s2.intResult, addr: `127.0.0.1:${echoPort}` });

    await call('netSend', {
      fd: s1.intResult,
      data: Array.from(new TextEncoder().encode('A')),
      flags: 0,
    });
    await call('netSend', {
      fd: s2.intResult,
      data: Array.from(new TextEncoder().encode('B')),
      flags: 0,
    });

    const r1 = await call('netRecv', { fd: s1.intResult, length: 256, flags: 0 });
    const r2 = await call('netRecv', { fd: s2.intResult, length: 256, flags: 0 });
    expect(new TextDecoder().decode(r1.data)).toBe('A');
    expect(new TextDecoder().decode(r2.data)).toBe('B');

    await call('netClose', { fd: s1.intResult });
    await call('netClose', { fd: s2.intResult });
  });

  it('dispose cleans up all open sockets', async () => {
    const s1 = await call('netSocket', { domain: 2, type: 1, protocol: 0 });
    await call('netConnect', { fd: s1.intResult, addr: `127.0.0.1:${echoPort}` });

    // Dispose should clean up sockets without errors
    kernel.socketTable.disposeAll();
    await driver.dispose();

    // Create fresh instances for afterEach cleanup
    driver = createWasmVmRuntime({ commandDirs: [] });
    kernel = createMockKernel();
  });
});

// -------------------------------------------------------------------------
// Self-signed TLS certificate helpers
// -------------------------------------------------------------------------

function generateSelfSignedCert(): { key: string; cert: string } {
  // Generate key and self-signed cert via openssl CLI with temp file
  const keyPath = join(tmpdir(), `test-key-${process.pid}-${Date.now()}.pem`);
  try {
    const key = execSync(
      'openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null',
    ).toString();
    writeFileSync(keyPath, key);
    const cert = execSync(
      `openssl req -new -x509 -key "${keyPath}" -days 1 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null`,
    ).toString();
    return { key, cert };
  } finally {
    try { unlinkSync(keyPath); } catch { /* best effort */ }
  }
}

function createTlsEchoServer(
  opts: { key: string; cert: string },
): Promise<{ server: TlsServer; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createTlsServer(
      { key: opts.key, cert: opts.cert },
      (conn) => {
        conn.on('data', (chunk) => conn.write(chunk)); // Echo back
        conn.on('error', () => {}); // Ignore client errors
      },
    );
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind'));
        return;
      }
      resolve({ server, port: addr.port });
    });
    server.on('error', reject);
  });
}

// -------------------------------------------------------------------------
// TLS socket tests
// -------------------------------------------------------------------------

describe('TLS socket RPC handlers', () => {
  let tlsCert: { key: string; cert: string };
  let tlsServer: TlsServer;
  let tlsPort: number;
  let driver: ReturnType<typeof createWasmVmRuntime>;
  let kernel: ReturnType<typeof createMockKernel>;

  beforeEach(async () => {
    tlsCert = generateSelfSignedCert();
    const srv = await createTlsEchoServer(tlsCert);
    tlsServer = srv.server;
    tlsPort = srv.port;

    driver = createWasmVmRuntime({ commandDirs: [] });
    kernel = createMockKernel();
  });

  afterEach(async () => {
    kernel.socketTable.disposeAll();
    await driver.dispose();
    await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
  });

  const call = (name: string, args: Record<string, unknown>) =>
    callSyscall(driver, name, args, kernel);

  it('TLS connect and echo round-trip', async () => {
    const socketRes = await call('netSocket', { domain: 2, type: 1, protocol: 0 });
    expect(socketRes.errno).toBe(0);
    const fd = socketRes.intResult;

    const connectRes = await call('netConnect', {
      fd,
      addr: `127.0.0.1:${tlsPort}`,
    });
    expect(connectRes.errno).toBe(0);

    const origReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const tlsRes = await call('netTlsConnect', {
        fd,
        hostname: 'localhost',
      });
      expect(tlsRes.errno).toBe(0);

      const message = 'hello TLS';
      const sendData = Array.from(new TextEncoder().encode(message));
      const sendRes = await call('netSend', { fd, data: sendData, flags: 0 });
      expect(sendRes.errno).toBe(0);
      expect(sendRes.intResult).toBe(sendData.length);

      const recvRes = await call('netRecv', { fd, length: 1024, flags: 0 });
      expect(recvRes.errno).toBe(0);
      expect(new TextDecoder().decode(recvRes.data)).toBe(message);
    } finally {
      if (origReject === undefined) {
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      } else {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = origReject;
      }
    }

    const closeRes = await call('netClose', { fd });
    expect(closeRes.errno).toBe(0);
  });

  it('TLS connect with invalid certificate fails', async () => {
    const socketRes = await call('netSocket', { domain: 2, type: 1, protocol: 0 });
    const fd = socketRes.intResult;
    await call('netConnect', { fd, addr: `127.0.0.1:${tlsPort}` });

    const origReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    try {
      const tlsRes = await call('netTlsConnect', {
        fd,
        hostname: 'localhost',
      });
      expect(tlsRes.errno).toBe(ERRNO_MAP.ECONNREFUSED);
    } finally {
      if (origReject !== undefined) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = origReject;
      }
    }
  });

  it('TLS connect on invalid fd returns EBADF', async () => {
    const res = await call('netTlsConnect', {
      fd: 9999,
      hostname: 'localhost',
    });
    expect(res.errno).toBe(ERRNO_MAP.EBADF);
  });

  it('full TLS lifecycle: socket → connect → tls → send → recv → close', async () => {
    const origReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const socketRes = await call('netSocket', { domain: 2, type: 1, protocol: 0 });
      expect(socketRes.errno).toBe(0);
      const fd = socketRes.intResult;

      await call('netConnect', { fd, addr: `127.0.0.1:${tlsPort}` });

      const tlsRes = await call('netTlsConnect', { fd, hostname: 'localhost' });
      expect(tlsRes.errno).toBe(0);

      for (const msg of ['round1', 'round2', 'round3']) {
        const sendRes = await call('netSend', {
          fd,
          data: Array.from(new TextEncoder().encode(msg)),
          flags: 0,
        });
        expect(sendRes.errno).toBe(0);

        const recvRes = await call('netRecv', { fd, length: 1024, flags: 0 });
        expect(recvRes.errno).toBe(0);
        expect(new TextDecoder().decode(recvRes.data)).toBe(msg);
      }

      const closeRes = await call('netClose', { fd });
      expect(closeRes.errno).toBe(0);
    } finally {
      if (origReject === undefined) {
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      } else {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = origReject;
      }
    }
  });
});

// -------------------------------------------------------------------------
// DNS resolution tests
// -------------------------------------------------------------------------

describe('DNS resolution (netGetaddrinfo) RPC handlers', () => {
  let driver: ReturnType<typeof createWasmVmRuntime>;

  beforeEach(() => {
    driver = createWasmVmRuntime({ commandDirs: [] });
  });

  afterEach(async () => {
    await driver.dispose();
  });

  it('resolve localhost returns 127.0.0.1', async () => {
    const res = await callSyscall(driver, 'netGetaddrinfo', {
      host: 'localhost',
      port: '80',
    });
    expect(res.errno).toBe(0);
    expect(res.data.length).toBeGreaterThan(0);

    const addresses = JSON.parse(new TextDecoder().decode(res.data));
    expect(Array.isArray(addresses)).toBe(true);
    expect(addresses.length).toBeGreaterThan(0);

    // At least one address should be IPv4 127.0.0.1
    const ipv4 = addresses.find((a: { addr: string; family: number }) => a.family === 4);
    expect(ipv4).toBeDefined();
    expect(ipv4.addr).toBe('127.0.0.1');
  });

  it('resolve invalid hostname returns appropriate error', async () => {
    const res = await callSyscall(driver, 'netGetaddrinfo', {
      host: 'this-hostname-does-not-exist-at-all.invalid',
      port: '80',
    });
    // ENOTFOUND maps to ENOENT
    expect(res.errno).not.toBe(0);
  });

  it('resolve returns both IPv4 and IPv6 when available', async () => {
    const res = await callSyscall(driver, 'netGetaddrinfo', {
      host: 'localhost',
      port: '0',
    });
    expect(res.errno).toBe(0);

    const addresses = JSON.parse(new TextDecoder().decode(res.data));
    expect(Array.isArray(addresses)).toBe(true);
    // Each address has addr and family fields
    for (const entry of addresses) {
      expect(entry).toHaveProperty('addr');
      expect(entry).toHaveProperty('family');
      expect([4, 6]).toContain(entry.family);
    }
  });

  it('intResult reflects the byte length of the response', async () => {
    const res = await callSyscall(driver, 'netGetaddrinfo', {
      host: 'localhost',
      port: '80',
    });
    expect(res.errno).toBe(0);
    expect(res.intResult).toBe(res.data.length);
  });

  it('resolve with empty port string succeeds', async () => {
    const res = await callSyscall(driver, 'netGetaddrinfo', {
      host: 'localhost',
      port: '',
    });
    expect(res.errno).toBe(0);
    const addresses = JSON.parse(new TextDecoder().decode(res.data));
    expect(addresses.length).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------------
// Socket poll (netPoll) tests
// -------------------------------------------------------------------------

describe('Socket poll (netPoll) RPC handlers', () => {
  let echoServer: Server;
  let echoPort: number;
  let driver: ReturnType<typeof createWasmVmRuntime>;
  let kernel: ReturnType<typeof createMockKernel>;

  beforeEach(async () => {
    const echo = await createEchoServer();
    echoServer = echo.server;
    echoPort = echo.port;

    driver = createWasmVmRuntime({ commandDirs: [] });
    kernel = createMockKernel();
  });

  afterEach(async () => {
    kernel.socketTable.disposeAll();
    await driver.dispose();
    await new Promise<void>((resolve) => echoServer.close(() => resolve()));
  });

  const call = (name: string, args: Record<string, unknown>) =>
    callSyscall(driver, name, args, kernel);

  it('poll on socket with data ready returns POLLIN', async () => {
    const socketRes = await call('netSocket', { domain: 2, type: 1, protocol: 0 });
    const fd = socketRes.intResult;
    await call('netConnect', { fd, addr: `127.0.0.1:${echoPort}` });

    const message = 'poll-test';
    await call('netSend', {
      fd,
      data: Array.from(new TextEncoder().encode(message)),
      flags: 0,
    });

    // Wait briefly for echo to arrive in kernel readBuffer
    await new Promise((r) => setTimeout(r, 50));

    const pollRes = await call('netPoll', {
      fds: [{ fd, events: 0x1 }],
      timeout: 1000,
    });
    expect(pollRes.errno).toBe(0);
    expect(pollRes.intResult).toBe(1);

    const revents = JSON.parse(new TextDecoder().decode(pollRes.data));
    expect(revents[0] & 0x1).toBe(0x1); // POLLIN set

    await call('netRecv', { fd, length: 1024, flags: 0 });
    await call('netClose', { fd });
  });

  it('poll with timeout on idle socket times out correctly', async () => {
    const socketRes = await call('netSocket', { domain: 2, type: 1, protocol: 0 });
    const fd = socketRes.intResult;
    await call('netConnect', { fd, addr: `127.0.0.1:${echoPort}` });

    const start = Date.now();
    const pollRes = await call('netPoll', {
      fds: [{ fd, events: 0x1 }],
      timeout: 50,
    });
    const elapsed = Date.now() - start;

    expect(pollRes.errno).toBe(0);
    expect(pollRes.intResult).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(30);

    await call('netClose', { fd });
  });

  it('poll with timeout=0 returns immediately (non-blocking)', async () => {
    const socketRes = await call('netSocket', { domain: 2, type: 1, protocol: 0 });
    const fd = socketRes.intResult;
    await call('netConnect', { fd, addr: `127.0.0.1:${echoPort}` });

    const start = Date.now();
    const pollRes = await call('netPoll', {
      fds: [{ fd, events: 0x1 }],
      timeout: 0,
    });
    const elapsed = Date.now() - start;

    expect(pollRes.errno).toBe(0);
    expect(elapsed).toBeLessThan(50);

    await call('netClose', { fd });
  });

  it('poll with timeout=-1 on a pipe waits until a writer makes it readable', async () => {
    const { readFd, writeFd } = kernel.createPipe();
    let settled = false;

    const pollPromise = call('netPoll', {
      fds: [{ fd: readFd, events: 0x1 }],
      timeout: -1,
    }).then((result) => {
      settled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);

    setTimeout(() => {
      void kernel.fdWrite(2, writeFd, new TextEncoder().encode('pipe-ready'));
    }, 10);

    const pollRes = await pollPromise;
    expect(pollRes.errno).toBe(0);
    expect(pollRes.intResult).toBe(1);

    const revents = JSON.parse(new TextDecoder().decode(pollRes.data));
    expect(revents[0] & 0x1).toBe(0x1); // POLLIN set
  });

  it('poll on invalid fd returns POLLNVAL', async () => {
    const pollRes = await call('netPoll', {
      fds: [{ fd: 9999, events: 0x1 }],
      timeout: 0,
    });
    expect(pollRes.errno).toBe(0);
    expect(pollRes.intResult).toBe(1);

    const revents = JSON.parse(new TextDecoder().decode(pollRes.data));
    expect(revents[0] & 0x4000).toBe(0x4000); // POLLNVAL
  });

  it('poll POLLOUT on connected writable socket', async () => {
    const socketRes = await call('netSocket', { domain: 2, type: 1, protocol: 0 });
    const fd = socketRes.intResult;
    await call('netConnect', { fd, addr: `127.0.0.1:${echoPort}` });

    const pollRes = await call('netPoll', {
      fds: [{ fd, events: 0x2 }],
      timeout: 0,
    });
    expect(pollRes.errno).toBe(0);
    expect(pollRes.intResult).toBe(1);

    const revents = JSON.parse(new TextDecoder().decode(pollRes.data));
    expect(revents[0] & 0x2).toBe(0x2); // POLLOUT set

    await call('netClose', { fd });
  });

  it('poll with multiple FDs returns correct per-FD revents', async () => {
    const s1 = await call('netSocket', { domain: 2, type: 1, protocol: 0 });
    const s2 = await call('netSocket', { domain: 2, type: 1, protocol: 0 });
    const fd1 = s1.intResult;
    const fd2 = s2.intResult;

    await call('netConnect', { fd: fd1, addr: `127.0.0.1:${echoPort}` });
    await call('netConnect', { fd: fd2, addr: `127.0.0.1:${echoPort}` });

    await call('netSend', {
      fd: fd1,
      data: Array.from(new TextEncoder().encode('data-for-fd1')),
      flags: 0,
    });
    await new Promise((r) => setTimeout(r, 50));

    const pollRes = await call('netPoll', {
      fds: [
        { fd: fd1, events: 0x1 },
        { fd: fd2, events: 0x1 },
      ],
      timeout: 0,
    });
    expect(pollRes.errno).toBe(0);

    const revents = JSON.parse(new TextDecoder().decode(pollRes.data));
    expect(revents[0] & 0x1).toBe(0x1);
    expect(revents[1] & 0x1).toBe(0x0);

    await call('netRecv', { fd: fd1, length: 1024, flags: 0 });
    await call('netClose', { fd: fd1 });
    await call('netClose', { fd: fd2 });
  });
});

describe('TCP socket permission enforcement', () => {
  it('permission-restricted command cannot create sockets (kernel-worker level)', async () => {
    // This tests the isNetworkBlocked check in kernel-worker.ts.
    // At the driver level, the permission check happens in the worker,
    // not in _handleSyscall. So we verify the permission function directly.
    const { isNetworkBlocked } = await import('../src/permission-check.ts');

    expect(isNetworkBlocked('read-only')).toBe(true);
    expect(isNetworkBlocked('read-write')).toBe(true);
    expect(isNetworkBlocked('isolated')).toBe(true);
    expect(isNetworkBlocked('full')).toBe(false);
  });
});
