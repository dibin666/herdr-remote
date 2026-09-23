import { ANSI_KEYS, encodeCtrlKey, encodeKeyWithModifiers, type KeyModifiers } from './keyEncoder';

export interface ParsedKeyStep {
  /** The terminal bytes for the unmodified key. */
  key: string;
  /** The user's normalized key token, retained for readable captions. */
  keyName: string;
  modifiers: KeyModifiers;
  sequence: string;
}

export type KeyComboErrorCode =
  | 'empty'
  | 'tooManySteps'
  | 'invalidStepSyntax'
  | 'duplicateModifier'
  | 'missingKey'
  | 'multipleKeys'
  | 'unsupportedKey';

/** A stable error code lets each UI show validation in its own language. */
export class KeyComboError extends Error {
  readonly code: KeyComboErrorCode;
  readonly params: Record<string, string | number>;

  constructor(code: KeyComboErrorCode, params: Record<string, string | number> = {}) {
    super(code);
    this.name = 'KeyComboError';
    this.code = code;
    this.params = params;
  }
}

const KEY_ALIASES: Record<string, string> = {
  escape: 'esc', return: 'enter', pgup: 'pageup', pgdn: 'pagedown',
  backslash: '\\', plus: '+',
};

const NAMED_KEYS: Record<string, string> = {
  esc: ANSI_KEYS.ESC, tab: ANSI_KEYS.TAB, enter: ANSI_KEYS.ENTER,
  backspace: ANSI_KEYS.BACKSPACE, delete: ANSI_KEYS.DELETE,
  left: ANSI_KEYS.LEFT, right: ANSI_KEYS.RIGHT, up: ANSI_KEYS.UP, down: ANSI_KEYS.DOWN,
  home: ANSI_KEYS.HOME, end: ANSI_KEYS.END, pageup: ANSI_KEYS.PAGE_UP,
  pagedown: ANSI_KEYS.PAGE_DOWN, insert: ANSI_KEYS.INSERT,
  space: ' ', '+': '+',
};

const KEY_CAPTIONS: Record<string, string> = {
  esc: 'ESC', tab: 'TAB', enter: '⏎', backspace: '⌫', delete: 'DEL',
  left: '←', right: '→', up: '↑', down: '↓', home: 'HOME', end: 'END',
  pageup: 'PGUP', pagedown: 'PGDN', insert: 'INS', space: 'SPACE', '+': '+',
};

const SUPER_DIGITS: Record<number, string> = {
  2: '²',
  3: '³',
  4: '⁴',
  5: '⁵',
  6: '⁶',
  7: '⁷',
  8: '⁸',
  9: '⁹',
};

function parseStep(token: string, index: number): ParsedKeyStep {
  const parts = token.toLowerCase().split('+');
  if (parts.some((part) => !part)) throw new KeyComboError('invalidStepSyntax', { step: index + 1 });

  const modifiers: KeyModifiers = {};
  let keyToken: string | undefined;
  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') {
      if (modifiers.ctrl) throw new KeyComboError('duplicateModifier', { step: index + 1, modifier: 'Ctrl' });
      modifiers.ctrl = true;
    } else if (part === 'alt' || part === 'option') {
      if (modifiers.alt) throw new KeyComboError('duplicateModifier', { step: index + 1, modifier: 'Alt' });
      modifiers.alt = true;
    } else if (part === 'shift') {
      if (modifiers.shift) throw new KeyComboError('duplicateModifier', { step: index + 1, modifier: 'Shift' });
      modifiers.shift = true;
    } else if (keyToken === undefined) {
      keyToken = part;
    } else {
      throw new KeyComboError('multipleKeys', { step: index + 1 });
    }
  }

  if (!keyToken) throw new KeyComboError('missingKey', { step: index + 1 });
  const keyName = KEY_ALIASES[keyToken] || keyToken;
  const functionKey = /^f(?:[1-9]|1[0-2])$/.exec(keyName);
  let key: string;
  if (functionKey) {
    key = ANSI_KEYS[keyName.toUpperCase() as keyof typeof ANSI_KEYS];
  } else if (Object.hasOwn(NAMED_KEYS, keyName)) {
    key = NAMED_KEYS[keyName];
  } else if ([...keyName].length === 1 && /^[\x21-\x7e]$/.test(keyName)) {
    key = keyName;
  } else {
    throw new KeyComboError('unsupportedKey', { step: index + 1, key: keyName });
  }

  return { key, keyName, modifiers, sequence: encodeComboKey(key, keyName, modifiers) };
}

