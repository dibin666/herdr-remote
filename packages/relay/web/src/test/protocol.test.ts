import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HerdrClientAdapter } from '../protocol/clientAdapter';
import { ConnectionConfig } from '../types/protocol';

// Mock WebSocket class
class MockWebSocket {
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;

  public static instances: MockWebSocket[] = [];
  public url: string;
  public readyState: number = MockWebSocket.CONNECTING;
  public binaryType: string = 'blob';
  public sentMessages: (string | Uint8Array | ArrayBuffer)[] = [];

  public onopen: ((ev: Event) => void) | null = null;
  public onmessage: ((ev: MessageEvent) => void) | null = null;
  public onerror: ((ev: Event) => void) | null = null;
  public onclose: ((ev: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      if (this.onopen) this.onopen(new Event('open'));
    });
  }

  send(data: string | Uint8Array | ArrayBuffer) {
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(new CloseEvent('close', { code: code || 1000, reason: reason || '' }));
    }
  }

  // Helper to simulate server sending a JSON message
  simulateServerJson(msg: Record<string, unknown>) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data: JSON.stringify(msg) }));
    }
  }

  // Helper to simulate server sending raw binary ANSI data
  simulateServerBinary(data: Uint8Array) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data: data.buffer }));
    }
  }
}

describe('HerdrClientAdapter Protocol', () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    MockWebSocket.instances = [];
    originalWebSocket = global.WebSocket;
    global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    global.WebSocket = originalWebSocket;
  });

  const baseConfig: ConnectionConfig = {
    wsUrl: 'ws://127.0.0.1:8787/ws/client',
    token: 'test-token',
    pairCode: 'TEST12',
    clientId: 'client-unit-1',
    autoReconnect: false,
    reconnectIntervalMs: 1000,
    maxReconnectAttempts: 3,
    pingIntervalMs: 5000,
  };

  it('connects and sends hello handshake with dimensions and pairCode', async () => {
    const adapter = new HerdrClientAdapter(baseConfig);
    adapter.connect({ cols: 100, rows: 40 });

    expect(adapter.getState()).toBe('connecting');

    // Wait for connection mock to open
    await new Promise((r) => setTimeout(r, 20));

    const wsInstance = MockWebSocket.instances[0];
    expect(wsInstance).toBeDefined();
    expect(wsInstance.sentMessages.length).toBeGreaterThan(0);

    const helloMsg = JSON.parse(wsInstance.sentMessages[0] as string);
    expect(helloMsg).toEqual({
      type: 'hello',
      protocol: 1,
      clientId: 'client-unit-1',
      token: 'test-token',
      pairCode: 'TEST12',
      cols: 100,
      rows: 40,
      capabilities: ['host_handoff'],
    });
  });

  it('keeps legacy HTTP relay URLs usable by upgrading them to WebSocket URLs', async () => {
    const adapter = new HerdrClientAdapter({ ...baseConfig, wsUrl: 'https://relay.example.com' });
    adapter.connect();
    await new Promise((r) => setTimeout(r, 20));
    expect(MockWebSocket.instances[0].url).toBe('wss://relay.example.com/ws/client');
  });

  it('handles ready message and stores server-assigned clientId and role', async () => {
    const adapter = new HerdrClientAdapter(baseConfig);
    const readyListener = vi.fn();
    const roleListener = vi.fn();

    adapter.on('ready', readyListener);
    adapter.on('roleChange', roleListener);

    adapter.connect();
    await new Promise((r) => setTimeout(r, 20));

    const ws = MockWebSocket.instances[0];
    ws.simulateServerJson({
      type: 'ready',
      role: 'controller',
      controllerId: 'server-client-88',
      hostId: 'host-alpha',
      clientId: 'server-client-88',
    });

    expect(adapter.getState()).toBe('connected');
    expect(adapter.getRole()).toBe('controller');
    expect(adapter.getControllerId()).toBe('server-client-88');
    expect(adapter.getHostId()).toBe('host-alpha');
    expect(adapter.getAssignedClientId()).toBe('server-client-88');
    expect(readyListener).toHaveBeenCalledTimes(1);
    expect(roleListener).toHaveBeenCalledWith('controller', 'server-client-88', 'host-alpha', 'server-client-88');
  });

  it('handles paired message and emits paired event', async () => {
    const adapter = new HerdrClientAdapter(baseConfig);
    const pairedListener = vi.fn();
    adapter.on('paired', pairedListener);

    adapter.connect();
    await new Promise((r) => setTimeout(r, 20));

    const ws = MockWebSocket.instances[0];
    ws.simulateServerJson({
      type: 'paired',
      token: 'sec-tok-999',
      deviceId: 'dev-alpha',
      hostId: 'host-main',
      expiresAt: 1725235200,
    });

    expect(pairedListener).toHaveBeenCalledWith({
      token: 'sec-tok-999',
      deviceId: 'dev-alpha',
      hostId: 'host-main',
      expiresAt: 1725235200,
    });
  });

  it('handles control_state message and updates role/controller', async () => {
    const adapter = new HerdrClientAdapter(baseConfig);
    const controlStateListener = vi.fn();
    const roleListener = vi.fn();

    adapter.on('controlState', controlStateListener);
    adapter.on('roleChange', roleListener);

    adapter.connect();
    await new Promise((r) => setTimeout(r, 20));

    const ws = MockWebSocket.instances[0];
    ws.simulateServerJson({
      type: 'control_state',
      role: 'controller',
      controllerId: 'client-unit-1',
    });

    expect(adapter.getRole()).toBe('controller');
    expect(adapter.getControllerId()).toBe('client-unit-1');
    expect(controlStateListener).toHaveBeenCalledWith('controller', 'client-unit-1');
    expect(roleListener).toHaveBeenCalledWith('controller', 'client-unit-1', undefined, undefined);
  });

  it('handles control_revoked message and reverts role to viewer', async () => {
    const adapter = new HerdrClientAdapter(baseConfig);
    const revokedListener = vi.fn();
    adapter.on('controlRevoked', revokedListener);

    adapter.connect();
    await new Promise((r) => setTimeout(r, 20));

    const ws = MockWebSocket.instances[0];
    // First make it controller
    ws.simulateServerJson({ type: 'control_granted' });
    expect(adapter.getRole()).toBe('controller');

    // Revoke control
    ws.simulateServerJson({
      type: 'control_revoked',
      reason: 'Takeover by admin',
    });

    expect(adapter.getRole()).toBe('viewer');
    expect(revokedListener).toHaveBeenCalledWith('Takeover by admin');
  });

  it('sends claim_control with force: true for explicit takeover', async () => {
    const adapter = new HerdrClientAdapter(baseConfig);
    adapter.connect();
    await new Promise((r) => setTimeout(r, 20));

    const ws = MockWebSocket.instances[0];

    // Standard claim control
    adapter.claimControl(false);
    let lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1] as string);
    expect(lastMsg).toEqual({ type: 'claim_control' });

    // Force takeover claim control
    adapter.claimControl(true);
    lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1] as string);
    expect(lastMsg).toEqual({ type: 'claim_control', force: true });
  });

  it('handles session_ready and exit messages', async () => {
    const adapter = new HerdrClientAdapter(baseConfig);
    const sessionListener = vi.fn();
    const exitListener = vi.fn();

    adapter.on('sessionReady', sessionListener);
    adapter.on('exit', exitListener);

    adapter.connect();
    await new Promise((r) => setTimeout(r, 20));

    const ws = MockWebSocket.instances[0];
    // Fields this client does not know about ride along untouched, so a newer
    // host can add one without the adapter having to be taught it first.
    ws.simulateServerJson({
      type: 'session_ready',
      sessionId: 'sess-101',
      somethingNewer: true,
    });
    expect(sessionListener).toHaveBeenCalledWith({
      type: 'session_ready',
      sessionId: 'sess-101',
      somethingNewer: true,
    });

    ws.simulateServerJson({
      type: 'exit',
      code: 0,
      reason: 'Normal exit',
    });
    expect(exitListener).toHaveBeenCalledWith(0, 'Normal exit');
  });

  it('receives binary frames and dispatches to binaryData listener', async () => {
    const adapter = new HerdrClientAdapter(baseConfig);
    const binaryListener = vi.fn();
    adapter.on('binaryData', binaryListener);

    adapter.connect();
    await new Promise((r) => setTimeout(r, 20));

    const ws = MockWebSocket.instances[0];
    const testData = new Uint8Array([27, 91, 51, 49, 109, 72, 105]); // \x1b[31mHi
    ws.simulateServerBinary(testData);

    expect(binaryListener).toHaveBeenCalledTimes(1);
    const received = binaryListener.mock.calls[0][0] as Uint8Array;
    expect(Array.from(received)).toEqual(Array.from(testData));
  });

  it('sends binary data directly over WebSocket', async () => {
    const adapter = new HerdrClientAdapter(baseConfig);
    adapter.connect();
    await new Promise((r) => setTimeout(r, 20));

    const ws = MockWebSocket.instances[0];
    const inputBytes = new Uint8Array([108, 115, 10]); // ls\n
    adapter.sendBinary(inputBytes);

    expect(ws.sentMessages.length).toBeGreaterThan(1);
    const last = ws.sentMessages[ws.sentMessages.length - 1];
    expect(last).toEqual(inputBytes);
  });

  it('sends resize message', async () => {
    const adapter = new HerdrClientAdapter(baseConfig);
    adapter.connect();
    await new Promise((r) => setTimeout(r, 20));

    adapter.sendResize(120, 35);
    const ws = MockWebSocket.instances[0];
    const resizeMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1] as string);
    expect(resizeMsg).toEqual({
      type: 'resize',
      cols: 120,
      rows: 35,
    });
  });

  it('handles server errors and reports to listener', async () => {
    const adapter = new HerdrClientAdapter(baseConfig);
    const errorListener = vi.fn();
    adapter.on('error', errorListener);

    adapter.connect();
    await new Promise((r) => setTimeout(r, 20));

    const ws = MockWebSocket.instances[0];
    ws.simulateServerJson({
      type: 'error',
      code: 'AUTH_FAILED',
      message: 'Invalid pairing token',
    });

    expect(errorListener).toHaveBeenCalledWith({
      code: 'AUTH_FAILED',
      message: 'Invalid pairing token',
    });
  });

  it('stops reconnecting on auth_required so the pairing UI can take over', async () => {
    const adapter = new HerdrClientAdapter(baseConfig);
    adapter.connect();
    await new Promise((r) => setTimeout(r, 20));

    const ws = MockWebSocket.instances[0];
    ws.simulateServerJson({
      type: 'error',
      code: 'auth_required',
      message: 'Enter a one-time pairing code',
    });
    ws.close(1008, 'auth_required');

    expect(adapter.getState()).toBe('error');
  });
});
