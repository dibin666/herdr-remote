import { WS_CLIENT_PATH } from '@protocol/messages';
import type { Language } from '../i18n';
import { type AgentKeymapsSettings, sanitizeAgentKeymaps } from './agentKeymaps';
import { safeGetItem, safeSetItem, STORAGE_KEYS } from './browserStorage';
import {
  type ConnectionProfile,
  cleanProfile,
  generateProfileId,
  MAX_PROFILE_TOKEN_LENGTH,
  normalizeProfiles,
} from './connectionProfiles';
import {
  clampFontSize,
  DEFAULT_DESKTOP_FONT_SIZE,
  DEFAULT_MOBILE_FONT_SIZE,
} from './terminalLayout';
import { DEFAULT_TERMINAL_FONT, migrateFontFamily } from './theme';
import { getDefaultVirtualKeys, sanitizeVirtualKeys, type ToolbarKeyDef } from './virtualKeys';

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
  /**
   * Use the workstation terminal's size instead of `fontSize`. On by default;
   * moving the size slider turns it off.
   */
  fontSizeFollowsHost: boolean;
  /** A preset id from `FONT_PRESETS` (`host` by default) or a custom CSS stack. */
  fontFamily: string;
  toolbarVisible: boolean;
  toolbarPosition: 'bottom' | 'top';
  vibrateOnKeyPress: boolean;
  predictiveEcho: 'auto' | 'always' | 'off';
  virtualKeys: ToolbarKeyDef[];
  /** Workstation-wide agent shortcut overrides, shared with newly opened windows. */
  agentKeymaps: AgentKeymapsSettings;
  /**
   * When an agent is blocked or done: count it in the tab title and badge the
   * icon (on by default, since both simply sit there), and optionally chime,
   * vibrate, or — on HTTPS only — post a system notification.
   */
  agentAlertBadge: boolean;
  agentAlertSound: boolean;
  agentAlertVibrate: boolean;
  agentAlertNotify: boolean;
  /** Per-window operator credentials keyed by the exact relay origin. */
  adminToken?: string;
  adminTokens?: Record<string, string>;
}

/** Where builds before the key registry kept the ignored release. */
const LEGACY_IGNORED_UPDATE_KEY = 'herdr-remote.ignoredUpdate';

/** The herdr-remote release the user chose not to hear about again, if any. */
export function loadIgnoredUpdate(): string | null {
  const current = safeGetItem('local', STORAGE_KEYS.ignoredUpdate);
  if (current !== null) return current;
  const legacy = safeGetItem('local', LEGACY_IGNORED_UPDATE_KEY);
  if (legacy === null) return null;
  saveIgnoredUpdate(legacy);
  try {
    window.localStorage.removeItem(LEGACY_IGNORED_UPDATE_KEY);
  } catch {
    // Left behind, the old key is only read again while the new one is empty.
  }
  return legacy;
}

export function saveIgnoredUpdate(version: string): void {
  safeSetItem('local', STORAGE_KEYS.ignoredUpdate, version);
}

function generateClientId(): string {
  const randomStr = Math.random().toString(36).substring(2, 8);
  return `client-${randomStr}`;
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
    wsUrl: WS_CLIENT_PATH,
    token: '',
    pairCode: '',
    clientId: generateClientId(),
    autoReconnect: true,
    profiles: [],
    activeProfileId: '',
    fontSize: isMobile ? DEFAULT_MOBILE_FONT_SIZE : DEFAULT_DESKTOP_FONT_SIZE,
    fontSizeFollowsHost: true,
    fontFamily: DEFAULT_TERMINAL_FONT,
    toolbarVisible: true,
    toolbarPosition: 'bottom',
    vibrateOnKeyPress: true,
    predictiveEcho: 'auto',
    agentAlertBadge: true,
    agentAlertSound: false,
    agentAlertVibrate: false,
    agentAlertNotify: false,
    language: detectDefaultLanguage(),
    virtualKeys: getDefaultVirtualKeys(),
    agentKeymaps: {},
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
  'agentKeymaps',
];

