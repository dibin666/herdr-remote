/**
 * Herdr Remote WebUI Protocol Definitions
 * Version: Protocol 1
 */

export type ClientRole = 'controller' | 'viewer';

/** The sixteen ANSI slots, exactly as the host's terminal reported them. */
export interface HostAnsiPalette {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/**
 * The workstation's terminal colors, answered by the host's own emulator to
 * the OSC 10/11/12 and OSC 4 queries. The browser renders with these instead
 * of inventing a palette, which is what makes the web view look like the
 * session does on the workstation.
 */
export interface HostTerminalPalette {
  background?: string;
  foreground?: string;
  cursor?: string;
  ansi?: HostAnsiPalette;
}

export type HostFontStyle = 'regular' | 'bold' | 'italic' | 'boldItalic';

/** One file behind the workstation's terminal font, known here only by hash. */
export interface HostFontFace {
  style: HostFontStyle;
  format: 'truetype' | 'opentype';
  bytes: number;
  sha256: string;
}

/**
 * The font the workstation's terminal draws with, read by the host from that
 * terminal's own settings (see `packages/cli/src/terminal-font.js`). `faces`
 * lists the files a browser without the font may fetch, a slice at a time.
 */
/**
 * A font too large to send whole, cut to the characters a window draws.
 * `cjk`: the face the workstation falls back to for Hanzi; `all`: the family
 * itself (a CJK programming font).
 */
export interface HostFontSubsetSource {
  family: string;
  style: 'regular';
  scope: 'cjk' | 'all';
  /** Identifies the source font; subsets are cached under it. */
  sha256: string;
}

export interface HostTerminalFont {
  family: string;
  /** In CSS pixels, converted from the terminal's points. */
  sizePx?: number;
  /** Which terminal it came from: `gnome-terminal`, `kitty`, … */
  source?: string;
  faces: HostFontFace[];
  subsets?: HostFontSubsetSource[];
}

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
export interface ServerReadyMessage {
  type: 'ready';
  role: ClientRole;
  controllerId?: string;
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
  controllerId?: string;
  /** How many windows share this terminal, this one included. */
  clientCount?: number;
}

export interface ServerHostReconnectingMessage {
  type: 'host_reconnecting';
  code?: string;
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

export interface ServerControlRevokedMessage {
  type: 'control_revoked';
  reason?: string;
}

export interface ServerSessionReadyMessage {
  type: 'session_ready';
  sessionId?: string;
  [key: string]: unknown;
}

export interface ServerExitMessage {
  type: 'exit';
  code?: number;
  reason?: string;
}

export interface ServerControlGrantedMessage {
  type: 'control_granted';
}

export interface ServerControlDeniedMessage {
  type: 'control_denied';
  message?: string;
}

export interface ServerStatusMessage {
  type: 'status';
  [key: string]: unknown;
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
 * reads it from Herdr's socket API; see `packages/cli/src/agent-status.js`.
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
  | ServerHostReconnectingMessage
  | ServerSessionRestartedMessage
  | ServerControlRevokedMessage
  | ServerSessionReadyMessage
  | ServerExitMessage
  | ServerControlGrantedMessage
  | ServerControlDeniedMessage
  | ServerStatusMessage
  | ServerErrorMessage
  | ServerPongMessage
  | ServerPasteFileReadyMessage
  | ServerAgentStatusMessage
  | ServerUpdateStatusMessage;
export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

export interface ConnectionConfig {
  wsUrl: string;
  token?: string;
  pairCode?: string;
  clientId: string;
  autoReconnect: boolean;
  reconnectIntervalMs: number;
  maxReconnectAttempts: number;
  pingIntervalMs: number;
}
