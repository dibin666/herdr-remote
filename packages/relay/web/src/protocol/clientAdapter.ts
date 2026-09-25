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
  ClientJsonMessage,
  ServerJsonMessage,
  ServerReadyMessage,
  ServerSessionReadyMessage,
  ServerAgentStatusMessage,
  ServerUpdateStatusMessage,
  ServerSessionRestartedMessage,
  ServerHostFontChunkMessage,
  ServerHostFontSubsetMessage,
  HostTerminalFont,
  ClientRole,
  ConnectionState,
  ConnectionConfig,
} from '../types/protocol';
import { encodeStringToBytes } from './keyEncoder';
import { isWheelOnlyInput } from './scrollInput';

export type AdapterEventMap = {
  /**
   * `code` is the relay's own machine-readable reason, when it gave one.
   *
   * `detail` is the server's English sentence, which is the right thing to show
   * an operator reading logs and the wrong thing to show a Chinese interface.
   * Carrying the code alongside it lets the UI say the same thing in its own
   * language and keep the original only as a fallback.
   */
  stateChange: (state: ConnectionState, detail?: string, code?: string) => void;
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
  /** The authenticated host socket is temporarily reconnecting. */
  hostReconnecting: (code?: string) => void;
  /** A new PTY was created after a host handoff or profile switch. */
  sessionRestarted: (cols?: number, rows?: number, palette?: ServerSessionRestartedMessage['terminalPalette'], hostname?: string) => void;
  error: (error: { code: string | number; message: string }) => void;
  binaryData: (data: Uint8Array) => void;
  rttUpdate: (rttMs: number) => void;
  pasteFileReady: (path: string) => void;
  /** What the workstation's agents are doing; broadcast, not stream-scoped. */
  agentStatus: (status: ServerAgentStatusMessage) => void;
  /** Whether the workstation's herdr-remote has a newer release; broadcast. */
  updateStatus: (status: ServerUpdateStatusMessage) => void;
  /**
   * The workstation's terminal font: with `ready`, after a session restart,
   * and whenever the host re-reads it. `null` when the host reported none.
   */
  terminalFont: (font: HostTerminalFont | null) => void;
  /** One slice of a font file this window asked for. */
  hostFontChunk: (chunk: ServerHostFontChunkMessage) => void;
  /** A large font cut to the characters this window asked for. */
  hostFontSubset: (subset: ServerHostFontSubsetMessage) => void;
};