function modifierParameter(modifiers: KeyModifiers): number {
  return 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
}

function encodeCsiU(keyName: string, modifiers: KeyModifiers): string {
  const codepoint = [...keyName][0].codePointAt(0);
  if (codepoint === undefined) return '';
  return `\x1b[${codepoint};${modifierParameter(modifiers)}u`;
}

function encodeComboKey(key: string, keyName: string, modifiers: KeyModifiers): string {
  if (!modifiers.ctrl) return encodeKeyWithModifiers(key, modifiers);

  // CSI-u carries the printable letter identity for Ctrl+M/I and modified
  // Ctrl combinations. Their legacy C0 values collide with Enter and Tab, and
  // encodeKeyWithModifiers intentionally treats those bytes as special keys.
  if (keyName.length === 1 && /^[\x20-\x7e]$/.test(keyName)) {
    const lower = keyName.toLowerCase();
    if (modifiers.alt || modifiers.shift || lower === 'm' || lower === 'i') {
      return encodeCsiU(lower, modifiers);
    }
    if (lower === '-' || lower === '/' || lower === '_') return '\x1f';
    const control = encodeCtrlKey(lower);
    if (control !== lower) return control;
    return encodeCsiU(lower, modifiers);
  }

  // Ctrl+Enter, Ctrl+Tab and other special keys use their actual key code with
  // CSI-u, preserving the distinction from the printable Ctrl+M/Ctrl+I keys.
  return encodeKeyWithModifiers(key, modifiers);
}

/** Parse space-separated key steps into the exact byte strings sent to Herdr. */
export function parseKeyCombo(combo: string): string[] {
  if (typeof combo !== 'string' || !combo.trim()) throw new KeyComboError('empty');
  const tokens = combo.trim().split(/\s+/);
  if (tokens.length > 8) throw new KeyComboError('tooManySteps', { count: 8 });
  return tokens.map((token, index) => parseStep(token, index).sequence);
}

/** Render a short keycap caption without losing the order of a multi-step combo. */
export function formatComboCaption(combo: string): string {
  const tokens = combo.trim().split(/\s+/);
  if (tokens.length > 1 && tokens.every((token) => ['esc', 'escape'].includes(token.toLowerCase()))) {
    return `ESC${SUPER_DIGITS[tokens.length] || ` ×${tokens.length}`}`;
  }

  return tokens.map((token, index) => {
    const { keyName, modifiers } = parseStep(token, index);
    const keyCaption = KEY_CAPTIONS[keyName] || (/^f\d+$/.test(keyName) ? keyName.toUpperCase() : keyName.toUpperCase());
    if (modifiers.ctrl && modifiers.alt && modifiers.shift) return `Ctrl+Alt+⇧${keyCaption}`;
    if (modifiers.ctrl && modifiers.alt) return `Ctrl+Alt+${keyCaption}`;
    if (modifiers.ctrl && modifiers.shift) return `^⇧${keyCaption}`;
    if (modifiers.ctrl) return `^${keyCaption}`;
    if (modifiers.alt && modifiers.shift) return `Alt+⇧${keyCaption}`;
    if (modifiers.alt) return `Alt+${keyCaption}`;
    if (modifiers.shift) return `⇧${keyCaption}`;
    return keyCaption;
  }).join(' ');
}
