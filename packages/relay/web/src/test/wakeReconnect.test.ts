import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HerdrClientAdapter } from '@/connection/clientAdapter';
import { installWakeListeners } from '@/connection/wakeListeners';
import type { ConnectionConfig } from '@/connection/types';

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  binaryType = 'blob';
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }

  /** The network or the relay ends the connection. */
  serverClose(code = 1006) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code }));
  }

  serverJson(msg: Record<string, unknown>) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(msg) }));
  }

  pings() {
    return this.sent.filter((data) => JSON.parse(data).type === 'ping').length;
  }
}

const config: ConnectionConfig = {
  wsUrl: 'ws://127.0.0.1:8787/ws/client',
  token: 'token',
  clientId: 'client-1',
  autoReconnect: true,
  reconnectIntervalMs: 2000,
  maxReconnectAttempts: 0,
  pingIntervalMs: 5000,
};

const latest = () => MockWebSocket.instances[MockWebSocket.instances.length - 1];

function connected(overrides: Partial<ConnectionConfig> = {}) {
  const adapter = new HerdrClientAdapter({ ...config, ...overrides });
  adapter.connect();
  latest().open();
  latest().serverJson({
    type: 'ready',
    role: 'controller',
    controllerId: 'client-1',
    hostId: 'h',
    clientId: 'client-1',
  });
  return adapter;
}

describe('HerdrClientAdapter.wake', () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T10:00:00Z'));
    MockWebSocket.instances = [];
    originalWebSocket = global.WebSocket;
    global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    global.WebSocket = originalWebSocket;
  });

  it('connects at once instead of sitting out the backoff', () => {
    const adapter = connected();
    latest().serverClose();
    expect(adapter.getState()).toBe('reconnecting');
    expect(MockWebSocket.instances).toHaveLength(1);

    adapter.wake('visible');
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(adapter.getState()).toBe('connecting');

    // The abandoned backoff timer does not open a third socket later.
    vi.advanceTimersByTime(60000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('does nothing after the user disconnected, after an auth failure, or with reconnects off', () => {
    const manual = connected();
    manual.disconnect();
    manual.wake('visible');

    const noAuto = connected({ autoReconnect: false });
    latest().serverClose();
    noAuto.wake('visible');

    const denied = connected();
    latest().serverJson({ type: 'error', code: 'unauthorized', message: 'no' });
    latest().serverClose(1008);
    denied.wake('visible');

    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it('leaves a socket that has heard from the relay recently alone', () => {
    const adapter = connected();
    vi.setSystemTime(Date.now() + 4000);
    adapter.wake('visible');
    expect(latest().pings()).toBe(0);
  });

  it('keeps a quiet socket that answers the probe', () => {
    const adapter = connected();
    const socket = latest();
    vi.setSystemTime(Date.now() + 60000);
    adapter.wake('visible');
    expect(socket.pings()).toBe(1);
    socket.serverJson({ type: 'pong' });
    vi.advanceTimersByTime(3000);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(adapter.getState()).toBe('connected');
  });

  it('replaces a quiet socket that does not answer, straight away', () => {
    const adapter = connected();
    const states: Array<[string, string | undefined]> = [];
    adapter.on('stateChange', (state, _detail, code) => states.push([state, code]));
    vi.setSystemTime(Date.now() + 60000);
    adapter.wake('visible');
    vi.advanceTimersByTime(2999);
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(states).toContainEqual(['reconnecting', 'connection_stale']);
  });

  it('rebuilds a connection attempt that has hung', () => {
    const adapter = connected();
    latest().serverClose();
    adapter.wake('visible');
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.setSystemTime(Date.now() + 11000);
    adapter.wake('focus');
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it('collapses a burst of wake events into one connection attempt', () => {
    const adapter = connected();
    latest().serverClose();
    adapter.wake('visible');
    latest().serverClose();
    adapter.wake('focus');
    adapter.wake('pageshow');
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('gives an unanswered heartbeat a probe before dropping the socket', () => {
    const adapter = connected();
    const socket = latest();
    vi.advanceTimersByTime(5000); // first heartbeat ping, never answered
    expect(socket.pings()).toBe(1);
    vi.advanceTimersByTime(5000); // silence for a whole interval: probe
    expect(socket.pings()).toBe(2);
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(3000);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(adapter.getState()).toBe('connecting');
  });
});

describe('installWakeListeners', () => {
  it('wakes the connection when the page returns, and stops when removed', () => {
    const wake = vi.fn();
    const remove = installWakeListeners({ wake });

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(wake).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('pageshow'));
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('resume'));
    expect(wake.mock.calls.map(([reason]) => reason)).toEqual([
      'visible',
      'online',
      'pageshow',
      'focus',
      'resume',
    ]);

    remove();
    window.dispatchEvent(new Event('online'));
    expect(wake).toHaveBeenCalledTimes(5);
  });

  it('does not try while the browser says it is offline', () => {
    const wake = vi.fn();
    const onLine = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    const remove = installWakeListeners({ wake });
    window.dispatchEvent(new Event('focus'));
    expect(wake).not.toHaveBeenCalled();
    remove();
    onLine.mockRestore();
  });
});
