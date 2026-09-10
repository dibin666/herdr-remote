import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HerdrClientAdapter } from '../protocol/clientAdapter';
import { ConnectionConfig } from '../types/protocol';

class MockWebSocket {
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;

  public static instances: MockWebSocket[] = [];
  public url: string;
  public readyState: number = MockWebSocket.CONNECTING;
  public binaryType: string = 'blob';
  public bufferedAmount: number = 0;
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
}

describe('HerdrClientAdapter Input Coalescing', () => {
  let originalWebSocket: typeof WebSocket;
  const baseConfig: ConnectionConfig = {
    wsUrl: 'ws://127.0.0.1:8787/ws/client',
    clientId: 'test-client',
    autoReconnect: false,
    reconnectIntervalMs: 1000,
    maxReconnectAttempts: 3,
    pingIntervalMs: 5000,
  };

  beforeEach(() => {
    MockWebSocket.instances = [];
    originalWebSocket = global.WebSocket;
    global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    global.WebSocket = originalWebSocket;
  });

  async function createConnectedAdapter(): Promise<{ adapter: HerdrClientAdapter; ws: MockWebSocket }> {
    const adapter = new HerdrClientAdapter(baseConfig);
    adapter.connect();
    // Allow constructor microtask to open the socket
    await Promise.resolve();
    const ws = MockWebSocket.instances[0];
    expect(ws.readyState).toBe(MockWebSocket.OPEN);
    // Discard initial hello frame
    ws.sentMessages = [];
    return { adapter, ws };
  }

  it('coalesces 20 synchronous wheel reports into a single ws.send frame with preserved sequence', async () => {
    const { adapter, ws } = await createConnectedAdapter();

    const segments: Uint8Array[] = [];
    let totalLength = 0;
    for (let i = 0; i < 20; i++) {
      const seg = new TextEncoder().encode(`\x1b[<64;${i + 1};20M`);
      segments.push(seg);
      totalLength += seg.length;
    }

    const expectedMerged = new Uint8Array(totalLength);
    let offset = 0;
    for (const seg of segments) {
      expectedMerged.set(seg, offset);
      offset += seg.length;
    }

    // Synchronously send 20 wheel segments
    for (const seg of segments) {
      adapter.sendInput(seg);
    }

    // Before microtask runs, nothing has been sent
    expect(ws.sentMessages.length).toBe(0);

    // Drain microtasks
    await Promise.resolve();

    // Exactly one merged frame was sent with all 20 segments concatenated
    expect(ws.sentMessages.length).toBe(1);
    expect(Array.from(ws.sentMessages[0] as Uint8Array)).toEqual(Array.from(expectedMerged));
  });

  it('flushes queued input before sendJson so control messages do not interleave ahead of input', async () => {
    const { adapter, ws } = await createConnectedAdapter();

    const inputData = new TextEncoder().encode('test-command\r');
    adapter.sendInput(inputData);

    // Microtask has not run yet, but calling sendJson synchronously flushes input first
    adapter.sendJson({ type: 'ping' });

    expect(ws.sentMessages.length).toBe(2);
    expect(Array.from(ws.sentMessages[0] as Uint8Array)).toEqual(Array.from(inputData));
    expect(JSON.parse(ws.sentMessages[1] as string)).toEqual({ type: 'ping' });

    // The subsequent microtask sees an empty pending queue and emits nothing additional
    await Promise.resolve();
    expect(ws.sentMessages.length).toBe(2);
  });

  it('drops wheel reports under backpressure while strictly preserving keyboard input', async () => {
    const { adapter, ws } = await createConnectedAdapter();

    // Set socket buffer beyond 256KB threshold
    ws.bufferedAmount = 300 * 1024;

    const wheel1 = new TextEncoder().encode('\x1b[<64;10;20M');
    const key1 = new TextEncoder().encode('echo preserved\r');
    const wheel2 = new TextEncoder().encode('\x1b[<65;10;20M');

    adapter.sendInput(wheel1);
    adapter.sendInput(key1);
    adapter.sendInput(wheel2);

    await Promise.resolve();

    // Only key1 should be sent; wheel1 and wheel2 are dropped due to backpressure
    expect(ws.sentMessages.length).toBe(1);
    expect(Array.from(ws.sentMessages[0] as Uint8Array)).toEqual(Array.from(key1));

    // If only wheel reports are submitted under backpressure, nothing is sent
    ws.sentMessages = [];
    adapter.sendInput(wheel1);
    adapter.sendInput(wheel2);
    await Promise.resolve();
    expect(ws.sentMessages.length).toBe(0);
  });
});
