import { clampFontSize, DEFAULT_DESKTOP_FONT_SIZE, DEFAULT_MOBILE_FONT_SIZE } from './terminalLayout';
import { Language } from '../i18n/types';
import { ToolbarKeyDef, getDefaultVirtualKeys, sanitizeVirtualKeys } from './virtualKeys';

export const DEFAULT_TERMINAL_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", "Symbols Nerd Font Mono", monospace';

export const OLD_SYSTEM_DEFAULT_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

export const LEGACY_DEFAULT_FONT =
  'JetBrains Mono, Menlo, Monaco, Consolas, monospace';

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

export interface StoredSettings {
  // The active connection projection is kept for compatibility with existing
  // components and old callers. The source of truth is `profiles` below.
  wsUrl: string;
  token: string;
  pairCode: string;
  clientId: string;
  autoReconnect: boolean;
  profiles: ConnectionProfile[];
  activeProfileId: string;
  language: Language;

  // Per-window / session view states (stored in sessionStorage)
  fontSize: number;
  fontFamily: string;
  toolbarVisible: boolean;
  toolbarPosition: 'bottom' | 'top';
  vibrateOnKeyPress: boolean;
  predictiveEcho: 'auto' | 'always' | 'off';
  virtualKeys: ToolbarKeyDef[];
  /** Per-window operator credentials keyed by the exact relay origin. */
  adminToken?: string;
  adminTokens?: Record<string, string>;
}

export const LOCAL_STORAGE_KEY = 'herdr_remote_settings_v1';
export const SESSION_STORAGE_KEY = 'herdr_remote_session_view_v1';
export const MAX_PROFILE_NAME_LENGTH = 64;
export const MAX_PROFILE_TOKEN_LENGTH = 4096;

// In-memory fallback if sessionStorage / localStorage are unavailable
const memoryStorage: {
  local: Record<string, string>;
  session: Record<string, string>;
} = {
  local: {},
  session: {},
};

function safeGetItem(type: 'local' | 'session', key: string): string | null {
  if (typeof window === 'undefined') return memoryStorage[type][key] || null;
  try {
    const storage = type === 'local' ? window.localStorage : window.sessionStorage;
    return storage.getItem(key);
  } catch {
    return memoryStorage[type][key] || null;
  }
}

function safeSetItem(type: 'local' | 'session', key: string, value: string): void {
  memoryStorage[type][key] = value;
  if (typeof window === 'undefined') return;
  try {
    const storage = type === 'local' ? window.localStorage : window.sessionStorage;
    storage.setItem(key, value);
  } catch (err) {
    console.warn(`Failed to write to ${type}Storage:`, err);
  }
}

export function clearMemoryStorage(): void {
  memoryStorage.local = {};
  memoryStorage.session = {};
}

function generateClientId(): string {
  const randomStr = Math.random().toString(36).substring(2, 8);
  return `client-${randomStr}`;
}

function generateProfileId(): string {
  const randomStr = Math.random().toString(36).substring(2, 10);
  return `profile-${Date.now().toString(36)}-${randomStr}`;
}

function cleanProfileName(value: unknown, fallback: string): string {
  const name = typeof value === 'string' ? value.trim().slice(0, MAX_PROFILE_NAME_LENGTH) : '';
  return name || fallback;
}

