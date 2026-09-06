import { clampFontSize, DEFAULT_DESKTOP_FONT_SIZE, DEFAULT_MOBILE_FONT_SIZE } from './terminalLayout';
import { Language } from '../i18n/types';
import { ToolbarKeyDef, getDefaultVirtualKeys, sanitizeVirtualKeys } from './virtualKeys';

export const DEFAULT_TERMINAL_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

export const LEGACY_DEFAULT_FONT =
  'JetBrains Mono, Menlo, Monaco, Consolas, monospace';

export interface StoredSettings {
  // Global connection & identity credentials (persisted in localStorage)
  wsUrl: string;
  token: string;
  pairCode: string;
  clientId: string;
  autoReconnect: boolean;
  language: Language;

  // Per-window / session view states (stored in sessionStorage)
  fontSize: number;
  fontFamily: string;
  toolbarVisible: boolean;
  toolbarPosition: 'bottom' | 'top';
  vibrateOnKeyPress: boolean;
  virtualKeys: ToolbarKeyDef[];
  adminToken?: string;
}

export const LOCAL_STORAGE_KEY = 'herdr_remote_settings_v1';
export const SESSION_STORAGE_KEY = 'herdr_remote_session_view_v1';

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
    fontSize: isMobile ? DEFAULT_MOBILE_FONT_SIZE : DEFAULT_DESKTOP_FONT_SIZE,
    fontFamily: DEFAULT_TERMINAL_FONT,
    toolbarVisible: true,
    toolbarPosition: 'bottom',
    vibrateOnKeyPress: true,
    language: detectDefaultLanguage(),
    virtualKeys: getDefaultVirtualKeys(),
    adminToken: '',
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

const SESSION_KEYS: Array<keyof StoredSettings> = [
  'fontSize',
  'fontFamily',
  'toolbarVisible',
  'toolbarPosition',
  'vibrateOnKeyPress',
  'virtualKeys',
  'adminToken',
];

/**
 * The subset of the per-window settings that is also remembered browser-wide,
 * so a new window continues where the last one left off instead of resetting to
 * the defaults.
 *
 * `adminToken` is deliberately excluded. It is the relay operator credential,
 * and it stays in sessionStorage only: it should not outlive the tab it was
 * typed into, and it has no business being written to disk.
 */
const PERSISTED_VIEW_KEYS: Array<keyof StoredSettings> = SESSION_KEYS.filter(
  (key) => key !== 'adminToken'
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

  // Auto-migrate legacy default font to new system monospace font stack
  let fontFamily = sessionData.fontFamily ?? localData.fontFamily ?? defaults.fontFamily;
  if (!fontFamily || fontFamily === LEGACY_DEFAULT_FONT) {
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

  const strippedSession = stripLegacyColorFields(sessionData);
  if (strippedSession.changed) {
    sessionData = strippedSession.data;
    safeSetItem('session', SESSION_STORAGE_KEY, JSON.stringify(sessionData));
  }

  const toolbarVisible = sessionData.toolbarVisible ?? localData.toolbarVisible ?? defaults.toolbarVisible;
  const toolbarPosition = sessionData.toolbarPosition ?? localData.toolbarPosition ?? defaults.toolbarPosition;
  const vibrateOnKeyPress = sessionData.vibrateOnKeyPress ?? localData.vibrateOnKeyPress ?? defaults.vibrateOnKeyPress;
  const adminToken = sessionData.adminToken ?? localData.adminToken ?? defaults.adminToken;

  const result: StoredSettings = {
    ...defaults,
    ...localData,
    ...sessionData,
    clientId: localData.clientId || defaults.clientId,
    fontFamily,
    fontSize,
    toolbarVisible,
    toolbarPosition,
    vibrateOnKeyPress,
    virtualKeys,
    language,
    adminToken,
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

  if (updates.fontSize !== undefined) {
    next.fontSize = clampFontSize(updates.fontSize);
  }

  // 1. Save global keys to localStorage
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