const CONNECTION_KEYS: Array<keyof StoredSettings> = [
  'wsUrl',
  'token',
  'pairCode',
  'autoReconnect',
];

const SESSION_KEYS: Array<keyof StoredSettings> = [
  'fontSize',
  'fontSizeFollowsHost',
  'fontFamily',
  'toolbarVisible',
  'toolbarPosition',
  'vibrateOnKeyPress',
  'predictiveEcho',
  'virtualKeys',
  'agentAlertBadge',
  'agentAlertSound',
  'agentAlertVibrate',
  'agentAlertNotify',
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
  (key) => key !== 'adminToken' && key !== 'adminTokens',
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
  const rawLocal = safeGetItem('local', STORAGE_KEYS.settings);
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
    safeSetItem('local', STORAGE_KEYS.settings, JSON.stringify(localData));
  }

  // 2. Read per-window view settings from sessionStorage
  let sessionData: Partial<StoredSettings> | null = null;
  const rawSession = safeGetItem('session', STORAGE_KEYS.sessionView);
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
    safeSetItem('session', STORAGE_KEYS.sessionView, JSON.stringify(sessionData));
  }

  // Stacks stored by older builds become the preset that replaced them.
  const fontFamily = migrateFontFamily(
    sessionData.fontFamily ?? localData.fontFamily ?? defaults.fontFamily,
  );

  const fallbackSize =
    window.innerWidth < 640 ? DEFAULT_MOBILE_FONT_SIZE : DEFAULT_DESKTOP_FONT_SIZE;
  // Strict priority: sessionData (per-window) > localData (seed) > defaults
  const rawFontSize = sessionData.fontSize ?? localData.fontSize ?? defaults.fontSize;
  const fontSize = clampFontSize(rawFontSize, fallbackSize);
  // Settings from before the size could follow the host: a size somebody
  // moved away from the default was a choice and is kept; a default size
  // follows the host like a fresh install.
  const storedFollows = sessionData.fontSizeFollowsHost ?? localData.fontSizeFollowsHost;
  const fontSizeFollowsHost =
    typeof storedFollows === 'boolean'
      ? storedFollows
      : rawFontSize === undefined ||
        fontSize === DEFAULT_DESKTOP_FONT_SIZE ||
        fontSize === DEFAULT_MOBILE_FONT_SIZE;

  const rawVirtualKeys = sessionData.virtualKeys ?? localData.virtualKeys ?? defaults.virtualKeys;
  const virtualKeys = sanitizeVirtualKeys(rawVirtualKeys);

  const rawLang = localData.language ?? defaults.language;
  const language: Language =
    rawLang === 'zh' || rawLang === 'en' ? rawLang : detectDefaultLanguage();
  const normalizedProfiles = normalizeProfiles(localData);
  const activeProfile = normalizedProfiles.profiles.find(
    (profile) => profile.id === normalizedProfiles.activeProfileId,
  );

  const strippedSession = stripLegacyColorFields(sessionData);
  if (strippedSession.changed) {
    sessionData = strippedSession.data;
    safeSetItem('session', STORAGE_KEYS.sessionView, JSON.stringify(sessionData));
  }

  const toolbarVisible =
    sessionData.toolbarVisible ?? localData.toolbarVisible ?? defaults.toolbarVisible;
  const toolbarPosition =
    sessionData.toolbarPosition ?? localData.toolbarPosition ?? defaults.toolbarPosition;
  const vibrateOnKeyPress =
    sessionData.vibrateOnKeyPress ?? localData.vibrateOnKeyPress ?? defaults.vibrateOnKeyPress;
  const booleanSetting = (
    key: 'agentAlertBadge' | 'agentAlertSound' | 'agentAlertVibrate' | 'agentAlertNotify',
  ) => {
    const value = sessionData[key] ?? localData[key];
    return typeof value === 'boolean' ? value : defaults[key];
  };
  const rawPredictiveEcho =
    sessionData?.predictiveEcho ?? localData?.predictiveEcho ?? defaults.predictiveEcho;
  const predictiveEcho: 'auto' | 'always' | 'off' =
    rawPredictiveEcho === 'always' || rawPredictiveEcho === 'off' || rawPredictiveEcho === 'auto'
      ? rawPredictiveEcho
      : 'auto';
  const adminToken =
    typeof sessionData.adminToken === 'string'
      ? sessionData.adminToken.slice(0, MAX_PROFILE_TOKEN_LENGTH)
      : typeof localData.adminToken === 'string'
        ? localData.adminToken.slice(0, MAX_PROFILE_TOKEN_LENGTH)
        : defaults.adminToken;
  const adminTokens = sanitizeAdminTokens(sessionData.adminTokens);

  const result: StoredSettings = {
    ...defaults,
    ...localData,
    ...sessionData,
    wsUrl:
      activeProfile?.wsUrl ||
      (typeof localData.wsUrl === 'string' ? localData.wsUrl : defaults.wsUrl),
    token: activeProfile?.token || '',
    pairCode: activeProfile?.pairCode || '',
    autoReconnect: activeProfile?.autoReconnect ?? defaults.autoReconnect,
    profiles: normalizedProfiles.profiles,
    activeProfileId: normalizedProfiles.activeProfileId,
    clientId:
      typeof localData.clientId === 'string' && localData.clientId.trim()
        ? localData.clientId.trim().slice(0, 128)
        : defaults.clientId,
    fontFamily,
    fontSize,
    fontSizeFollowsHost,
    toolbarVisible,
    toolbarPosition,
    vibrateOnKeyPress,
    predictiveEcho,
    virtualKeys,
    agentKeymaps: sanitizeAgentKeymaps(localData.agentKeymaps),
    agentAlertBadge: booleanSetting('agentAlertBadge'),
    agentAlertSound: booleanSetting('agentAlertSound'),
    agentAlertVibrate: booleanSetting('agentAlertVibrate'),
    agentAlertNotify: booleanSetting('agentAlertNotify'),
    language,
    adminToken,
    adminTokens,
  };

  // Write a migrated font back, so the browser-wide copy a new window seeds
  // from no longer names a stack that is not offered any more.
  if (
    typeof localData.fontFamily === 'string' &&
    migrateFontFamily(localData.fontFamily) !== localData.fontFamily
  ) {
    localData.fontFamily = migrateFontFamily(localData.fontFamily);
    safeSetItem('local', STORAGE_KEYS.settings, JSON.stringify(localData));
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
  next.agentKeymaps = sanitizeAgentKeymaps(next.agentKeymaps);
  next.adminTokens = sanitizeAdminTokens(next.adminTokens);
  if (typeof next.adminToken === 'string')
    next.adminToken = next.adminToken.slice(0, MAX_PROFILE_TOKEN_LENGTH);

  if (updates.fontSize !== undefined) {
    next.fontSize = clampFontSize(updates.fontSize);
  }

  if (updates.predictiveEcho !== undefined) {
    if (
      updates.predictiveEcho === 'auto' ||
      updates.predictiveEcho === 'always' ||
      updates.predictiveEcho === 'off'
    ) {
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
    const candidate =
      activeIndex >= 0
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
  next.wsUrl = activeProfile?.wsUrl || next.wsUrl || WS_CLIENT_PATH;
  next.token = activeProfile?.token || '';
  next.pairCode = activeProfile?.pairCode || '';
  next.autoReconnect = activeProfile?.autoReconnect ?? next.autoReconnect;

  // 1. Save global keys and normalized profiles to localStorage
  const rawLocal = safeGetItem('local', STORAGE_KEYS.settings);
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
  safeSetItem('local', STORAGE_KEYS.settings, JSON.stringify(localObj));

  // 2. Save session-specific view keys to sessionStorage
  const rawSession = safeGetItem('session', STORAGE_KEYS.sessionView);
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
  safeSetItem('session', STORAGE_KEYS.sessionView, JSON.stringify(sessionObj));

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
  safeSetItem('local', STORAGE_KEYS.settings, JSON.stringify(localObj));

  return next;
}