/** How long a ping may go unanswered before the socket is written off. */
const PROBE_TIMEOUT_MS = 3000;
/** A connection attempt still pending after this long is stuck, not slow. */
const CONNECT_STALL_MS = 10000;
/** Wake events arrive in bursts (visibility, focus and pageshow together). */
const WAKE_MIN_INTERVAL_MS = 1500;

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
  // Wall-clock times: performance.now() can stand still while a phone sleeps,
  // and sleep is exactly what these measure across.
  private lastInboundAt = 0;
  private pingSentAt: number | null = null;
  private connectStartedAt = 0;
  private lastWakeConnectAt = 0;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private rejectedByRelay = false;
  private isManuallyClosed = false;
  private authFailureDetail: string | null = null;
  private authFailureCode: string | null = null;
  private temporaryFailureCode: string | null = null;
  private pendingInputSegments: Uint8Array[] = [];
  private isFlushScheduled = false;

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
    hostReconnecting: new Set(),
    sessionRestarted: new Set(),
    error: new Set(),
    binaryData: new Set(),
    rttUpdate: new Set(),
    pasteFileReady: new Set(),
    agentStatus: new Set(),
    updateStatus: new Set(),
    terminalFont: new Set(),
    hostFontChunk: new Set(),
    hostFontSubset: new Set(),
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

  private setState(newState: ConnectionState, detail?: string, code?: string): void {
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

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
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
      const url = this.resolveWsUrl(this.config.wsUrl);
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
        'connection_failed'
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
    this.pendingInputSegments = [];
    this.isFlushScheduled = false;
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
    this.pendingInputSegments = [];
    this.isFlushScheduled = false;
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
    if (this.isManuallyClosed || !this.config.autoReconnect || this.authFailureDetail || this.rejectedByRelay) {
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
      if (now - this.connectStartedAt > CONNECT_STALL_MS) this.dropStaleSocket('connection_stalled');
      return;
    }

    if (socket.readyState === WebSocket.OPEN && now - this.lastInboundAt > this.pingIntervalMs() + 2000) {
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
        this.reconnectAttempts = 0;
        this.setState('connected');
        this.currentRole = msg.role;
        this.controllerId = msg.controllerId;
        this.hostId = msg.hostId;
        this.assignedClientId = msg.clientId;
        this.emit('ready', msg);
        this.emit('roleChange', msg.role, msg.controllerId, msg.hostId, msg.clientId);
        if (typeof msg.clientCount === 'number') this.emit('peerCount', msg.clientCount);
        this.emit('terminalFont', msg.terminalFont ?? null);
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

      case 'host_reconnecting': {
        this.temporaryFailureCode = 'host_reconnecting';
        this.setState('reconnecting', 'Herdr host is reconnecting', msg.code || 'host_reconnecting');
        this.emit('hostReconnecting', msg.code);
        break;
      }

      case 'session_restarted': {
        this.setState('reconnecting', 'Herdr session is restarting', 'session_restarted');
        this.emit('sessionRestarted', msg.cols, msg.rows, msg.terminalPalette, msg.hostname);
        this.emit('terminalFont', msg.terminalFont ?? null);
        break;
      }

      case 'control_revoked': {
        this.currentRole = 'viewer';
        this.emit('controlRevoked', msg.reason);
        this.emit('roleChange', 'viewer', this.controllerId, this.hostId, this.assignedClientId);
        break;
      }

      case 'session_ready': {
        this.setState('connected');
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
        const temporary = msg.code === 'host_offline'
          || msg.code === 'host_reconnecting'
          || msg.code === 'host_reconnect_timeout'
          || msg.code === 'rate_limited';
        if (temporary) {
          this.temporaryFailureCode = String(msg.code);
          this.setState('reconnecting', msg.message, String(msg.code));
        } else if (
          msg.code === 'auth_required' ||
          msg.code === 'unauthorized' ||
          msg.code === 'device_revoked' ||
          msg.code === 'invalid_handshake' ||
          msg.code === 'too_many_hosts' ||
          msg.code === 401 ||
          msg.code === 403
        ) {
          this.authFailureDetail = msg.message;
          this.authFailureCode = String(msg.code);
          this.setState('error', msg.message, this.authFailureCode);
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

      case 'paste_file_ready': {
        this.emit('pasteFileReady', msg.path);
        break;
      }

      case 'agent_status': {
        this.emit('agentStatus', msg);
        break;
      }

      case 'update_status': {
        this.emit('updateStatus', msg);
        break;
      }

      case 'terminal_font': {
        this.emit('terminalFont', msg.terminalFont ?? null);
        break;
      }

      case 'host_font_chunk': {
        this.emit('hostFontChunk', msg);
        break;
      }

      case 'host_font_subset_ready': {
        this.emit('hostFontSubset', msg);
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
      this.setState('error', this.authFailureDetail, this.authFailureCode ?? undefined);
      return;
    }
    if (event.code === 1008 && this.temporaryFailureCode) {
      this.setState('reconnecting', event.reason || 'The relay is temporarily unavailable', this.temporaryFailureCode);
      this.scheduleReconnect();
      return;
    }
    if (event.code === 1008) {
      this.rejectedByRelay = true;
      this.setState('error', event.reason || 'The relay rejected the connection', String(event.code));
      return;
    }

    if (!this.isManuallyClosed && this.config.autoReconnect) {
      this.setState('reconnecting', `Connection closed (${event.code}). Retrying...`, 'connection_closed');
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
      Math.floor(base * Math.pow(1.5, this.reconnectAttempts - 1) + Math.random() * 500)
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
      if (this.pingSentAt !== null && this.lastInboundAt < this.pingSentAt && Date.now() - this.pingSentAt >= interval) {
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

  public sendHello(): void {
    const msg: ClientHelloMessage = {
      type: 'hello',
      protocol: 1,
      clientId: this.config.clientId,
      cols: this.terminalCols,
      rows: this.terminalRows,
      capabilities: ['host_handoff'],
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
    this.pingSentAt = Date.now();
    const msg: ClientPingMessage = {
      type: 'ping',
    };
    this.sendJson(msg);
  }

  public sendPasteFile(mime: string, dataBase64: string): void {
    this.sendJson({
      type: 'paste_file',
      mime,
      dataBase64,
    });
  }

  /** One slice of an announced terminal font file, by the file's hash. */
  public sendHostFontChunkRequest(sha256: string, index: number): void {
    this.sendJson({ type: 'host_font_chunk_request', sha256, index });
  }

  /** Cut `text`'s characters out of an announced large font. */
  public sendHostFontSubsetRequest(sha256: string, text: string, requestId: string): void {
    this.sendJson({ type: 'host_font_subset_request', sha256, text, requestId });
  }

  /** Ask the workstation to read its terminal's font settings again. */
  public sendHostFontRefresh(): void {
    this.sendJson({ type: 'host_font_refresh' });
  }

  /** Ask the paired workstation to start its Herdr; see `ClientHerdrStartMessage`. */
  public sendHerdrStart(): void {
    this.sendJson({ type: 'herdr_start' });
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
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.length === 0) return;
    this.pendingInputSegments.push(bytes);
    if (!this.isFlushScheduled) {
      this.isFlushScheduled = true;
      // Microtask executes before yielding to the event loop, ensuring zero added latency
      // for single keystrokes while coalescing wheel events within the same macro gesture.
      queueMicrotask(() => this.flushInput());
    }
  }

  public flushInput(): void {
    this.isFlushScheduled = false;
    if (this.pendingInputSegments.length === 0) return;

    let segments = this.pendingInputSegments;
    this.pendingInputSegments = [];

    // Drop wheel reports when under backpressure (>256KB queued), keeping keystrokes intact.
    if (this.ws && (this.ws.bufferedAmount ?? 0) > 256 * 1024) {
      segments = segments.filter((seg) => !isWheelOnlyInput(seg));
    }

    if (segments.length === 0) return;

    let merged: Uint8Array;
    if (segments.length === 1) {
      merged = segments[0];
    } else {
      let totalLength = 0;
      for (let i = 0; i < segments.length; i++) {
        totalLength += segments[i].byteLength;
      }
      merged = new Uint8Array(totalLength);
      let offset = 0;
      for (let i = 0; i < segments.length; i++) {
        merged.set(segments[i], offset);
        offset += segments[i].byteLength;
      }
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(merged);
    }
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

  private resolveWsUrl(configuredUrl: string): string {
    if (/^wss?:\/\//i.test(configuredUrl)) {
      return configuredUrl;
    }
    if (/^https?:\/\//i.test(configuredUrl)) {
      // Older settings accepted an HTTP origin in the WebSocket field. Keep
      // those credentials usable while upgrading the transport to ws/wss.
      const url = new URL(configuredUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      if (!url.pathname || url.pathname === '/') url.pathname = '/ws/client';
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
}
