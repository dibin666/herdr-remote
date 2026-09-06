import { clampFontSize, DEFAULT_DESKTOP_FONT_SIZE, DEFAULT_MOBILE_FONT_SIZE } from './terminalLayout';
import { Language } from '../i18n/types';
import { ToolbarKeyDef, getDefaultVirtualKeys, sanitizeVirtualKeys } from './virtualKeys';

export type AppTheme = 'claude' | 'light' | 'dark' | 'tokyonight' | 'monokai' | 'matrix';
export type ColorMode = 'light' | 'dark' | 'system';

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
  theme: AppTheme;
  /** Legacy persisted field; the web shell is always dark. */
  colorMode: ColorMode;
  cursorBlink: boolean;
  cursorStyle: 'block' | 'underline' | 'bar';
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
    // The web shell is intentionally dark-only. `theme` controls the terminal
    // ANSI palette, while the chrome always uses the Herdr dark palette.
    theme: 'dark',
    colorMode: 'dark',
    cursorBlink: true,
    cursorStyle: 'block',
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
  'theme',
  'colorMode',
  'cursorBlink',
  'cursorStyle',
  'toolbarVisible',
  'toolbarPosition',
  'vibrateOnKeyPress',
  'virtualKeys',
  'adminToken',
];

/**
 * Load merged settings:
 * 1. Global credentials come from localStorage
 * 2. View/zoom/theme settings come from sessionStorage (per-window isolation)
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

  const rawTheme = sessionData.theme ?? localData.theme ?? defaults.theme;
  // Before the dark-only redesign, `claude` was the implicit light default.
  // Migrate that legacy default, but preserve an explicit palette selected in
  // the current UI (whose colorMode is already dark).
  const legacyThemeWasDefault =
    rawTheme === 'claude' &&
    (sessionData.colorMode ?? localData.colorMode) !== 'dark';
  const theme: AppTheme = legacyThemeWasDefault ? 'dark' : rawTheme;
  // Interface color mode is no longer user-configurable. Always normalize old
  // light/system values so a previous session can never re-enable a light shell.
  const colorMode: ColorMode = 'dark';
  if (sessionData.colorMode !== 'dark' || legacyThemeWasDefault) {
    sessionData = {
      ...sessionData,
      colorMode,
      ...(legacyThemeWasDefault ? { theme } : {}),
    };
    safeSetItem('session', SESSION_STORAGE_KEY, JSON.stringify(sessionData));
  }
  const cursorBlink = sessionData.cursorBlink ?? localData.cursorBlink ?? defaults.cursorBlink;
  const cursorStyle = sessionData.cursorStyle ?? localData.cursorStyle ?? defaults.cursorStyle;
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
    theme,
    colorMode,
    cursorBlink,
    cursorStyle,
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
 * - View / zoom / font / theme / virtual-key states persist only to this window's sessionStorage
 */
export function saveSettings(updates: Partial<StoredSettings>): StoredSettings {
  const current = loadSettings();
  // Keep the legacy field for storage compatibility, but never allow callers
  // (including stale UI code) to turn the web shell back to light/system mode.
  const next: StoredSettings = { ...current, ...updates, colorMode: 'dark' };

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

  return next;
}
