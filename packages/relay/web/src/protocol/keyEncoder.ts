/**
 * Key encoder utility for VT100 / ANSI escape sequences
 */

export const ANSI_KEYS = {
  ESC: '\x1b',
  TAB: '\t',
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

/**
 * Encodes key combination with active modifier latches
 */
export function encodeKeyWithModifiers(
  key: string,
  modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean }
): string {
  let result = key;

  if (modifiers.shift && key.length === 1 && !modifiers.ctrl) {
    result = key.toUpperCase();
  }

  if (modifiers.ctrl) {
    result = encodeCtrlKey(result);
  }

  if (modifiers.alt) {
    result = encodeAltKey(result);
  }

  return result;
}
