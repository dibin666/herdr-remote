// The socket under a client adapter: connecting, noticing a dead link,
// reconnecting with backoff, and batching keystrokes into as few frames as
// possible. What the messages mean is the subclass's business.

import type { ClientJsonMessage, ClientPingMessage, ServerJsonMessage } from '@protocol/messages';
import { WS_CLIENT_PATH } from '@protocol/messages';
import type { ConnectionConfig, ConnectionState } from './types';
import { AdapterEvents } from './adapterEvents';
import { encodeStringToBytes } from '@/shared/keys/keyEncoder';
import { InputQueue } from './inputQueue';

/** How long a ping may go unanswered before the socket is written off. */
const PROBE_TIMEOUT_MS = 3000;
/** A connection attempt still pending after this long is stuck, not slow. */
const CONNECT_STALL_MS = 10000;
/** Wake events arrive in bursts (visibility, focus and pageshow together). */
const WAKE_MIN_INTERVAL_MS = 1500;

export abstract class RelaySocket extends AdapterEvents {
  private ws: WebSocket | null = null;
  protected config: ConnectionConfig;
  private state: ConnectionState = 'disconnected';
  protected reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimestamp: number | null = null;
  // Wall-clock times: performance.now() can stand still while a phone sleeps,
  // and sleep is exactly what these measure across.
  private lastInboundAt = 0;
  private pingSentAt: number | null = null;
  private connectStartedAt = 0;
  private lastWakeConnectAt = 0;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private rejectedByRelay = false;
  private isManuallyClosed = false;
  protected authFailureDetail: string | null = null;
  protected authFailureCode: string | null = null;
  protected temporaryFailureCode: string | null = null;
  private input = new InputQueue(() => this.ws);

  protected terminalCols = 80;
  protected terminalRows = 24;

  constructor(config: ConnectionConfig) {
    super();
    this.config = { ...config };
  }

  /** The first message on a fresh socket. */
  public abstract sendHello(): void;

  /** Every JSON message from the relay except `pong`, which is answered here. */
  protected abstract handleServerMessage(msg: ServerJsonMessage): void;

  public updateConfig(partialConfig: Partial<ConnectionConfig>): void {
    this.config = { ...this.config, ...partialConfig };
  }

  public getConfig(): ConnectionConfig {
    return { ...this.config };
  }

  public getState(): ConnectionState {
    return this.state;
  }

  protected setState(newState: ConnectionState, detail?: string, code?: string): void {
    if (this.state !== newState) {
      this.state = newState;
      this.emit('stateChange', newState, detail, code);
    }
  }

  public connect(dimensions?: { cols: number; rows: number }): void {
    if (dimensions) {
      this.terminalCols = dimensions.cols;
      this.terminalRows = dimensions.rows;
    }

    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    // A socket that is still CLOSING would otherwise keep its handlers alive and
    // report its close *after* the replacement is live. Detach it now.
    this.teardownSocket(1000, 'Replaced by a new connection');

    this.isManuallyClosed = false;
    this.authFailureDetail = null;
    this.authFailureCode = null;
    this.temporaryFailureCode = null;
    this.rejectedByRelay = false;
    this.clearTimers();
    this.setState('connecting');

    try {
      const url = resolveWsUrl(this.config.wsUrl);
      const socket = new WebSocket(url);
      this.ws = socket;
      this.connectStartedAt = Date.now();
      socket.binaryType = 'arraybuffer';

      // Every handler is bound to the socket that registered it. A socket the
      // adapter has already moved on from must never mutate adapter state: its
      // close arrives after the replacement is connected, and acting on it used
      // to drop `this.ws` and schedule a *second* live connection — the browser
      // ended up holding both a controller and a viewer session at once.
      socket.onopen = () => {
        if (this.isStaleSocket(socket)) return;
        this.handleOpen();
      };
      socket.onmessage = (event) => {
        if (this.isStaleSocket(socket)) return;
        void this.handleMessage(event);
      };
      socket.onerror = (event) => {
        if (this.isStaleSocket(socket)) return;
        this.handleError(event);
      };
      socket.onclose = (event) => {
        if (this.isStaleSocket(socket)) return;
        this.handleClose(event);
      };
    } catch (err) {
      this.setState(
        'error',
        err instanceof Error ? err.message : 'Connection failed',
        'connection_failed',
      );
      this.scheduleReconnect();
    }
  }

