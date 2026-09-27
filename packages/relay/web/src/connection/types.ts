// The browser's own connection state. Wire messages are defined once, in the
// relay's protocol module (`@protocol/messages`, `@protocol/terminal`).

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
  adminTerminal?: boolean;
  clientId: string;
  autoReconnect: boolean;
  reconnectIntervalMs: number;
  maxReconnectAttempts: number;
  pingIntervalMs: number;
}
