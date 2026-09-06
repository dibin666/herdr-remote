import { ANSI_KEYS } from '../protocol/keyEncoder';

export interface ToolbarKeyDef {
  id: string;
  label: string;
  code: string;
  type: 'modifier' | 'key' | 'chord' | 'symbol' | 'fn' | 'drawer';
  enabled: boolean;
  title?: string;
  modifierType?: 'ctrl' | 'alt' | 'shift' | 'meta';
  drawerType?: 'fn' | 'chords' | 'symbols';
  isPlainChar?: boolean;
}

export const DEFAULT_TOOLBAR_KEYS: ToolbarKeyDef[] = [
  { id: 'esc', label: 'ESC', code: ANSI_KEYS.ESC, type: 'key', enabled: true, title: 'Escape' },
  { id: 'tab', label: 'TAB', code: ANSI_KEYS.TAB, type: 'key', enabled: true, title: 'Tab' },
  { id: 'ctrl', label: 'CTRL', code: '', type: 'modifier', enabled: true, modifierType: 'ctrl', title: 'Toggle Ctrl modifier latch' },
  { id: 'alt', label: 'ALT', code: '', type: 'modifier', enabled: true, modifierType: 'alt', title: 'Toggle Alt modifier latch' },
  { id: 'left', label: '←', code: ANSI_KEYS.LEFT, type: 'key', enabled: true, title: 'Arrow Left' },
  { id: 'up', label: '↑', code: ANSI_KEYS.UP, type: 'key', enabled: true, title: 'Arrow Up' },
  { id: 'down', label: '↓', code: ANSI_KEYS.DOWN, type: 'key', enabled: true, title: 'Arrow Down' },
  { id: 'right', label: '→', code: ANSI_KEYS.RIGHT, type: 'key', enabled: true, title: 'Arrow Right' },
  { id: 'enter', label: 'Enter', code: ANSI_KEYS.ENTER, type: 'key', enabled: true, title: 'Enter / Return' },
  { id: 'drawer_chords', label: '^C', code: '', type: 'drawer', enabled: true, drawerType: 'chords', title: 'Quick Ctrl Chords' },
  { id: 'drawer_symbols', label: '~|/', code: '', type: 'drawer', enabled: true, drawerType: 'symbols', title: 'Special Symbols' },
  { id: 'drawer_fn', label: 'Fn', code: '', type: 'drawer', enabled: true, drawerType: 'fn', title: 'Function Keys (F1-F12)' },
];

