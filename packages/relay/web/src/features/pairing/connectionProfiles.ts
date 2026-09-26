// Connection profiles: one saved relay + host pairing each, cleaned on every
// read so a hand-edited or older value never reaches a socket.

import { WS_CLIENT_PATH } from '@protocol/messages';
import type { StoredSettings } from '@/features/settings/storage';

export interface ConnectionProfile {
  /** Browser-local identity for one relay + host pairing. */
  id: string;
  displayName: string;
  wsUrl: string;
  token: string;
  pairCode?: string;
  hostId?: string;
  hostname?: string;
  deviceId?: string;
  autoReconnect: boolean;
  createdAt: number;
  lastUsedAt: number;
}

const MAX_PROFILE_NAME_LENGTH = 64;
export const MAX_PROFILE_TOKEN_LENGTH = 4096;

export function generateProfileId(): string {
  const randomStr = Math.random().toString(36).substring(2, 10);
  return `profile-${Date.now().toString(36)}-${randomStr}`;
}

function cleanProfileName(value: unknown, fallback: string): string {
  const name = typeof value === 'string' ? value.trim().slice(0, MAX_PROFILE_NAME_LENGTH) : '';
  return name || fallback;
}

export function cleanProfile(value: unknown, index: number): ConnectionProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Partial<ConnectionProfile>;
  const wsUrl = typeof source.wsUrl === 'string' ? source.wsUrl.trim().slice(0, 2048) : '';
  const token =
    typeof source.token === 'string' ? source.token.slice(0, MAX_PROFILE_TOKEN_LENGTH) : '';
  const pairCode =
    typeof source.pairCode === 'string' ? source.pairCode.trim().toUpperCase().slice(0, 32) : '';
  if (
    !wsUrl ||
    (!wsUrl.startsWith('/') && !/^(?:wss?|https?):\/\//i.test(wsUrl)) ||
    (!token && !pairCode)
  )
    return null;
  const now = Date.now();
  const id =
    typeof source.id === 'string' && source.id.length > 0
      ? source.id.slice(0, 128)
      : generateProfileId();
  const fallback =
    typeof source.hostname === 'string' && source.hostname.trim()
      ? source.hostname.trim().slice(0, MAX_PROFILE_NAME_LENGTH)
      : `Herdr ${index + 1}`;
  return {
    id,
    displayName: cleanProfileName(source.displayName, fallback),
    wsUrl,
    token,
    ...(pairCode ? { pairCode } : {}),
    ...(typeof source.hostId === 'string' && source.hostId.trim()
      ? { hostId: source.hostId.trim().slice(0, 128) }
      : {}),
    ...(typeof source.hostname === 'string' && source.hostname.trim()
      ? { hostname: source.hostname.trim().slice(0, 128) }
      : {}),
    ...(typeof source.deviceId === 'string' && source.deviceId.trim()
      ? { deviceId: source.deviceId.trim().slice(0, 128) }
      : {}),
    autoReconnect: source.autoReconnect !== false,
    createdAt: Number.isFinite(source.createdAt) ? Number(source.createdAt) : now,
    lastUsedAt: Number.isFinite(source.lastUsedAt) ? Number(source.lastUsedAt) : now,
  };
}

export function createConnectionProfile(
  partial: Partial<ConnectionProfile> & Pick<ConnectionProfile, 'wsUrl'>,
  index = 0,
): ConnectionProfile {
  const normalized = cleanProfile({ ...partial, id: partial.id || generateProfileId() }, index);
  if (!normalized)
    throw new Error('a connection profile requires a relay URL and token or pairing code');
  return normalized;
}

export function profileKey(profile: Pick<ConnectionProfile, 'wsUrl' | 'hostId'>): string {
  let relay = profile.wsUrl
    .replace(/\/ws\/client\/?$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (typeof window !== 'undefined') {
    try {
      const url = new URL(profile.wsUrl, window.location.origin);
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      url.pathname = url.pathname.replace(/\/ws\/client\/?$/, '').replace(/\/+$/, '') || '/';
      url.search = '';
      url.hash = '';
      relay = url.toString().replace(/\/$/, '').toLowerCase();
    } catch {
      // Keep the bounded string fallback for malformed legacy values.
    }
  }
  return `${relay}::${profile.hostId || ''}`;
}

export function normalizeProfiles(localData: Partial<StoredSettings>): {
  profiles: ConnectionProfile[];
  activeProfileId: string;
} {
  const profiles: ConnectionProfile[] = [];
  const rawProfiles = Array.isArray(localData.profiles) ? localData.profiles.slice(0, 64) : [];
  rawProfiles.forEach((profile, index) => {
    const cleaned = cleanProfile(profile, index);
    if (cleaned && !profiles.some((item) => item.id === cleaned.id)) profiles.push(cleaned);
  });

  // Migrate the v1 singleton connection without making an empty onboarding
  // page look like it contains a profile. A pending legacy pairCode is kept so
  // an interrupted pairing can still be resumed once.
  if (
    profiles.length === 0 &&
    ((typeof localData.token === 'string' && localData.token) ||
      (typeof localData.pairCode === 'string' && localData.pairCode))
  ) {
    const migrated = cleanProfile(
      {
        id: 'profile-migrated',
        displayName: 'Herdr 1',
        wsUrl:
          typeof localData.wsUrl === 'string' && localData.wsUrl.trim()
            ? localData.wsUrl
            : WS_CLIENT_PATH,
        token: localData.token || '',
        pairCode: localData.pairCode || '',
        autoReconnect: localData.autoReconnect !== false,
      },
      0,
    );
    if (migrated) profiles.push(migrated);
  }

  const requested = typeof localData.activeProfileId === 'string' ? localData.activeProfileId : '';
  const activeProfileId = profiles.some((profile) => profile.id === requested)
    ? requested
    : profiles[0]?.id || '';
  return { profiles, activeProfileId };
}
