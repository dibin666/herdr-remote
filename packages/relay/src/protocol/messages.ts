// Every JSON message on the relay's two WebSocket channels, by direction:
//
//   host connector ──HostMessage──▶ relay ──ServerJsonMessage──▶ browser
//   host connector ◀─RelayToHostMessage── relay ◀─ClientJsonMessage── browser
//
// Browser-safe: types and constants only. Terminal bytes travel separately as
// binary frames (see ./frames).

import type { HostTerminalFont, HostTerminalPalette } from './terminal.js';

export const WS_HOST_PATH = '/ws/host';
export const WS_CLIENT_PATH = '/ws/client';

/** What a peer may announce in its hello's `capabilities`. */
export const CAPABILITY = {
  /** Keep browser sessions alive across a host reconnect. */
  hostHandoff: 'host_handoff',
  /** The host sends heartbeats only while a browser is watching. */
  idleHeartbeat: 'idle_heartbeat',
  /** The host routes output by 16-bit stream index (v2 frames). */
  binaryFrameV2: 'binary_frame_v2',
} as const;

export type ClientRole = 'controller' | 'viewer';

// ---------------------------------------------------------------------------
// Browser → relay
// ---------------------------------------------------------------------------

export interface ClientHelloMessage {
  type: 'hello';
  protocol: 1;
  token?: string;
  pairCode?: string;
  clientId: string;
  cols: number;
  rows: number;
  capabilities?: string[];
}

export interface ClientClaimControlMessage {
  type: 'claim_control';
  force?: boolean;
}

export interface ClientReleaseControlMessage {
  type: 'release_control';
}

export interface ClientResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

export interface ClientPingMessage {
  type: 'ping';
}

export interface ClientPasteFileMessage {
  type: 'paste_file';
  mime: string;
  dataBase64: string;
}

/**
 * Start Herdr on the workstation this window is paired to. Carries nothing:
 * the relay routes it to the window's own host, and the host decides where and
 * as whom Herdr runs.
 */
export interface ClientHerdrStartMessage {
  type: 'herdr_start';
}

/** One slice of an announced font file, by the file's hash. */
export interface ClientHostFontChunkRequestMessage {
  type: 'host_font_chunk_request';
  sha256: string;
  index: number;
}

/** Cut `text`'s characters out of an announced large font. */
export interface ClientHostFontSubsetRequestMessage {
  type: 'host_font_subset_request';
  sha256: string;
  text: string;
  requestId: string;
}

/** Ask the workstation to read its terminal's font settings again. */
export interface ClientHostFontRefreshMessage {
  type: 'host_font_refresh';
}

export type ClientJsonMessage =
  | ClientHelloMessage
  | ClientHostFontChunkRequestMessage
  | ClientHostFontSubsetRequestMessage
  | ClientHostFontRefreshMessage
  | ClientClaimControlMessage
  | ClientReleaseControlMessage
  | ClientResizeMessage
  | ClientPingMessage
  | ClientPasteFileMessage
  | ClientHerdrStartMessage;

// ---------------------------------------------------------------------------
// Relay → browser
// ---------------------------------------------------------------------------

export interface ServerReadyMessage {
  type: 'ready';
  role: ClientRole;
  controllerId?: string | null;
  hostId?: string;
  hostname?: string;
  clientId?: string;
  terminalPalette?: HostTerminalPalette | null;
  terminalFont?: HostTerminalFont | null;
  /** How many windows share this terminal, this one included. */
  clientCount?: number;
}

export interface ServerPairedMessage {
  type: 'paired';
  token: string;
  deviceId?: string;
  hostId?: string;
  expiresAt?: number | string;
}

export interface ServerControlStateMessage {
  type: 'control_state';
  role: ClientRole;
  controllerId?: string | null;
  /** How many windows share this terminal, this one included. */
  clientCount?: number;
}

export interface ServerControlGrantedMessage {
  type: 'control_granted';
}