function cleanProfile(value: unknown, index: number): ConnectionProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Partial<ConnectionProfile>;
  const wsUrl = typeof source.wsUrl === 'string' ? source.wsUrl.trim().slice(0, 2048) : '';
  const token = typeof source.token === 'string' ? source.token.slice(0, MAX_PROFILE_TOKEN_LENGTH) : '';
  const pairCode = typeof source.pairCode === 'string' ? source.pairCode.trim().toUpperCase().slice(0, 32) : '';
  if (!wsUrl || (!wsUrl.startsWith('/') && !/^(?:wss?|https?):\/\//i.test(wsUrl)) || (!token && !pairCode)) return null;
  const now = Date.now();
  const id = typeof source.id === 'string' && source.id.length > 0
    ? source.id.slice(0, 128)
    : generateProfileId();
  const fallback = typeof source.hostname === 'string' && source.hostname.trim()
    ? source.hostname.trim().slice(0, MAX_PROFILE_NAME_LENGTH)
    : `Herdr ${index + 1}`;
  return {
    id,
    displayName: cleanProfileName(source.displayName, fallback),
    wsUrl,
    token,
    ...(pairCode ? { pairCode } : {}),
    ...(typeof source.hostId === 'string' && source.hostId.trim() ? { hostId: source.hostId.trim().slice(0, 128) } : {}),
    ...(typeof source.hostname === 'string' && source.hostname.trim() ? { hostname: source.hostname.trim().slice(0, 128) } : {}),
    ...(typeof source.deviceId === 'string' && source.deviceId.trim() ? { deviceId: source.deviceId.trim().slice(0, 128) } : {}),
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
  if (!normalized) throw new Error('a connection profile requires a relay URL and token or pairing code');
  return normalized;
}

export function profileKey(profile: Pick<ConnectionProfile, 'wsUrl' | 'hostId'>): string {
  let relay = profile.wsUrl.replace(/\/ws\/client\/?$/, '').replace(/\/+$/, '').toLowerCase();
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

export function detectDefaultLanguage(): Language {
  if (typeof navigator !== 'undefined' && navigator.language) {
    if (navigator.language.toLowerCase().startsWith('zh')) {
      return 'zh';
    }
  }
  return 'en';
}

export function getDefaultSettings(): StoredSettings {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
  return {
    wsUrl: '/ws/client',
    token: '',
    pairCode: '',
    clientId: generateClientId(),
    autoReconnect: true,
    profiles: [],
    activeProfileId: '',
    fontSize: isMobile ? DEFAULT_MOBILE_FONT_SIZE : DEFAULT_DESKTOP_FONT_SIZE,
    fontFamily: DEFAULT_TERMINAL_FONT,
    toolbarVisible: true,
    toolbarPosition: 'bottom',
    vibrateOnKeyPress: true,
    predictiveEcho: 'auto',
    language: detectDefaultLanguage(),
    virtualKeys: getDefaultVirtualKeys(),
    adminToken: '',
    adminTokens: {},
  };
}

const GLOBAL_KEYS: Array<keyof StoredSettings> = [
  'wsUrl',
  'token',
  'pairCode',
  'clientId',
  'autoReconnect',
  'language',
];

const CONNECTION_KEYS: Array<keyof StoredSettings> = [
  'wsUrl',
  'token',
  'pairCode',
  'autoReconnect',
];

const SESSION_KEYS: Array<keyof StoredSettings> = [
  'fontSize',
  'fontFamily',
  'toolbarVisible',
  'toolbarPosition',
  'vibrateOnKeyPress',
  'predictiveEcho',
  'virtualKeys',
  'adminToken',
  'adminTokens',
];

/**
 * The subset of the per-window settings that is also remembered browser-wide,
 * so a new window continues where the last one left off instead of resetting to
 * the defaults.
 *
 * `adminToken` and `adminTokens` are deliberately excluded. They are relay
 * operator credentials and stay in sessionStorage only: they should not outlive
 * the tab they were typed into, and they have no business being written to disk.
 */
const PERSISTED_VIEW_KEYS: Array<keyof StoredSettings> = SESSION_KEYS.filter(
  (key) => key !== 'adminToken' && key !== 'adminTokens'
);

/**
 * Terminal colors used to be a client setting. They are the host's now, so any
 * palette an older build persisted is stripped on read and never written back.
 */
const LEGACY_COLOR_KEYS = ['theme', 'colorMode'] as const;

function stripLegacyColorFields<T extends object>(data: T): { data: T; changed: boolean } {
  const record = data as Record<string, unknown>;
  const changed = LEGACY_COLOR_KEYS.some((key) => record[key] !== undefined);
  if (!changed) return { data, changed: false };

  const next: Record<string, unknown> = { ...record };
  for (const key of LEGACY_COLOR_KEYS) delete next[key];
  return { data: next as T, changed: true };
}

function sanitizeAdminTokens(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: Record<string, string> = {};
  for (const [key, token] of Object.entries(value as Record<string, unknown>).slice(0, 32)) {
    if (typeof token !== 'string' || token.length === 0) continue;
    output[key.slice(0, 512)] = token.slice(0, MAX_PROFILE_TOKEN_LENGTH);
  }
  return output;
}

function normalizeProfiles(localData: Partial<StoredSettings>): {
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
  if (profiles.length === 0
    && (typeof localData.token === 'string' && localData.token
      || typeof localData.pairCode === 'string' && localData.pairCode)) {
    const migrated = cleanProfile({
      id: 'profile-migrated',
      displayName: 'Herdr 1',
      wsUrl: typeof localData.wsUrl === 'string' && localData.wsUrl.trim() ? localData.wsUrl : '/ws/client',
      token: localData.token || '',
      pairCode: localData.pairCode || '',
      autoReconnect: localData.autoReconnect !== false,
    }, 0);
    if (migrated) profiles.push(migrated);
  }

  const requested = typeof localData.activeProfileId === 'string' ? localData.activeProfileId : '';
  const activeProfileId = profiles.some((profile) => profile.id === requested)
    ? requested
    : profiles[0]?.id || '';
  return { profiles, activeProfileId };
}

/**
 * Load merged settings:
 * 1. Global credentials come from localStorage
 * 2. View/zoom/font settings come from sessionStorage (per-window isolation)
 * 3. Fallback: If sessionStorage is empty, seed from localStorage (or defaults),
 *    after which sessionStorage strictly takes precedence over any legacy localStorage data.
 */
export function loadSettings(): StoredSettings {
  const defaults = getDefaultSettings();
  if (typeof window === 'undefined') return defaults;

  // 1. Read global credentials from localStorage
  let localData: Partial<StoredSettings> = {};
  const rawLocal = safeGetItem('local', LOCAL_STORAGE_KEY);
  if (rawLocal) {
    try {
      localData = JSON.parse(rawLocal);
    } catch (err) {
      console.warn('Failed to parse localStorage settings:', err);
    }
  }

  const strippedLocal = stripLegacyColorFields(localData);
  if (strippedLocal.changed) {
    localData = strippedLocal.data;
    safeSetItem('local', LOCAL_STORAGE_KEY, JSON.stringify(localData));
  }

  // 2. Read per-window view settings from sessionStorage
  let sessionData: Partial<StoredSettings> | null = null;
  const rawSession = safeGetItem('session', SESSION_STORAGE_KEY);
  if (rawSession) {
    try {
      sessionData = JSON.parse(rawSession);
    } catch (err) {
      console.warn('Failed to parse sessionStorage settings:', err);
    }
  }

  // If this window does not have a session state yet (e.g. freshly opened tab),
  // seed from legacy localStorage or defaults, then save this initial snapshot into sessionStorage.
  if (!sessionData) {
    const seededSession: Partial<StoredSettings> = {};
    for (const key of SESSION_KEYS) {
      if (localData[key] !== undefined) {
        (seededSession as any)[key] = localData[key];
      }
    }
    sessionData = seededSession;
    safeSetItem('session', SESSION_STORAGE_KEY, JSON.stringify(sessionData));
  }

  // Auto-migrate legacy default font to new system monospace font stack (with Symbols Nerd Font Mono)
  let fontFamily = sessionData.fontFamily ?? localData.fontFamily ?? defaults.fontFamily;
  if (!fontFamily || fontFamily === LEGACY_DEFAULT_FONT || fontFamily === OLD_SYSTEM_DEFAULT_FONT) {
    fontFamily = DEFAULT_TERMINAL_FONT;
  }

  const fallbackSize = window.innerWidth < 640 ? DEFAULT_MOBILE_FONT_SIZE : DEFAULT_DESKTOP_FONT_SIZE;
  // Strict priority: sessionData (per-window) > localData (seed) > defaults
  const rawFontSize = sessionData.fontSize ?? localData.fontSize ?? defaults.fontSize;
  const fontSize = clampFontSize(rawFontSize, fallbackSize);

  const rawVirtualKeys = sessionData.virtualKeys ?? localData.virtualKeys ?? defaults.virtualKeys;
  const virtualKeys = sanitizeVirtualKeys(rawVirtualKeys);

  const rawLang = localData.language ?? defaults.language;
  const language: Language = rawLang === 'zh' || rawLang === 'en' ? rawLang : detectDefaultLanguage();
  const normalizedProfiles = normalizeProfiles(localData);
  const activeProfile = normalizedProfiles.profiles.find(
    (profile) => profile.id === normalizedProfiles.activeProfileId,
  );

  const strippedSession = stripLegacyColorFields(sessionData);
  if (strippedSession.changed) {
    sessionData = strippedSession.data;
    safeSetItem('session', SESSION_STORAGE_KEY, JSON.stringify(sessionData));
  }

  const toolbarVisible = sessionData.toolbarVisible ?? localData.toolbarVisible ?? defaults.toolbarVisible;
  const toolbarPosition = sessionData.toolbarPosition ?? localData.toolbarPosition ?? defaults.toolbarPosition;
  const vibrateOnKeyPress = sessionData.vibrateOnKeyPress ?? localData.vibrateOnKeyPress ?? defaults.vibrateOnKeyPress;
  const rawPredictiveEcho = sessionData?.predictiveEcho ?? localData?.predictiveEcho ?? defaults.predictiveEcho;
  const predictiveEcho: 'auto' | 'always' | 'off' =
    rawPredictiveEcho === 'always' || rawPredictiveEcho === 'off' || rawPredictiveEcho === 'auto'
      ? rawPredictiveEcho
      : 'auto';
  const adminToken = typeof sessionData.adminToken === 'string'
    ? sessionData.adminToken.slice(0, MAX_PROFILE_TOKEN_LENGTH)
    : typeof localData.adminToken === 'string'
      ? localData.adminToken.slice(0, MAX_PROFILE_TOKEN_LENGTH)
      : defaults.adminToken;
  const adminTokens = sanitizeAdminTokens(sessionData.adminTokens);

  const result: StoredSettings = {
    ...defaults,
    ...localData,
    ...sessionData,
    wsUrl: activeProfile?.wsUrl || (typeof localData.wsUrl === 'string' ? localData.wsUrl : defaults.wsUrl),
    token: activeProfile?.token || '',
    pairCode: activeProfile?.pairCode || '',
    autoReconnect: activeProfile?.autoReconnect ?? defaults.autoReconnect,
    profiles: normalizedProfiles.profiles,
    activeProfileId: normalizedProfiles.activeProfileId,
    clientId: typeof localData.clientId === 'string' && localData.clientId.trim()
      ? localData.clientId.trim().slice(0, 128)
      : defaults.clientId,
    fontFamily,
    fontSize,
    toolbarVisible,
    toolbarPosition,
    vibrateOnKeyPress,
    predictiveEcho,
    virtualKeys,
    language,
    adminToken,
    adminTokens,
  };

  // If migrated from legacy default font in localStorage, update localStorage
  if (localData.fontFamily === LEGACY_DEFAULT_FONT) {
    localData.fontFamily = DEFAULT_TERMINAL_FONT;
    safeSetItem('local', LOCAL_STORAGE_KEY, JSON.stringify(localData));
  }

  return result;
}

/**
 * Save settings with strict per-window isolation:
 * - Credentials & global keys persist to localStorage
 * - View / zoom / font / virtual-key states persist only to this window's sessionStorage
 */
export function saveSettings(updates: Partial<StoredSettings>): StoredSettings {
  const current = loadSettings();
  const next: StoredSettings = { ...current, ...updates };
  next.adminTokens = sanitizeAdminTokens(next.adminTokens);
  if (typeof next.adminToken === 'string') next.adminToken = next.adminToken.slice(0, MAX_PROFILE_TOKEN_LENGTH);

  if (updates.fontSize !== undefined) {
    next.fontSize = clampFontSize(updates.fontSize);
  }

  if (updates.predictiveEcho !== undefined) {
    if (updates.predictiveEcho === 'auto' || updates.predictiveEcho === 'always' || updates.predictiveEcho === 'off') {
      next.predictiveEcho = updates.predictiveEcho;
    } else {
      next.predictiveEcho = 'auto';
    }
  }

  // The profile list is the credential source of truth. Legacy connection
  // fields are kept as a projection so older embeds can read settings during a
  // rolling frontend deployment.
  const normalized = normalizeProfiles(next);
  let profiles = normalized.profiles;
  let activeProfileId = normalized.activeProfileId;
  const connectionChanged = CONNECTION_KEYS.some((key) => updates[key] !== undefined);
  if (connectionChanged) {
    const activeIndex = profiles.findIndex((profile) => profile.id === activeProfileId);
    const candidate = activeIndex >= 0
      ? { ...profiles[activeIndex] }
      : {
          id: generateProfileId(),
          displayName: `Herdr ${profiles.length + 1}`,
          wsUrl: next.wsUrl,
          token: '',
          autoReconnect: true,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
        };
    candidate.wsUrl = next.wsUrl;
    candidate.token = next.token;
    candidate.pairCode = next.pairCode || undefined;
    candidate.autoReconnect = next.autoReconnect;
    candidate.lastUsedAt = Date.now();
    const cleaned = cleanProfile(candidate, Math.max(activeIndex, 0));
    if (cleaned) {
      if (activeIndex >= 0) profiles[activeIndex] = cleaned;
      else {
        profiles.push(cleaned);
        activeProfileId = cleaned.id;
      }
    } else if (activeIndex >= 0) {
      profiles = profiles.filter((profile) => profile.id !== activeProfileId);
      activeProfileId = profiles[0]?.id || '';
    }
  }
  if (profiles.length > 0 && !profiles.some((profile) => profile.id === activeProfileId)) {
    activeProfileId = profiles[0].id;
  }
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId);
  next.profiles = profiles;
  next.activeProfileId = activeProfileId;
  next.wsUrl = activeProfile?.wsUrl || next.wsUrl || '/ws/client';
  next.token = activeProfile?.token || '';
  next.pairCode = activeProfile?.pairCode || '';
  next.autoReconnect = activeProfile?.autoReconnect ?? next.autoReconnect;

  // 1. Save global keys and normalized profiles to localStorage
  const rawLocal = safeGetItem('local', LOCAL_STORAGE_KEY);
  let localObj: Record<string, any> = {};
  if (rawLocal) {
    try {
      localObj = JSON.parse(rawLocal);
    } catch {}
  }
  localObj = stripLegacyColorFields(localObj).data;
  for (const k of GLOBAL_KEYS) {
    if (next[k] !== undefined) {
      localObj[k] = next[k];
    }
  }
  localObj.profiles = profiles;
  localObj.activeProfileId = activeProfileId;
  safeSetItem('local', LOCAL_STORAGE_KEY, JSON.stringify(localObj));

  // 2. Save session-specific view keys to sessionStorage
  const rawSession = safeGetItem('session', SESSION_STORAGE_KEY);
  let sessionObj: Record<string, any> = {};
  if (rawSession) {
    try {
      sessionObj = JSON.parse(rawSession);
    } catch {}
  }
  for (const k of SESSION_KEYS) {
    if (next[k] !== undefined) {
      sessionObj[k] = next[k];
    }
  }
  safeSetItem('session', SESSION_STORAGE_KEY, JSON.stringify(sessionObj));

  // 3. Mirror the view settings into localStorage as the browser-wide baseline.
  //
  // sessionStorage dies with the tab, so writing there alone meant every visit
  // started from the built-in defaults — a font size chosen on a phone had to be
  // chosen again on the next visit. localStorage remembers the last values
  // saved anywhere, and a newly opened window seeds from them.
  //
  // The two-tier arrangement is what keeps both properties: windows already
  // open keep their own sessionStorage overrides and are unaffected by another
  // window's changes, while a *new* window inherits rather than resetting.
  for (const k of PERSISTED_VIEW_KEYS) {
    if (next[k] !== undefined) {
      localObj[k] = next[k];
    }
  }
  safeSetItem('local', LOCAL_STORAGE_KEY, JSON.stringify(localObj));

  return next;
}
