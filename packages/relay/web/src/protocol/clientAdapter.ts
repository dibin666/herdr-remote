/**
 * Typed Protocol Adapter for Herdr Remote WebUI
 * Handles WebSocket lifecycle, binary ANSI streams, and typed JSON control messages.
 */

import {
  ClientHelloMessage,
  ClientClaimControlMessage,
  ClientReleaseControlMessage,
  ClientResizeMessage,
  ClientPingMessage,
  ServerJsonMessage,
  ServerReadyMessage,
  ServerSessionReadyMessage,
  ClientRole,
  ConnectionState,
  ConnectionConfig,
} from '../types/protocol';
import { encodeStringToBytes } from './keyEncoder';

export type AdapterEventMap = {
  stateChange: (state: ConnectionState, detail?: string) => void;
  roleChange: (role: ClientRole, controllerId?: string, hostId?: string, assignedClientId?: string) => void;
  ready: (payload: ServerReadyMessage) => void;
  paired: (payload: { token: string; deviceId?: string; hostId?: string; expiresAt?: number | string }) => void;
  controlState: (role: ClientRole, controllerId?: string) => void;
  controlRevoked: (reason?: string) => void;
  sessionReady: (payload: ServerSessionReadyMessage) => void;
  exit: (code?: number, reason?: string) => void;
  controlGranted: () => void;
  controlDenied: (message?: string) => void;
  status: (payload: Record<string, unknown>) => void;
  /** How many windows currently share this terminal, this one included. */
  peerCount: (count: number) => void;
  error: (error: { code: string | number; message: string }) => void;
  binaryData: (data: Uint8Array) => void;
  rttUpdate: (rttMs: number) => void;
};

export class HerdrClientAdapter {
  private ws: WebSocket | null = null;
  private config: ConnectionConfig;
  private state: ConnectionState = 'disconnected';
  private currentRole: ClientRole = 'viewer';
  private controllerId?: string;
  private hostId?: string;
  private assignedClientId?: string;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimestamp: number | null = null;
  private isManuallyClosed = false;
  private authFailureDetail: string | null = null;

  private listeners: {
    [K in keyof AdapterEventMap]: Set<AdapterEventMap[K]>;
  } = {
    stateChange: new Set(),
    roleChange: new Set(),
    ready: new Set(),
    paired: new Set(),
    controlState: new Set(),
    controlRevoked: new Set(),
    sessionReady: new Set(),
    exit: new Set(),
    controlGranted: new Set(),
    controlDenied: new Set(),
    status: new Set(),
    peerCount: new Set(),
    error: new Set(),
    binaryData: new Set(),
    rttUpdate: new Set(),
  };

  private terminalCols = 80;
  private terminalRows = 24;

  constructor(config: ConnectionConfig) {
    this.config = { ...config };
  }

  public updateConfig(partialConfig: Partial<ConnectionConfig>): void {
    this.config = { ...this.config, ...partialConfig };
  }

  public getConfig(): ConnectionConfig {
    return { ...this.config };
  }

  public getState(): ConnectionState {
    return this.state;
  }

  public getRole(): ClientRole {
    return this.currentRole;
  }

  public getControllerId(): string | undefined {
    return this.controllerId;
  }

  public getHostId(): string | undefined {
    return this.hostId;
  }

  public getAssignedClientId(): string | undefined {
    return this.assignedClientId;
  }

  public on<K extends keyof AdapterEventMap>(
    event: K,
    listener: AdapterEventMap[K]
  ): () => void {
    this.listeners[event].add(listener);
    return () => {
      this.listeners[event].delete(listener);
    };
  }

  private emit<K extends keyof AdapterEventMap>(
    event: K,
    ...args: Parameters<AdapterEventMap[K]>
  ): void {
    const set = this.listeners[event];
    set.forEach((fn) => {
      try {
        // @ts-expect-error dynamic arg forwarding
        fn(...args);
      } catch (err) {
        console.error(`Error in event listener for ${event}:`, err);
      }
    });
  }

  private setState(newState: ConnectionState, detail?: string): void {
    if (this.state !== newState) {
      this.state = newState;
      this.emit('stateChange', newState, detail);
    }
  }

