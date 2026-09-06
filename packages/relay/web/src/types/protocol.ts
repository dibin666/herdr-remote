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

export type ClientJsonMessage =
  | ClientHelloMessage
  | ClientClaimControlMessage
  | ClientReleaseControlMessage
  | ClientResizeMessage
  | ClientPingMessage;

export interface ServerReadyMessage {
  type: 'ready';
  role: ClientRole;
  controllerId?: string;
  hostId?: string;
  hostname?: string;
  clientId?: string;
  terminalPalette?: HostTerminalPalette | null;
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

/**
 * The grid the shared terminal now runs at.
 *
 * Every window renders this rather than its own capacity: the same bytes have
 * to look the same in all of them, and a browser painting a 43-column stream
 * into 158 columns of its own would wrap nothing where the workstation wrapped.
 */
export interface ServerSharedResizeMessage {
  type: 'shared_resize';
  cols: number;
  rows: number;
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

export type ServerJsonMessage =
  | ServerReadyMessage
  | ServerPairedMessage
  | ServerControlStateMessage
  | ServerSharedResizeMessage
  | ServerHostReconnectingMessage
  | ServerSessionRestartedMessage
  | ServerControlRevokedMessage
  | ServerSessionReadyMessage
  | ServerExitMessage
  | ServerControlGrantedMessage
  | ServerControlDeniedMessage
  | ServerStatusMessage
  | ServerErrorMessage
  | ServerPongMessage;

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