export interface ServerHostReconnectingMessage {
  type: 'host_reconnecting';
  code?: string;
}

export interface ServerSessionReadyMessage {
  type: 'session_ready';
  clientId?: string;
}

export interface ServerSessionRestartedMessage {
  type: 'session_restarted';
  streamId?: string;
  cols?: number;
  rows?: number;
  hostname?: string;
  terminalPalette?: HostTerminalPalette | null;
  terminalFont?: HostTerminalFont | null;
}

export interface ServerExitMessage {
  type: 'exit';
  code?: number | null;
  reason?: string;
}

export interface ServerErrorMessage {
  type: 'error';
  code: string | number;
  message: string;
}

export interface ServerPongMessage {
  type: 'pong';
}

export interface ServerPasteFileReadyMessage {
  type: 'paste_file_ready';
  path: string;
}

/** Herdr's own vocabulary for what a pane's agent is doing. */
export type AgentStatus = 'blocked' | 'done' | 'working' | 'idle' | 'unknown';

export interface AgentStatusEntry {
  paneId: string | null;
  workspaceId: string | null;
  agent: string | null;
  title: string | null;
  status: string | null;
  focused: boolean;
}

/**
 * What the workstation's agents are doing.
 *
 * Broadcast to every window watching this workstation rather than scoped to a
 * stream: it is a fact about the machine, not about one terminal. The host
 * reads it from Herdr's socket API.
 */
export interface ServerAgentStatusMessage {
  type: 'agent_status';
  focusedPaneId?: string | null;
  focusedAgent?: string | null;
  counts: Partial<Record<AgentStatus, number>>;
  total: number;
  agents: AgentStatusEntry[];
}

/**
 * Whether the workstation's herdr-remote is behind the newest release. Checked
 * by the host when a window opens and kept by the relay for later windows.
 */
export interface ServerUpdateStatusMessage {
  type: 'update_status';
  /** The version the workstation is running. */
  current: string;
  /** The version on disk; ahead of `current` when an update awaits a restart. */
  installed: string;
  latest: string;
  updateAvailable: boolean;
  restartPending: boolean;
}

/** The workstation re-read its terminal font; sent to every window. */
export interface ServerTerminalFontMessage {
  type: 'terminal_font';
  terminalFont: HostTerminalFont | null;
}

export interface ServerHostFontChunkMessage {
  type: 'host_font_chunk';
  sha256: string;
  index: number;
  total: number;
  dataBase64: string;
}

/**
 * A cut is ready. Small ones carry their bytes; a large one is pulled like a
 * font file, by `subsetSha`, a slice at a time.
 */
export interface ServerHostFontSubsetMessage {
  type: 'host_font_subset_ready';
  requestId: string;
  sha256: string;
  subsetSha: string;
  bytes: number;
  dataBase64?: string;
}

export type ServerJsonMessage =
  | ServerTerminalFontMessage
  | ServerHostFontSubsetMessage
  | ServerHostFontChunkMessage
  | ServerReadyMessage
  | ServerPairedMessage
  | ServerControlStateMessage
  | ServerControlGrantedMessage
  | ServerHostReconnectingMessage
  | ServerSessionRestartedMessage
  | ServerSessionReadyMessage
  | ServerExitMessage
  | ServerErrorMessage
  | ServerPongMessage
  | ServerPasteFileReadyMessage
  | ServerAgentStatusMessage
  | ServerUpdateStatusMessage;

// ---------------------------------------------------------------------------
// Host connector → relay
// ---------------------------------------------------------------------------

/**
 * Every host message about one browser's session names it by stream. The
 * relay sends both fields with the same value; a host reads `clientId` first.
 */
interface StreamAddressed {
  clientId?: string;
  streamId?: string;
}

export interface HostHelloMessage {
  type: 'host_hello';
  protocol: 1;
  hostId: string;
  token: string;
  password?: string | null;
  hostname?: string;
  platform?: string;
  arch?: string;
  terminalPalette?: HostTerminalPalette | null;
  terminalFont?: HostTerminalFont | null;
  capabilities?: string[];
}

