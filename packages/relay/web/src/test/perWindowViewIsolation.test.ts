import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadSettings,
  saveSettings,
  LOCAL_STORAGE_KEY,
} from '../utils/storage';

/**
 * Creates a mock Storage implementation to simulate independent window sessionStorage instances
 */
class MemoryStorageShim implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

describe('Per-Window View State & Font Zoom Isolation', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('seeds a new window from the last saved view settings while keeping open windows independent', () => {
    // Shared localStorage across both windows
    const sharedLocalStorage = new MemoryStorageShim();
    Object.defineProperty(window, 'localStorage', {
      value: sharedLocalStorage,
      writable: true,
      configurable: true,
    });

    // SessionStorage for Window 1
    const window1SessionStorage = new MemoryStorageShim();
    // SessionStorage for Window 2
    const window2SessionStorage = new MemoryStorageShim();

    const switchWindow = (win: 1 | 2) => {
      Object.defineProperty(window, 'sessionStorage', {
        value: win === 1 ? window1SessionStorage : window2SessionStorage,
        writable: true,
        configurable: true,
      });
    };

    // --- 1. Initialize Baseline in Window 1 ---
    switchWindow(1);
    saveSettings({
      token: 'shared-device-token-123',
      wsUrl: '/ws/client',
      clientId: 'client-window-1',
    });

    // Window 1 sets font size to 24px and picks the Consolas stack
    saveSettings({
      fontSize: 24,
      fontFamily: 'Consolas, "Lucida Console", monospace',
    });

    const win1Settings = loadSettings();
    expect(win1Settings.fontSize).toBe(24);
    expect(win1Settings.fontFamily).toBe('Consolas, "Lucida Console", monospace');
    expect(win1Settings.token).toBe('shared-device-token-123');

    // --- 2. Open Window 2 (Fresh Tab/Session) ---
    switchWindow(2);
    const win2Initial = loadSettings();
    // Inherits shared credentials
    expect(win2Initial.token).toBe('shared-device-token-123');
    // A newly opened window continues from the last saved view settings rather
    // than resetting to the defaults: closing a tab used to silently discard a
    // chosen font size, so each visit began at 15px again.
    expect(win2Initial.fontSize).toBe(24);
    expect(win2Initial.fontFamily).toBe('Consolas, "Lucida Console", monospace');

    // Window 2 adjusts font size to 11px (compact zoom) and picks Fira Code
    saveSettings({
      fontSize: 11,
      fontFamily: '"Fira Code", monospace',
    });

    const win2Settings = loadSettings();
    expect(win2Settings.fontSize).toBe(11);
    expect(win2Settings.fontFamily).toBe('"Fira Code", monospace');

    // --- 3. Switch back to Window 1 ---
    switchWindow(1);
    const win1Current = loadSettings();
    // Window 1's zoom & font must NOT be polluted by Window 2's changes!
    expect(win1Current.fontSize).toBe(24);
    expect(win1Current.fontFamily).toBe('Consolas, "Lucida Console", monospace');

    // --- 4. Window 1 updates shared connection token ---
    saveSettings({ token: 'updated-token-456' });

    // --- 5. Switch back to Window 2 ---
    switchWindow(2);
    const win2AfterTokenUpdate = loadSettings();
    // Window 2 gets the updated shared token from localStorage
    expect(win2AfterTokenUpdate.token).toBe('updated-token-456');
    // But Window 2 STILL retains its independent 11px font size & Fira Code stack!
    expect(win2AfterTokenUpdate.fontSize).toBe(11);
    expect(win2AfterTokenUpdate.fontFamily).toBe('"Fira Code", monospace');
  });

  it('keeps view settings after the tab is closed and reopened', () => {
    const sharedLocalStorage = new MemoryStorageShim();
    Object.defineProperty(window, 'localStorage', { value: sharedLocalStorage, writable: true });
    Object.defineProperty(window, 'sessionStorage', { value: new MemoryStorageShim(), writable: true });

    saveSettings({ fontSize: 22, toolbarPosition: 'top', vibrateOnKeyPress: false });

    // Closing the tab takes sessionStorage with it; localStorage survives.
    Object.defineProperty(window, 'sessionStorage', { value: new MemoryStorageShim(), writable: true });

    const reopened = loadSettings();
    expect(reopened.fontSize).toBe(22);
    expect(reopened.toolbarPosition).toBe('top');
    expect(reopened.vibrateOnKeyPress).toBe(false);
  });

  it('never writes the relay operator token to localStorage', () => {
    const sharedLocalStorage = new MemoryStorageShim();
    Object.defineProperty(window, 'localStorage', { value: sharedLocalStorage, writable: true });
    Object.defineProperty(window, 'sessionStorage', { value: new MemoryStorageShim(), writable: true });

    saveSettings({ adminToken: 'operator-secret-123456789', fontSize: 20 });

    const persisted = sharedLocalStorage.getItem(LOCAL_STORAGE_KEY) || '';
    expect(persisted).toContain('20');
    expect(persisted).not.toContain('operator-secret-123456789');

    // It still works for the tab it was typed into.
    expect(loadSettings().adminToken).toBe('operator-secret-123456789');
  });

  it('ensures sessionData strictly overrides legacy localStorage view settings once session is initialized', () => {
    // 1. Suppose legacy localStorage contains old font size 18
    localStorage.setItem(
      LOCAL_STORAGE_KEY,
      JSON.stringify({
        token: 'legacy-token',
        fontSize: 18,
        toolbarVisible: false,
      })
    );

    // 2. Window loads and gets initial seed
    const initial = loadSettings();
    expect(initial.fontSize).toBe(18);
    expect(initial.toolbarVisible).toBe(false);

    // 3. User in this window changes font size to 12
    saveSettings({ fontSize: 12, toolbarVisible: true });
    expect(loadSettings().fontSize).toBe(12);
    expect(loadSettings().toolbarVisible).toBe(true);

    // 4. Even if another legacy process or tab rewrites localStorage fontSize:
    const localRaw = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '{}');
    localRaw.fontSize = 22;
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(localRaw));

    // 5. This window's loadSettings MUST honor this session's own 12px (sessionData > localData)
    const current = loadSettings();
    expect(current.fontSize).toBe(12);
    expect(current.toolbarVisible).toBe(true);
  });

  it('sessionStorage failure gracefully falls back to memory storage per session', () => {
    // Break sessionStorage by throwing errors on access
    Object.defineProperty(window, 'sessionStorage', {
      value: {
        getItem: () => {
          throw new Error('SecurityError: sessionStorage is disabled');
        },
        setItem: () => {
          throw new Error('SecurityError: sessionStorage is disabled');
        },
      },
      writable: true,
      configurable: true,
    });

    saveSettings({ fontSize: 19 });
    const loaded = loadSettings();
    expect(loaded.fontSize).toBe(19);
  });
});