export const ALL_AVAILABLE_KEYS: ToolbarKeyDef[] = [
  // Modifiers
  { id: 'ctrl', label: 'CTRL', code: '', type: 'modifier', enabled: true, modifierType: 'ctrl', title: 'Toggle Ctrl modifier latch' },
  { id: 'alt', label: 'ALT', code: '', type: 'modifier', enabled: true, modifierType: 'alt', title: 'Toggle Alt modifier latch' },
  { id: 'shift', label: 'SHIFT', code: '', type: 'modifier', enabled: true, modifierType: 'shift', title: 'Toggle Shift modifier latch' },
  { id: 'meta', label: 'META', code: '\x1b', type: 'modifier', enabled: true, modifierType: 'meta', title: 'Meta / Cmd key' },
  
  // Navigation & Control
  { id: 'esc', label: 'ESC', code: ANSI_KEYS.ESC, type: 'key', enabled: true, title: 'Escape' },
  { id: 'tab', label: 'TAB', code: ANSI_KEYS.TAB, type: 'key', enabled: true, title: 'Tab' },
  { id: 'enter', label: 'Enter', code: ANSI_KEYS.ENTER, type: 'key', enabled: true, title: 'Enter / Return' },
  { id: 'backspace', label: '⌫', code: ANSI_KEYS.BACKSPACE, type: 'key', enabled: true, title: 'Backspace' },
  { id: 'delete', label: 'Del', code: ANSI_KEYS.DELETE, type: 'key', enabled: true, title: 'Delete' },
  { id: 'left', label: '←', code: ANSI_KEYS.LEFT, type: 'key', enabled: true, title: 'Arrow Left' },
  { id: 'up', label: '↑', code: ANSI_KEYS.UP, type: 'key', enabled: true, title: 'Arrow Up' },
  { id: 'down', label: '↓', code: ANSI_KEYS.DOWN, type: 'key', enabled: true, title: 'Arrow Down' },
  { id: 'right', label: '→', code: ANSI_KEYS.RIGHT, type: 'key', enabled: true, title: 'Arrow Right' },
  { id: 'home', label: 'Home', code: ANSI_KEYS.HOME, type: 'key', enabled: true, title: 'Home' },
  { id: 'end', label: 'End', code: ANSI_KEYS.END, type: 'key', enabled: true, title: 'End' },
  { id: 'page_up', label: 'PgUp', code: ANSI_KEYS.PAGE_UP, type: 'key', enabled: true, title: 'Page Up' },
  { id: 'page_down', label: 'PgDn', code: ANSI_KEYS.PAGE_DOWN, type: 'key', enabled: true, title: 'Page Down' },
  { id: 'insert', label: 'Ins', code: ANSI_KEYS.INSERT, type: 'key', enabled: true, title: 'Insert' },

  // Quick Chords
  { id: 'ctrl_c', label: '^C', code: ANSI_KEYS.CTRL_C, type: 'chord', enabled: true, title: 'Ctrl+C (SIGINT)' },
  { id: 'ctrl_d', label: '^D', code: ANSI_KEYS.CTRL_D, type: 'chord', enabled: true, title: 'Ctrl+D (EOF/Exit)' },
  { id: 'ctrl_z', label: '^Z', code: ANSI_KEYS.CTRL_Z, type: 'chord', enabled: true, title: 'Ctrl+Z (SIGTSTP)' },
  { id: 'ctrl_l', label: '^L', code: ANSI_KEYS.CTRL_L, type: 'chord', enabled: true, title: 'Ctrl+L (Clear Screen)' },
  { id: 'ctrl_a', label: '^A', code: ANSI_KEYS.CTRL_A, type: 'chord', enabled: true, title: 'Ctrl+A (Beginning of Line)' },
  { id: 'ctrl_e', label: '^E', code: ANSI_KEYS.CTRL_E, type: 'chord', enabled: true, title: 'Ctrl+E (End of Line)' },
  { id: 'ctrl_k', label: '^K', code: ANSI_KEYS.CTRL_K, type: 'chord', enabled: true, title: 'Ctrl+K (Kill to End)' },
  { id: 'ctrl_r', label: '^R', code: ANSI_KEYS.CTRL_R, type: 'chord', enabled: true, title: 'Ctrl+R (Reverse Search)' },

  // Function Keys
  { id: 'f1', label: 'F1', code: ANSI_KEYS.F1, type: 'fn', enabled: true, title: 'F1' },
  { id: 'f2', label: 'F2', code: ANSI_KEYS.F2, type: 'fn', enabled: true, title: 'F2' },
  { id: 'f3', label: 'F3', code: ANSI_KEYS.F3, type: 'fn', enabled: true, title: 'F3' },
  { id: 'f4', label: 'F4', code: ANSI_KEYS.F4, type: 'fn', enabled: true, title: 'F4' },
  { id: 'f5', label: 'F5', code: ANSI_KEYS.F5, type: 'fn', enabled: true, title: 'F5' },
  { id: 'f6', label: 'F6', code: ANSI_KEYS.F6, type: 'fn', enabled: true, title: 'F6' },
  { id: 'f7', label: 'F7', code: ANSI_KEYS.F7, type: 'fn', enabled: true, title: 'F7' },
  { id: 'f8', label: 'F8', code: ANSI_KEYS.F8, type: 'fn', enabled: true, title: 'F8' },
  { id: 'f9', label: 'F9', code: ANSI_KEYS.F9, type: 'fn', enabled: true, title: 'F9' },
  { id: 'f10', label: 'F10', code: ANSI_KEYS.F10, type: 'fn', enabled: true, title: 'F10' },
  { id: 'f11', label: 'F11', code: ANSI_KEYS.F11, type: 'fn', enabled: true, title: 'F11' },
  { id: 'f12', label: 'F12', code: ANSI_KEYS.F12, type: 'fn', enabled: true, title: 'F12' },

  // Drawers
  { id: 'drawer_chords', label: '^C', code: '', type: 'drawer', enabled: true, drawerType: 'chords', title: 'Quick Ctrl Chords' },
  { id: 'drawer_symbols', label: '~|/', code: '', type: 'drawer', enabled: true, drawerType: 'symbols', title: 'Special Symbols' },
  { id: 'drawer_fn', label: 'Fn', code: '', type: 'drawer', enabled: true, drawerType: 'fn', title: 'Function Keys (F1-F12)' },

  // Frequent Terminal Symbols
  { id: 'sym_pipe', label: '|', code: '|', type: 'symbol', enabled: true, isPlainChar: true, title: 'Pipe (|)' },
  { id: 'sym_tilde', label: '~', code: '~', type: 'symbol', enabled: true, isPlainChar: true, title: 'Tilde (~)' },
  { id: 'sym_slash', label: '/', code: '/', type: 'symbol', enabled: true, isPlainChar: true, title: 'Slash (/)' },
  { id: 'sym_backslash', label: '\\', code: '\\', type: 'symbol', enabled: true, isPlainChar: true, title: 'Backslash (\\)' },
  { id: 'sym_dash', label: '-', code: '-', type: 'symbol', enabled: true, isPlainChar: true, title: 'Dash (-)' },
  { id: 'sym_underscore', label: '_', code: '_', type: 'symbol', enabled: true, isPlainChar: true, title: 'Underscore (_)' },
  { id: 'sym_dollar', label: '$', code: '$', type: 'symbol', enabled: true, isPlainChar: true, title: 'Dollar ($)' },
  { id: 'sym_ampersand', label: '&', code: '&', type: 'symbol', enabled: true, isPlainChar: true, title: 'Ampersand (&)' },
  { id: 'sym_quote', label: '"', code: '"', type: 'symbol', enabled: true, isPlainChar: true, title: 'Double Quote (")' },
  { id: 'sym_backtick', label: '`', code: '`', type: 'symbol', enabled: true, isPlainChar: true, title: 'Backtick (`)' },
];

export function getDefaultVirtualKeys(): ToolbarKeyDef[] {
  return JSON.parse(JSON.stringify(DEFAULT_TOOLBAR_KEYS));
}

export function sanitizeVirtualKeys(keys: unknown): ToolbarKeyDef[] {
  if (!Array.isArray(keys) || keys.length === 0) {
    return getDefaultVirtualKeys();
  }
  return keys.filter(
    (k) =>
      typeof k === 'object' &&
      k !== null &&
      typeof k.id === 'string' &&
      typeof k.label === 'string' &&
      typeof k.code === 'string'
  );
}

export function getLocalizedKeyTitle(
  key: { id: string; title?: string; label: string },
  t?: (key: string, params?: Record<string, string | number>) => string
): string {
  if (t) {
    const keyPath = `keyTitles.${key.id}`;
    const translated = t(keyPath);
    if (translated && translated !== keyPath) {
      return translated;
    }
  }
  return key.title || key.label;
}