  /**
   * True when `socket` is no longer the adapter's live socket. Late events from
   * a superseded or manually closed socket land here and are dropped.
   */
  private isStaleSocket(socket: WebSocket): boolean {
    return this.ws !== socket;
  }

  /**
   * Drop the current socket without going through `handleClose`. Handlers are
   * cleared first so the pending close event cannot reach the adapter at all,
   * and `this.ws` is cleared before `close()` so any handler that did survive
   * would still see itself as stale.
   */
  private teardownSocket(code = 1000, reason = 'Client closed the connection'): void {
    this.input.clear();
    const socket = this.ws;
    if (!socket) return;
    this.ws = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(code, reason);
      }
    } catch {
      // A socket that refuses to close is already unusable; nothing to salvage.
    }
  }

  public disconnect(): void {
    this.isManuallyClosed = true;
    this.clearTimers();
    this.input.clear();
    this.teardownSocket(1000, 'User initiated disconnect');
    this.setState('disconnected');
  }

  /**
   * Swap credentials and rebuild the connection as one step.
   *
   * Pairing used to do this as `disconnect()` plus a delayed `connect()`, which
   * left a window where the old socket's close could race the new socket into
   * existence. Callers get an atomic replacement instead.
   */
  public reconnectWith(partialConfig: Partial<ConnectionConfig>): void {
    this.updateConfig(partialConfig);
    this.clearTimers();
    this.teardownSocket(1000, 'Reconnecting with new credentials');
    this.isManuallyClosed = false;
    this.reconnectAttempts = 0;
    this.authFailureDetail = null;
    this.authFailureCode = null;
    this.temporaryFailureCode = null;
    this.connect();
  }

  /**
   * The page has come back: visible again, restored from the back/forward
   * cache, or back online. A phone that slept may be sitting out a long
   * reconnect backoff, or holding a socket the OS killed without a close
   * event; either way the user is looking at a dead terminal. Recover now.
   *
   * A live-looking socket is not dropped on suspicion. It is probed first,
   * because a false drop is expensive: the relay starts a fresh Herdr client
   * for the new socket, and this window loses the workspace and tab it had.
   */
  public wake(_reason: string): void {
    if (
      this.isManuallyClosed ||
      !this.config.autoReconnect ||
      this.authFailureDetail ||
      this.rejectedByRelay
    ) {
      return;
    }
    const now = Date.now();
    const socket = this.ws;

    if (!socket) {
      if (now - this.lastWakeConnectAt < WAKE_MIN_INTERVAL_MS) return;
      this.lastWakeConnectAt = now;
      this.reconnectAttempts = 0;
      this.connect();
      return;
    }

    if (socket.readyState === WebSocket.CONNECTING) {
      if (now - this.connectStartedAt > CONNECT_STALL_MS)
        this.dropStaleSocket('connection_stalled');
      return;
    }

    if (
      socket.readyState === WebSocket.OPEN &&
      now - this.lastInboundAt > this.pingIntervalMs() + 2000
    ) {
      this.probeLiveness();
    }
  }

  private pingIntervalMs(): number {
    return this.config.pingIntervalMs || 10000;
  }

  /** Pings, and gives the socket up if nothing at all comes back in time. */
  private probeLiveness(): void {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.probeTimer) return;
    const sentAt = Date.now();
    this.sendPing();
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (this.ws !== socket) return;
      if (this.lastInboundAt < sentAt) this.dropStaleSocket('connection_stale');
    }, PROBE_TIMEOUT_MS);
  }

  private dropStaleSocket(code: string): void {
    this.clearTimers();
    this.teardownSocket(4000, 'Connection went silent');
    this.setState('reconnecting', 'The connection went silent. Reconnecting...', code);
    this.reconnectAttempts = 0;
    this.lastWakeConnectAt = Date.now();
    this.connect();
  }

  private handleOpen(): void {
    this.lastInboundAt = Date.now();
    this.sendHello();
    this.startHeartbeat();
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    this.lastInboundAt = Date.now();
    if (typeof event.data === 'string') {
      // JSON Control message
      try {
        const msg = JSON.parse(event.data) as ServerJsonMessage;
        if (msg.type === 'pong') this.handlePong();
        else this.handleServerMessage(msg);
      } catch (e) {
        console.warn('Received unparseable text frame from server:', e);
      }
    } else if (event.data instanceof ArrayBuffer) {
      // Binary frame (raw ANSI stream)
      this.emit('binaryData', new Uint8Array(event.data));
    } else if (typeof Blob !== 'undefined' && event.data instanceof Blob) {
      // Binary Blob fallback
      try {
        const buf = await event.data.arrayBuffer();
        this.emit('binaryData', new Uint8Array(buf));
      } catch (e) {
        console.error('Failed to convert Blob to ArrayBuffer:', e);
      }
    }
  }

  private handlePong(): void {
    if (this.pingTimestamp) {
      const rtt = Math.max(0, performance.now() - this.pingTimestamp);
      this.pingTimestamp = null;
      this.emit('rttUpdate', Math.round(rtt));
    }
  }

  private handleError(event: Event): void {
    console.error('WebSocket error:', event);
    this.emit('error', { code: 'WS_ERROR', message: 'WebSocket connection error' });
  }

  private handleClose(event: CloseEvent): void {
    this.clearTimers();
    this.ws = null;

    if (this.authFailureDetail) {
      this.setState('error', this.authFailureDetail, this.authFailureCode ?? undefined);
      return;
    }
    if (event.code === 1008 && this.temporaryFailureCode) {
      this.setState(
        'reconnecting',
        event.reason || 'The relay is temporarily unavailable',
        this.temporaryFailureCode,
      );
      this.scheduleReconnect();
      return;
    }
    if (event.code === 1008) {
      this.rejectedByRelay = true;
      this.setState(
        'error',
        event.reason || 'The relay rejected the connection',
        String(event.code),
      );
      return;
    }

    if (!this.isManuallyClosed && this.config.autoReconnect) {
      this.setState(
        'reconnecting',
        `Connection closed (${event.code}). Retrying...`,
        'connection_closed',
      );
      this.scheduleReconnect();
    } else {
      this.setState('disconnected', `Closed: ${event.reason || event.code}`, 'connection_closed');
    }
  }

  private scheduleReconnect(): void {
    if (this.isManuallyClosed || !this.config.autoReconnect) return;

    if (
      this.config.maxReconnectAttempts > 0 &&
      this.reconnectAttempts >= this.config.maxReconnectAttempts
    ) {
      this.setState('error', 'Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    // Exponential backoff with jitter
    const base = this.config.reconnectIntervalMs || 2000;
    const maxBackoff = 30000;
    const delay = Math.min(
      maxBackoff,
      Math.floor(base * 1.5 ** (this.reconnectAttempts - 1) + Math.random() * 500),
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    const interval = this.pingIntervalMs();
    this.pingSentAt = null;

    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      // A ping that met a whole interval of silence earns a probe, not a
      // drop: a background tab's timers fire late, and the answer may be in
      // flight.
      if (
        this.pingSentAt !== null &&
        this.lastInboundAt < this.pingSentAt &&
        Date.now() - this.pingSentAt >= interval
      ) {
        this.probeLiveness();
        return;
      }
      this.sendPing();
    }, interval);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
  }

  public sendPing(): void {
    this.pingTimestamp = performance.now();
    this.pingSentAt = Date.now();
    const msg: ClientPingMessage = {
      type: 'ping',
    };
    this.sendJson(msg);
  }

  public sendJson(msg: ClientJsonMessage): void {
    // Flush queued input before control messages so resize/control frames do
    // not interleave ahead of earlier keystrokes.
    this.flushInput();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  public sendInput(data: Uint8Array | ArrayBuffer): void {
    this.input.push(data);
  }

  public flushInput(): void {
    this.input.flush();
  }

  public sendBinary(data: Uint8Array | ArrayBuffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  public sendText(text: string): void {
    const bytes = encodeStringToBytes(text);
    this.sendInput(bytes);
  }
}

function resolveWsUrl(configuredUrl: string): string {
  if (/^wss?:\/\//i.test(configuredUrl)) {
    return configuredUrl;
  }
  if (/^https?:\/\//i.test(configuredUrl)) {
    // Older settings accepted an HTTP origin in the WebSocket field. Keep
    // those credentials usable while upgrading the transport to ws/wss.
    const url = new URL(configuredUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    if (!url.pathname || url.pathname === '/') url.pathname = WS_CLIENT_PATH;
    return url.toString();
  }

  // Relative path or same-origin fallback
  if (typeof window !== 'undefined' && window.location) {
    const isHttps = window.location.protocol === 'https:';
    const wsProtocol = isHttps ? 'wss:' : 'ws:';
    const host = window.location.host;
    const path = configuredUrl.startsWith('/') ? configuredUrl : `/${configuredUrl}`;
    return `${wsProtocol}//${host}${path}`;
  }

  return `ws://127.0.0.1:8787/ws/client`;
}
