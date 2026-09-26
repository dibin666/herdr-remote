// The shapes the predictor works with: the slice of xterm's buffer API it
// reads (so tests can use mock terminals), the field it types into, what it
// hands the overlay, and the few ways it reads cells.

import type { CellStyle } from '../render/cell';

/**
 * Minimal read-only interface required by PredictiveEcho.
 * Intentionally decoupled from @xterm/xterm to allow unit testing with mock terminals.
 */
export interface PredictionCell {
  getChars(): string;
  getWidth?(): number;
}

export interface PredictionLine {
  getCell(col: number): PredictionCell | undefined;
}

export interface PredictionBufferActive {
  baseY: number;
  cursorX: number;
  cursorY: number;
  getLine(row: number): PredictionLine | undefined;
}

export interface PredictionTerminal {
  cols: number;
  rows: number;
  buffer: {
    active: PredictionBufferActive;
  };
}

/**
 * The stretch of one row that typed characters land in, as found by the
 * input-field detector. Confidence is earned per field: an echo confirmed in
 * Claude's input box says nothing about the menu that opens next to it.
 */
export interface PredictionField {
  key: string;
  /** Absolute row and column of the caret. */
  row: number;
  caretCol: number;
  /** First editable column on the caret row. */
  startCol: number;
  /** One past the last column text can occupy. */
  endCol: number;
  empty: boolean;
  agentLike: boolean;
  /** Changes when the field's rows shift, e.g. a box growing upwards as its text wraps. */
  layout?: string;
  /**
   * The field has shown a vim-style `-- INSERT --` line, so a lone Escape
   * leaves insert mode and the keys after it are commands.
   */
  modal?: boolean;
}

export interface PredictiveEchoOptions {
  getTerminal: () => PredictionTerminal | null;
  /**
   * The input field under the caret, or null when the caret is not in one —
   * in which case nothing is predicted. Without this option every row counts
   * as a field that starts at the caret.
   */
  getField?: () => PredictionField | null;
  /**
   * The cell width the terminal gives a character (xterm's wcwidth). Used as
   * a guess for characters whose width the layers may disagree on.
   */
  charWidth?: (codePoint: number) => number;
  now?: () => number;
}

export interface ResetOptions {
  /** Hold new predictions until the caret moves (default true). */
  suppress?: boolean;
  /** Drop the field's confidence, so it must see a fresh echo before predictions show again. */
  demote?: boolean;
}

export type PredictiveEchoState = 'tentative' | 'confident';

export interface VisiblePrediction {
  row: number;
  col: number;
  char: string;
}

/**
 * What the overlay draws: typed characters, cells a backspace is about to
 * clear, and where the caret will be once the echo arrives.
 */
export interface OverlayItem {
  row: number;
  col: number;
  char: string;
  width: 1 | 2;
  kind: 'char' | 'erase' | 'caret' | 'mask';
  /**
   * How the program draws typed text in this field, learned from an echo it
   * sent back, so a predicted cell looks exactly like the echo that replaces
   * it. Absent until the field has echoed something.
   */
  style?: CellStyle;
}

/** One decision of the predictor, kept for the `?debug=1` overlay. */
export interface PredictionTraceEntry {
  at: number;
  event: string;
  count: number;
}

export interface PendingPrediction {
  row: number;
  col: number;
  char: string;
  width: 1 | 2;
  kind: 'char' | 'erase';
  /** What the cell may still show while the echo is in flight. */
  before: string[];
  sentAt: number;
  /** A pending erase of the same cell that this character was typed over. */
  replaces?: PendingPrediction;
  /**
   * Set once a key the predictor cannot follow (Enter, an arrow, a click) was
   * sent after this one: where the server's caret was at that moment. The
   * prediction stays on screen until its echo lands, but the run is over.
   */
  frozenFrom?: { row: number; col: number };
  /** Whether it was on screen when frozen; a later demotion does not take it back. */
  shownWhenFrozen?: boolean;
  /**
   * The server drew this character before its caret moved past the cell.
   * It counts as confirmed, and stays painted until the caret passes: until
   * then the program may still restyle the cell (fish draws its dim
   * autosuggestion there first).
   */
  echoed?: boolean;
  /**
   * Typed after keys that were refused while the predictor was suppressed,
   * which may still be in flight: its position is a guess. It stays hidden
   * until one of its run is confirmed, and a wrong guess is dropped quietly.
   */
  probation?: boolean;
}

export function normalizeBlank(chars: string): string {
  return chars === '' || chars === ' ' ? ' ' : chars;
}

/** Up to `limit` characters drawn just before `col` on `row`, oldest first. */
export function charsBefore(
  terminal: PredictionTerminal,
  row: number,
  col: number,
  limit = 64,
): string[] {
  const line = terminal.buffer.active.getLine(row);
  const chars: string[] = [];
  for (let x = col - 1; x >= 0 && chars.length < limit; x--) {
    const cell = line?.getCell(x);
    if (!cell) break;
    if (cell.getWidth?.() === 0) continue;
    chars.unshift(normalizeBlank(cell.getChars()));
  }
  return chars;
}

/**
 * How many of the keys in flight the server has already drawn: the longest
 * start of `sent` that the text before the caret ends with.
 */
export function echoedPrefix(sent: ReadonlyArray<string>, before: ReadonlyArray<string>): number {
  for (let length = Math.min(sent.length, before.length); length > 0; length--) {
    let equal = true;
    for (let i = 0; i < length && equal; i++) {
      equal = before[before.length - length + i] === normalizeBlank(sent[i]);
    }
    if (equal) return length;
  }
  return 0;
}

export function legacyField(terminal: PredictionTerminal): PredictionField {
  const active = terminal.buffer.active;
  return {
    key: 'legacy',
    row: active.baseY + active.cursorY,
    caretCol: active.cursorX,
    // Where the input starts is unknown, so text the server drew is never erased.
    startCol: active.cursorX,
    endCol: terminal.cols,
    empty: false,
    agentLike: false,
  };
}
