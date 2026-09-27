import type { ConnectionConfig } from '@/connection/types';
import type { StoredSettings } from '@/features/settings/storage';

export function getWindowConnectionProfile(source: StoredSettings, profileId?: string | null) {
  const requested = source.profiles.find((profile) => profile.id === profileId);
  const activeProfileId = requested?.id ?? source.activeProfileId;
  return {
    activeProfileId,
    activeProfile: source.profiles.find((profile) => profile.id === activeProfileId),
  };
}

/** How the adapter connects, from the saved settings of the active profile. */
export function buildConnectionConfig(
  source: StoredSettings,
  profileId?: string | null,
): ConnectionConfig {
  const profile = source.profiles.find((item) => item.id === profileId);
  return {
    wsUrl: profile?.wsUrl ?? source.wsUrl,
    token: (profile?.token ?? source.token) || undefined,
    pairCode: (profile?.pairCode ?? source.pairCode) || undefined,
    adminTerminal:
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('adminTerminal') === '1',
    clientId: source.clientId,
    autoReconnect: profile?.autoReconnect ?? source.autoReconnect,
    reconnectIntervalMs: 2000,
    // Network failures are transient for a remote host; retry indefinitely
    // until the user disconnects or credentials are explicitly rejected.
    maxReconnectAttempts: 0,
    pingIntervalMs: 10000,
  };
}
