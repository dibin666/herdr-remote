/**
 * Wheel-report recognition for read-only clients.
 *
 * A viewer holds no control lease and may not type into the terminal, but it
 * may scroll: every client drives its *own* PTY stream, so a wheel report
 * moves only that viewer's own screen. This is the same reasoning that lets a
 * viewer resize its stream without the lease.
 *
 * The relay enforces this rule again on its side — it is the security boundary
 * and does not trust the browser. Keeping the check here too means a viewer's
 * keystroke is dropped locally instead of travelling to the relay just to be
 * denied, so the read-only warning stays accurate and immediate.
 *
 * The match is exact rather than heuristic: a frame is scroll input only when
 * every byte of it belongs to a wheel report.
 */

const ESC = 0x1b;
const LEFT_BRACKET = 0x5b; // [
const LESS_THAN = 0x3c; // <
const SEMICOLON = 0x3b; // ;
const UPPER_M = 0x4d; // M
const ZERO = 0x30;
const NINE = 0x39;

/**
 * The wheel sets bit 64 of the event code; bit 1 is up/down and bits 4/8/16
 * are shift/alt/ctrl. Every other bit belongs to something that is not a
 * wheel: bit 32 marks motion, bits 2 and 128 select other buttons.
 */
const WHEEL_BASE = 64;
const WHEEL_CODE_MASK = ~(1 | 4 | 8 | 16);

/** Single-byte (X10) parameters are biased by 32 and cannot exceed one byte. */
const X10_PARAM_BIAS = 32;
const X10_PARAM_MAX = 255;

function isWheelCode(code: number): boolean {
  return Number.isInteger(code) && (code & WHEEL_CODE_MASK) === WHEEL_BASE;
}

function isDigit(byte: number): boolean {
  return byte >= ZERO && byte <= NINE;
}

function readNumber(bytes: Uint8Array, start: number): { value: number; next: number } | null {
  let index = start;
  let value = 0;
  while (index < bytes.length && isDigit(bytes[index])) {
    value = value * 10 + (bytes[index] - ZERO);
    // A parameter long enough to overflow is not something a terminal emits.
    if (value > 0xffff) return null;
    index += 1;
  }
  if (index === start) return null;
  return { value, next: index };
}

/** Matches `ESC [ < Pb ; Px ; Py M`, the SGR and SGR-pixels encodings. */
function matchSgrWheel(bytes: Uint8Array, start: number): number {
  if (bytes[start] !== ESC || bytes[start + 1] !== LEFT_BRACKET || bytes[start + 2] !== LESS_THAN) {
    return -1;
  }

  const code = readNumber(bytes, start + 3);
  if (!code || !isWheelCode(code.value) || bytes[code.next] !== SEMICOLON) return -1;

  const first = readNumber(bytes, code.next + 1);
  if (!first || bytes[first.next] !== SEMICOLON) return -1;

  const second = readNumber(bytes, first.next + 1);
  if (!second) return -1;

  // A wheel is never released, so the terminator is always `M`. Accepting `m`
  // here would admit button releases, which are not scrolling.
  if (bytes[second.next] !== UPPER_M) return -1;
  return second.next + 1;
}

/** Matches `ESC [ M Pb Px Py`, the default single-byte encoding. */
function matchX10Wheel(bytes: Uint8Array, start: number): number {
  if (bytes[start] !== ESC || bytes[start + 1] !== LEFT_BRACKET || bytes[start + 2] !== UPPER_M) {
    return -1;
  }
  if (start + 6 > bytes.length) return -1;

  const code = bytes[start + 3] - X10_PARAM_BIAS;
  const column = bytes[start + 4];
  const row = bytes[start + 5];
  if (!isWheelCode(code)) return -1;
  if (column < X10_PARAM_BIAS || column > X10_PARAM_MAX) return -1;
  if (row < X10_PARAM_BIAS || row > X10_PARAM_MAX) return -1;
  return start + 6;
}

/** Whether every byte of the payload belongs to a wheel report. */
export function isWheelOnlyInput(payload: Uint8Array | ArrayBuffer | null | undefined): boolean {
  if (!payload) return false;
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (bytes.length === 0) return false;

  let offset = 0;
  while (offset < bytes.length) {
    const sgr = matchSgrWheel(bytes, offset);
    if (sgr > offset) {
      offset = sgr;
      continue;
    }
    const x10 = matchX10Wheel(bytes, offset);
    if (x10 > offset) {
      offset = x10;
      continue;
    }
    return false;
  }
  return true;
}