/** One PTY the host is running, as the relay's status page lists it. */
export interface HostPtySummary {
  id: string;
  pid: number | null;
  command: string;
  cols: number;
  rows: number;
  [key: string]: unknown;
}

export interface HostHeartbeatMessage {
  type: 'heartbeat';
  load: {
    load1m?: number;
    load5m?: number;
    load15m?: number;
    rssBytes?: number;
    heapUsedBytes?: number;
  };
  ptys: HostPtySummary[];
}

export interface HostShutdownMessage {
  type: 'host_shutdown';
}

export interface HostSessionReadyMessage extends StreamAddressed {
  type: 'session_ready';
}

export interface HostSessionExitMessage extends StreamAddressed {
  type: 'session_exit';
  code: number | null;
}

export interface HostPasteFileReadyMessage extends StreamAddressed {
  type: 'paste_file_ready';
  path: string;
}

export interface HostErrorMessage extends StreamAddressed {
  type: 'error';
  code: string;
  message: string;
}

export type HostAgentStatusMessage = ServerAgentStatusMessage;
export type HostUpdateStatusMessage = ServerUpdateStatusMessage;
export type HostTerminalFontMessage = ServerTerminalFontMessage;
export type HostFontChunkMessage = ServerHostFontChunkMessage & StreamAddressed;
export type HostFontSubsetMessage = ServerHostFontSubsetMessage & StreamAddressed;

export type HostMessage =
  | HostHelloMessage
  | HostHeartbeatMessage
  | HostShutdownMessage
  | HostAgentStatusMessage
  | HostUpdateStatusMessage
  | HostTerminalFontMessage
  | HostSessionReadyMessage
  | HostSessionExitMessage
  | HostFontChunkMessage
  | HostFontSubsetMessage
  | HostPasteFileReadyMessage
  | HostErrorMessage;

// ---------------------------------------------------------------------------
// Relay → host connector
// ---------------------------------------------------------------------------

export interface RelayHostReadyMessage {
  type: 'host_ready';
  protocol: 1;
  hostId: string;
  clientCount: number;
}

/** How many browsers watch; the host stops its telemetry at zero. */
export interface RelayClientCountMessage {
  type: 'client_count';
  clientCount: number;
}

export interface RelaySessionStartMessage extends StreamAddressed {
  type: 'session_start';
  cols: number;
  rows: number;
  role: ClientRole;
  /** Present when the host negotiated v2 frames and an index was free. */
  streamIndex?: number;
}

export interface RelaySessionStopMessage extends StreamAddressed {
  type: 'session_stop';
}

export interface RelayResizeMessage extends StreamAddressed {
  type: 'resize';
  cols: number;
  rows: number;
}

export interface RelayHerdrStartMessage extends StreamAddressed {
  type: 'herdr_start';
}

export interface RelayHostFontRefreshMessage extends StreamAddressed {
  type: 'host_font_refresh';
}

export interface RelayHostFontChunkRequestMessage extends StreamAddressed {
  type: 'host_font_chunk_request';
  sha256: string;
  index: number;
}

export interface RelayHostFontSubsetRequestMessage extends StreamAddressed {
  type: 'host_font_subset_request';
  requestId: string;
  sha256: string;
  text: string;
}

export interface RelayPasteFileMessage extends StreamAddressed {
  type: 'paste_file';
  mime: string;
  dataBase64: string;
}

/** Sent instead of `host_ready` when the handshake is refused. */
export interface RelayErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export type RelayToHostMessage =
  | RelayHostReadyMessage
  | RelayClientCountMessage
  | RelaySessionStartMessage
  | RelaySessionStopMessage
  | RelayResizeMessage
  | RelayHerdrStartMessage
  | RelayHostFontRefreshMessage
  | RelayHostFontChunkRequestMessage
  | RelayHostFontSubsetRequestMessage
  | RelayPasteFileMessage
  | RelayErrorMessage;
