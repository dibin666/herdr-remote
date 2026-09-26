/**
 * Key encoder utility for VT100 / ANSI escape sequences
 */

export const ANSI_KEYS = {
  ESC: '\x1b',
  TAB: '\t',
  SHIFT_TAB: '\x1b[Z',
  ENTER: '\r',
  BACKSPACE: '\x7f',
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  RIGHT: '\x1b[C',
  LEFT: '\x1b[D',
  HOME: '\x1b[H',
  END: '\x1b[F',
  PAGE_UP: '\x1b[5~',
  PAGE_DOWN: '\x1b[6~',
  INSERT: '\x1b[2~',
  DELETE: '\x1b[3~',
  CTRL_C: '\x03',
  CTRL_D: '\x04',
  CTRL_Z: '\x1a',
  CTRL_L: '\x0c',
  CTRL_A: '\x01',
  CTRL_E: '\x05',
  CTRL_K: '\x0b',
  CTRL_R: '\x12',
  CTRL_W: '\x17',
  CTRL_U: '\x15',
  CTRL_X: '\x18',
  CTRL_N: '\x0e',
  CTRL_P: '\x10',
  F1: '\x1bOP',
  F2: '\x1bOQ',
  F3: '\x1bOR',
  F4: '\x1bOS',
  F5: '\x1b[15~',
  F6: '\x1b[17~',
  F7: '\x1b[18~',
  F8: '\x1b[19~',
  F9: '\x1b[20~',
  F10: '\x1b[21~',
  F11: '\x1b[23~',
  F12: '\x1b[24~',
} as const;

const textEncoder = new TextEncoder();

/**
 * Encodes a string into UTF-8 Uint8Array binary frame
 */
export function encodeStringToBytes(str: string): Uint8Array {
  return textEncoder.encode(str);
}

/**
 * Computes the ASCII control code for a letter (A-Z -> 1-26)
 */
export function encodeCtrlKey(char: string): string {
  if (!char || char.length === 0) return '';
  const upper = char.toUpperCase();
  const code = upper.charCodeAt(0);
  if (code >= 65 && code <= 90) {
    // A-Z -> \x01 - \x1a
    return String.fromCharCode(code - 64);
  }
  if (char === '@' || char === ' ') return '\x00';
  if (char === '[') return '\x1b';
  if (char === '\\') return '\x1c';
  if (char === ']') return '\x1d';
  if (char === '^') return '\x1e';
  if (char === '_') return '\x1f';
  if (char === '?') return '\x7f';
  return char;
}

/**
 * Encodes an Alt/Meta key combination (\x1b + char)
 */
export function encodeAltKey(char: string): string {
  return `\x1b${char}`;
}

export interface KeyModifiers {
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/** xterm's modifier parameter: 1 + Shift + 2·Alt + 4·Ctrl. */
function modifierParam({ ctrl, alt, shift }: KeyModifiers): number {
  return 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
}

const CURSOR_KEY = /^\x1b[[O]([ABCDHF])$/;
const PF_KEY = /^\x1bO([PQRS])$/;
const TILDE_KEY = /^\x1b\[(\d+)~$/;

/**
 * Encodes key combination with active modifier latches.
 *
 * Special keys take xterm's modifier parameter (`ESC[1;5D` is Ctrl+Left) or,
 * where xterm has no legacy form, a CSI-u sequence. These are what Herdr was
 * measured to pass through: Shift+Tab as `ESC[Z`, and Shift+Enter as
 * `ESC[13;2u`, which reaches Claude Code as a newline because it asks for
 * enhanced key reporting. A pane that does not ask gets plain Enter from
 * Herdr, as it would from any terminal. Alt alone keeps the ESC prefix, the
 * form every program understands.
 */
export function encodeKeyWithModifiers(key: string, modifiers: KeyModifiers): string {
  const { ctrl = false, alt = false, shift = false } = modifiers;
  if (!ctrl && !alt && !shift) return key;
  const m = modifierParam(modifiers);
  const altOnly = alt && !ctrl && !shift;

  const cursor = CURSOR_KEY.exec(key);
  if (cursor) return `\x1b[1;${m}${cursor[1]}`;
  const pf = PF_KEY.exec(key);
  if (pf) return `\x1b[1;${m}${pf[1]}`;
  const tilde = TILDE_KEY.exec(key);
  if (tilde) return `\x1b[${tilde[1]};${m}~`;

  switch (key) {
    case ANSI_KEYS.TAB:
      if (shift && !ctrl && !alt) return ANSI_KEYS.SHIFT_TAB;
      if (altOnly) return `\x1b${key}`;
      return `\x1b[9;${m}u`;
    case ANSI_KEYS.SHIFT_TAB:
      if (!ctrl && !alt) return key;
      return `\x1b[9;${modifierParam({ ...modifiers, shift: true })}u`;
    case ANSI_KEYS.ENTER:
      if (altOnly) return `\x1b${key}`;
      return `\x1b[13;${m}u`;
    case ANSI_KEYS.BACKSPACE:
      if (ctrl && !alt && !shift) return '\x08';
      if (altOnly) return `\x1b${key}`;
      return `\x1b[127;${m}u`;
    case ANSI_KEYS.ESC:
      if (altOnly) return `\x1b${key}`;
      return `\x1b[27;${m}u`;
  }

  let result = key;

  if (shift && key.length === 1 && !ctrl) {
    result = key.toUpperCase();
  }

  if (ctrl) {
    result = encodeCtrlKey(result);
  }

  if (alt) {
    result = encodeAltKey(result);
  }

  return result;
}

/**
 * One key's worth of input — a character, or a single special-key sequence —
 * which is what a latched modifier on the key bar applies to. A paste or an
 * IME commit is several characters and leaves the latch for the next key.
 */
export function isSingleKey(data: string): boolean {
  if ([...data].length === 1) return true;
  return (
    CURSOR_KEY.test(data) ||
    PF_KEY.test(data) ||
    TILDE_KEY.test(data) ||
    data === ANSI_KEYS.SHIFT_TAB
  );
}
