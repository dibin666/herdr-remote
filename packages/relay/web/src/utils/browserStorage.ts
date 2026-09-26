// Every key this app keeps in the browser, and reads and writes that survive
// a browser that refuses storage (private mode, a sandboxed iframe, plain
// HTTP on some mobile browsers).

/** Bump the version suffix when a value's shape changes incompatibly. */
export const STORAGE_KEYS = {
  /** localStorage: credentials, profiles and the browser-wide view baseline. */
  settings: 'herdr_remote_settings_v1',
  /** sessionStorage: this window's own view settings. */
  sessionView: 'herdr_remote_session_view_v1',
  /** localStorage: the release the user chose not to hear about again. */
  ignoredUpdate: 'herdr-remote.ignoredUpdate',
  /** localStorage: per-workstation answers to "use the host's font?". */
  hostFontConsent: 'herdr_remote_host_font_consent_v1',
  /** localStorage: user agents whose canvas renderer failed its probe. */
  rendererProbe: 'herdr_remote_renderer_probe_v3',
} as const;

type StorageArea = 'local' | 'session';

// In-memory fallback if sessionStorage / localStorage are unavailable
const memoryStorage: Record<StorageArea, Record<string, string>> = {
  local: {},
  session: {},
};

export function safeGetItem(type: StorageArea, key: string): string | null {
  if (typeof window === 'undefined') return memoryStorage[type][key] || null;
  try {
    const storage = type === 'local' ? window.localStorage : window.sessionStorage;
    return storage.getItem(key);
  } catch {
    return memoryStorage[type][key] || null;
  }
}

export function safeSetItem(type: StorageArea, key: string, value: string): void {
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