  public connect(dimensions?: { cols: number; rows: number }): void {
    if (dimensions) {
      this.terminalCols = dimensions.cols;
      this.terminalRows = dimensions.rows;
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    // A socket that is still CLOSING would otherwise keep its handlers alive and
    // report its close *after* the replacement is live. Detach it now.
    this.teardownSocket(1000, 'Replaced by a new connection');

    this.isManuallyClosed = false;
    this.authFailureDetail = null;
    this.clearTimers();
    this.setState('connecting');

    try {
      const url = this.resolveWsUrl(this.config.wsUrl);
      const socket = new WebSocket(url);
      this.ws = socket;
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
      this.setState('error', err instanceof Error ? err.message : 'Connection failed');
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
    this.connect();
  }

  private handleOpen(): void {
    this.reconnectAttempts = 0;
    this.sendHello();
    this.startHeartbeat();
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    if (typeof event.data === 'string') {
      // JSON Control message
      try {
        const msg = JSON.parse(event.data) as ServerJsonMessage;
        this.processJsonMessage(msg);
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

  private processJsonMessage(msg: ServerJsonMessage): void {
    switch (msg.type) {
      case 'ready': {
        this.setState('connected');
        this.currentRole = msg.role;
        this.controllerId = msg.controllerId;
        this.hostId = msg.hostId;
        this.assignedClientId = msg.clientId;
        this.emit('ready', msg);
        this.emit('roleChange', msg.role, msg.controllerId, msg.hostId, msg.clientId);
        if (typeof msg.clientCount === 'number') this.emit('peerCount', msg.clientCount);
        break;
      }

      case 'paired': {
        this.emit('paired', {
          token: msg.token,
          deviceId: msg.deviceId,
          hostId: msg.hostId,
          expiresAt: msg.expiresAt,
        });
        break;
      }

      case 'control_state': {
        this.currentRole = msg.role;
        this.controllerId = msg.controllerId;
        this.emit('controlState', msg.role, msg.controllerId);
        this.emit('roleChange', msg.role, msg.controllerId, this.hostId, this.assignedClientId);
        if (typeof msg.clientCount === 'number') this.emit('peerCount', msg.clientCount);
        break;
      }

      case 'control_revoked': {
        this.currentRole = 'viewer';
        this.emit('controlRevoked', msg.reason);
        this.emit('roleChange', 'viewer', this.controllerId, this.hostId, this.assignedClientId);
        break;
      }

      case 'session_ready': {
        this.emit('sessionReady', msg);
        break;
      }

      case 'exit': {
        this.emit('exit', msg.code, msg.reason);
        break;
      }

      case 'control_granted': {
        this.currentRole = 'controller';
        this.controllerId = this.assignedClientId || this.config.clientId;
        this.emit('controlGranted');
        this.emit('roleChange', 'controller', this.controllerId, this.hostId, this.assignedClientId);
        break;
      }

      case 'control_denied': {
        this.emit('controlDenied', msg.message);
        break;
      }

      case 'status': {
        this.emit('status', msg);
        break;
      }

      case 'error': {
        if (
          msg.code === 'auth_required' ||
          msg.code === 'unauthorized' ||
          msg.code === 401 ||
          msg.code === 403
        ) {
          this.authFailureDetail = msg.message;
          this.setState('error', msg.message);
        }
        this.emit('error', { code: msg.code, message: msg.message });
        break;
      }

      case 'pong': {
        if (this.pingTimestamp) {
          const rtt = Math.max(0, performance.now() - this.pingTimestamp);
          this.pingTimestamp = null;
          this.emit('rttUpdate', Math.round(rtt));
        }
        break;
      }

      default:
        break;
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
      this.setState('error', this.authFailureDetail);
      return;
    }

    if (!this.isManuallyClosed && this.config.autoReconnect) {
      this.setState('reconnecting', `Connection closed (${event.code}). Retrying...`);
      this.scheduleReconnect();
    } else {
      this.setState('disconnected', `Closed: ${event.reason || event.code}`);
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
      Math.floor(base * Math.pow(1.5, this.reconnectAttempts - 1) + Math.random() * 500)
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    const interval = this.config.pingIntervalMs || 10000;

    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.sendPing();
      }
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
  }

  public sendHello(): void {
    const msg: ClientHelloMessage = {
      type: 'hello',
      protocol: 1,
      clientId: this.config.clientId,
      cols: this.terminalCols,
      rows: this.terminalRows,
    };

    if (this.config.token) {
      msg.token = this.config.token;
    }
    if (this.config.pairCode) {
      msg.pairCode = this.config.pairCode;
    }

    this.sendJson(msg);
  }

  public claimControl(force: boolean = false): void {
    const msg: ClientClaimControlMessage = {
      type: 'claim_control',
      ...(force ? { force: true } : {}),
    };
    this.sendJson(msg);
  }

  public releaseControl(): void {
    const msg: ClientReleaseControlMessage = {
      type: 'release_control',
    };
    this.sendJson(msg);
  }

  public sendResize(cols: number, rows: number): void {
    this.terminalCols = cols;
    this.terminalRows = rows;

    const msg: ClientResizeMessage = {
      type: 'resize',
      cols,
      rows,
    };
    this.sendJson(msg);
  }

  public sendPing(): void {
    this.pingTimestamp = performance.now();
    const msg: ClientPingMessage = {
      type: 'ping',
    };
    this.sendJson(msg);
  }

  public sendJson(msg: ClientHelloMessage | ClientClaimControlMessage | ClientReleaseControlMessage | ClientResizeMessage | ClientPingMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  public sendBinary(data: Uint8Array | ArrayBuffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  public sendText(text: string): void {
    const bytes = encodeStringToBytes(text);
    this.sendBinary(bytes);
  }

  private resolveWsUrl(configuredUrl: string): string {
    if (configuredUrl.startsWith('ws://') || configuredUrl.startsWith('wss://')) {
      return configuredUrl;
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
}
