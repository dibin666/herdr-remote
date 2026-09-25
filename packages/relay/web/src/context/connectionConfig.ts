import type { ConnectionConfig } from '../types/connection';
import type { StoredSettings } from '../utils/storage';

/** How the adapter connects, from the saved settings of the active profile. */
export function buildConnectionConfig(source: StoredSettings): ConnectionConfig {
  return {
    wsUrl: source.wsUrl,
    token: source.token || undefined,
    pairCode: source.pairCode || undefined,
    clientId: source.clientId,
    autoReconnect: source.autoReconnect,
    reconnectIntervalMs: 2000,
    // Network failures are transient for a remote host; retry indefinitely
    // until the user disconnects or credentials are explicitly rejected.
    maxReconnectAttempts: 0,
    pingIntervalMs: 10000,
  };
}
