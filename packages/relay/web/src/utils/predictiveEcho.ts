import { classifyInput, isLoneEscape } from './inputClassifier';
import { predictableWidth } from './wideChars';
import { readCellStyle, type CellStyle } from '../render/cell';

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

interface PendingPrediction {
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

/** Herdr's prefix key: whatever follows goes to Herdr, not to the pane. */
const HERDR_PREFIX = 0x02;
/**
 * Keys an agent reads as a mode switch when they are the first thing typed
 * into an empty box: Claude opens help on `?` and enters shell mode on `!`,
 * turning the prompt glyph into `!` instead of inserting it.
 */
const MODE_SWITCH_FIRST_KEYS = '?!#';
/** Fields whose confidence is remembered, so hopping between two panes does not re-learn each time. */
const MAX_CONFIDENT_FIELDS = 8;
/** Predictions without any server feedback for this long are dropped; stretched on slow links. */
const MIN_PREDICTION_TIMEOUT_MS = 1500;
const MAX_PREDICTION_TIMEOUT_MS = 4000;
const TRACE_LENGTH = 20;

function normalizeBlank(chars: string): string {
  return chars === '' || chars === ' ' ? ' ' : chars;
}

/** Up to `limit` characters drawn just before `col` on `row`, oldest first. */
function charsBefore(terminal: PredictionTerminal, row: number, col: number, limit = 64): string[] {
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

function legacyField(terminal: PredictionTerminal): PredictionField {
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

/**
 * Predictive local echo state machine inspired by Mosh.
 *
 * Remote terminal connections through relays can suffer from round-trip latencies
 * of 150ms or more. Typing feels sluggish unless characters are rendered speculatively
 * before the round trip completes.
 *
 * To guarantee that the user never sees phantom characters or corrupted screens:
 * 1. Nothing is predicted unless the caret sits in an input field.
 * 2. Predictions in a field stay invisible until one of them has been confirmed by
 *    authentic server output in that same field.
 * 3. A prediction is settled once the server's caret has moved past it: the cell
 *    then either shows the predicted character, or the prediction was wrong. A
 *    wrong prediction wipes all pending ones and demotes the field again. Until
 *    it is settled, whatever the cell shows is the program still at work: a
 *    redraw in between is not a verdict.
 */
export class PredictiveEcho {
  private readonly getTerminal: () => PredictionTerminal | null;
  private readonly getFieldOption: (() => PredictionField | null) | undefined;
  private readonly charWidth: ((codePoint: number) => number) | undefined;
  private readonly now: () => number;
  private readonly textDecoder = new TextDecoder('utf-8');

  private readonly confidentKeys = new Set<string>();
  /** How each field draws typed text, learned from its echoes. */
  private readonly fieldStyles = new Map<string, CellStyle>();
  private field: PredictionField | null = null;
  /** Whether the current run began in an empty field, whose placeholder the first key clears. */
  private runStartedEmpty = false;
  private predictions: PendingPrediction[] = [];
  private predictedCursor: { row: number; col: number } | null = null;
  private srtt: number | null = null;
  private isSuppressed = false;
  private suppressCursor: { row: number; col: number } | null = null;
  private suppressSentAt = 0;
  /**
   * Text sent to the server without a prediction tracking where it lands:
   * keys refused while suppressed, and the keys of a probation run found to
   * be in the wrong place. It is on its way to the caret, so the next run
   * starts after whatever part of it the server has not drawn yet.
   */
  private inFlight: string[] = [];
  /** A backspace went out untracked: how much of `inFlight` survives is unknown. */
  private inFlightUnknown = false;
  /** The part of `inFlight` the current run was placed after, in case that guess was wrong. */
  private runInFlight: string[] = [];
  /** The current run is on probation until one of its guesses is confirmed. */
  private probationRun = false;
  /** Every key sent since the run went on probation, drawn or not, in order. */
  private runSent: string[] = [];
  /** The last key of the run went out undrawn, so no prediction will tell when it has landed. */
  private lastSentUndrawn = false;
  private awaitingPrefixCommand = false;
  private mismatches = 0;
  private readonly trace: PredictionTraceEntry[] = [];

  constructor(options: PredictiveEchoOptions) {
    this.getTerminal = options.getTerminal;
    this.getFieldOption = options.getField;
    this.charWidth = options.charWidth;
    this.now =
      options.now ??
      (typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? () => performance.now()
        : () => Date.now());
  }

  /**
   * Called on user keystrokes before bytes are dispatched to the server.
   */
  handleUserInput(bytes: Uint8Array): void {
    this.pruneExpired();

    if (bytes.length === 0) {
      return;
    }

    const text = this.textDecoder.decode(bytes, { stream: false });
    if (!text) {
      return;
    }

    // Hover and focus reports and terminal replies are not edits. Herdr asks
    // for any-motion mouse reports, so these arrive whenever the pointer moves.
    const inputClass = classifyInput(text);
    if (inputClass === 'passive') {
      return;
    }
    if (inputClass === 'pointer') {
      this.freeze('pointer');
      return;
    }

    if (this.awaitingPrefixCommand) {
      this.awaitingPrefixCommand = false;
      this.freeze('Herdr prefix command', { demote: true });
      return;
    }

    // A bare Escape is how vim-style editors, Claude Code's included, leave
    // insert mode; the keys that follow are commands until an echo says
    // otherwise. Without vim mode it only interrupts or clears, and the field
    // is as trustworthy as it was.
    if (isLoneEscape(text)) {
      const field = this.field ?? this.getFieldOption?.() ?? null;
      this.freeze('escape', { demote: !field || field.modal !== false });
      return;
    }

    const terminal = this.getTerminal();
    if (!terminal) {
      this.reset('terminal unavailable', true);
      return;
    }

    const chars = Array.from(text);
    for (let index = 0; index < chars.length; index++) {
      const char = chars[index];
      const codePoint = char.codePointAt(0);
      if (codePoint === undefined) {
        continue;
      }

      if (codePoint === HERDR_PREFIX) {
        this.awaitingPrefixCommand = true;
        this.freeze('Herdr prefix', { demote: true });
        return;
      }

      // Fast-reject any ESC sequence, CSI control sequence, enter, tab, or control key.
      // Remote terminal applications frequently alter screen layout or cursor coordinates
      // in response to control keys (e.g. carriage return moves cursor to col 0, tab expands
      // to unknown spaces, arrow keys navigate ncurses menus). Speculating across them is unsafe.
      if (
        codePoint === 0x1b ||
        codePoint === 0x09 ||
        codePoint === 0x0a ||
        codePoint === 0x0d ||
        (codePoint < 0x20 && codePoint !== 0x08)
      ) {
        this.freeze('control or escape sequence');
        return;
      }

      // Backspace: 0x08 (BS) or 0x7f (DEL)
      if (codePoint === 0x08 || codePoint === 0x7f) {
        if (!this.handleBackspace(terminal)) {
          return;
        }
        continue;
      }

      if (this.stillSuppressed()) {
        // The key still goes out, so the caret has it to come; so does the
        // rest of this chunk (an IME commit, a fast burst).
        this.inFlight.push(char);
        this.note('refused: waiting for the caret to move');
        continue;
      }

      // Only characters whose cell width every layer agrees on are drawn;
      // see wideChars.ts. Anything else is sent undrawn, and the run goes on
      // after it on a guess.
      const width = predictableWidth(codePoint);
      if (width === 0) {
        if (!this.skipUnpredictable(char, codePoint, terminal)) {
          if (index < chars.length - 1) this.inFlightUnknown = true;
          return;
        }
        continue;
      }

      if (!this.handlePrintable(char, width, terminal)) {
        // The rest of the chunk goes out behind a key that ended the run.
        if (index < chars.length - 1) this.inFlightUnknown = true;
        return;
      }
    }
  }

  /**
   * Called after server output has been written to the terminal and parsed.
   * Compares the actual buffer cells against pending predictions.
   */
  onServerOutput(): void {
    const terminal = this.getTerminal();
    const caret = terminal
      ? {
          row: terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
          col: terminal.buffer.active.cursorX,
        }
      : null;

    this.pruneExpired();
    if (terminal && caret && this.predictions.length > 0) {
      this.settle(terminal, caret);
    }
    this.updateSuppression(caret);
  }

  /**
   * Suppression ends when the key that caused it has visibly done something.
   *
   * In full-screen TUIs like Herdr, background output (status bar, clocks,
   * spinners) arrives constantly without meaning the program has processed
   * Enter or an arrow key, so only the caret moving counts. And on a slow link
   * the caret keeps moving for a while as the keys typed *before* that one are
   * echoed: that is not the key's doing either. So the caret must first reach
   * where those keys leave it, and then move from there.
   */
  private updateSuppression(caret: { row: number; col: number } | null): void {
    if (!this.isSuppressed) return;
    if (this.predictions.some((p) => p.frozenFrom)) {
      // Earlier keys are still landing; the safety timeout starts once they have.
      this.suppressSentAt = this.now();
      return;
    }
    const moved =
      !!caret &&
      !!this.suppressCursor &&
      (caret.row !== this.suppressCursor.row || caret.col !== this.suppressCursor.col);
    if (moved) {
      this.liftSuppression();
    } else {
      this.stillSuppressed();
    }
  }

  /** Compares the pending predictions against what the server has drawn. */
  private settle(terminal: PredictionTerminal, caret: { row: number; col: number }): void {
    // The field the predictions were typed into must still be under the caret.
    // If it closed or became something else, whatever the server drew there
    // was not an echo.
    const field = this.field;
    if (this.getFieldOption) {
      const current = this.getFieldOption();
      if (!current || current.key !== field?.key) {
        if (this.predictions.every((p) => p.frozenFrom || p.echoed)) {
          // The key sent after them took the caret elsewhere, and their echo
          // was drawn before that; nothing was mispredicted.
          this.predictions = [];
          this.predictedCursor = null;
          return;
        }
        this.mismatch('field changed');
        return;
      }
      if (current.layout !== field.layout) {
        // The text reflowed (Claude's box grows upwards when a line wraps) and
        // the server has already drawn it in its new place. The run ends;
        // the field is as trustworthy as it was.
        this.predictions = [];
        this.predictedCursor = null;
        this.field = current;
        this.note('layout changed');
        return;
      }
    }

    const remaining: PendingPrediction[] = [];

    for (const p of this.predictions) {
      const cell = terminal.buffer.active.getLine(p.row)?.getCell(p.col);
      const actual = normalizeBlank(cell ? cell.getChars() : '');
      const matches =
        p.kind === 'char'
          ? actual === p.char && (p.width === 1 || (cell?.getWidth?.() ?? 2) === 2)
          : actual === ' ';
      // The server has processed a keystroke once its caret has moved past
      // the cell that keystroke affects.
      const settled =
        p.kind === 'char'
          ? caret.row > p.row || (caret.row === p.row && caret.col >= p.col + p.width)
          : caret.row < p.row || (caret.row === p.row && caret.col <= p.col);
      const unchanged = p.before.includes(actual);
      // The character arrived, one cell wide where two were predicted (or
      // the reverse): that is a verdict, whether or not the caret has passed.
      const wrongWidth = p.kind === 'char' && actual === p.char && !matches;

      if (p.echoed && !matches) {
        // The server drew it, then drew something else before its caret
        // passed (a backspace it has processed, a redraw): stop painting it.
        continue;
      }
      if (matches && (settled || !unchanged)) {
        if (!p.echoed) this.confirm(p, field);
        if (settled) {
          // Settled: what the cell shows now is how the program draws typed text.
          if (p.kind === 'char' && field && !p.frozenFrom) this.learnStyle(field.key, cell);
          continue;
        }
        p.echoed = true;
        remaining.push(p);
      } else if (p.frozenFrom) {
        // Kept while the server is still working through the keys typed before
        // the freeze. Once its caret has gone back (Ctrl+U, Home), to another
        // row (Enter), or past without echoing this, it simply goes.
        const from = p.frozenFrom;
        if (!settled && caret.row === from.row && caret.col >= from.col) {
          remaining.push(p);
        } else if (settled && p.probation) {
          // Placed after a guessed width that was wrong: the caret the frozen
          // run was expected to leave behind is wrong too.
          this.inFlightUnknown = true;
        }
      } else if (!settled && !wrongWidth) {
        // Not echoed yet, or the program is midway through redrawing the
        // line. When the typed character equals what the cell already held,
        // only the caret moving past it can tell the two apart.
        remaining.push(p);
      } else if (p.probation) {
        // A guess placed while earlier keys were still in flight: wrong, but
        // never shown. Its keys went out all the same: they join what is in
        // flight, and the next run is placed after them again.
        this.note('probation guess dropped');
        if (this.predictions.some((q) => !q.frozenFrom && q.kind === 'erase'))
          this.inFlightUnknown = true;
        this.inFlight = [...this.runInFlight, ...this.runSent, ...this.inFlight];
        this.runInFlight = [];
        this.runSent = [];
        this.probationRun = false;
        this.predictions = this.predictions.filter((q) => q.frozenFrom);
        this.predictedCursor = null;
        return;
      } else {
        // Prediction error: remote host displayed something different (e.g. password masking,
        // modal vim mode, auto-completion, or a word wrapped onto the next row).
        this.mismatch(`cell shows ${JSON.stringify(actual)} for ${JSON.stringify(p.char)}`);
        return;
      }
    }

    this.predictions = remaining;
    if (remaining.length === 0) {
      this.predictedCursor = null;
    }
  }

  /**
   * Resets internal pending predictions and cursor.
   * Called on control keys, resizes, screen switches, reconnects, pastes, and scrolls.
   * Defaults to suppressing new predictions until the caret moves; `demote`
   * also withdraws the current field's confidence.
   */
  reset(reason?: string, options?: ResetOptions | boolean): void {
    this.predictions = [];
    this.predictedCursor = null;

    const shouldSuppress = typeof options === 'boolean' ? options : (options?.suppress ?? true);
    const shouldDemote = typeof options === 'object' && options?.demote === true;
    this.note(`reset: ${reason ?? 'unspecified'}`);

    if (shouldDemote) {
      const field = this.field ?? this.getFieldOption?.() ?? null;
      if (field) {
        this.confidentKeys.delete(field.key);
      }
    }

    this.forgetInFlight();
    if (shouldSuppress) {
      this.isSuppressed = true;
      this.suppressSentAt = this.now();
      const terminal = this.getTerminal();
      if (terminal) {
        this.suppressCursor = {
          row: terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
          col: terminal.buffer.active.cursorX,
        };
      } else {
        this.suppressCursor = null;
      }
    } else {
      this.isSuppressed = false;
      this.suppressCursor = null;
    }
  }

  /** Forgets every field's confidence, for when the screen is replaced wholesale. */
  forgetConfidence(): void {
    this.confidentKeys.clear();
    this.fieldStyles.clear();
    this.field = null;
  }

  /**
   * Returns predictions currently eligible for rendering.
   * Returns empty array when in tentative state to guarantee zero false visual echoes.
   */
  getVisiblePredictions(): ReadonlyArray<VisiblePrediction> {
    this.pruneExpired();

    return this.visiblePredictions()
      .filter((p) => !p.echoed)
      .map((p) => ({
        row: p.row,
        col: p.col,
        char: p.char,
      }));
  }

  /**
   * Everything the overlay should draw: the pending predictions, a caret where
   * the next character will land, and — the server's caret being a round trip
   * behind — a plain redraw of the cell under the server's caret, so a caret a
   * program paints itself (Claude does) does not trail behind the text. When
   * the first key goes into an empty agent box, the placeholder after it is
   * cleared the way the program will clear it.
   */
  getOverlayItems(): ReadonlyArray<OverlayItem> {
    this.pruneExpired();

    const visible = this.visiblePredictions();
    if (visible.length === 0) {
      return [];
    }

    const style = this.field ? this.fieldStyles.get(this.field.key) : undefined;
    const items: OverlayItem[] = visible.map((p) => {
      const item: OverlayItem = {
        row: p.row,
        col: p.col,
        char: p.char,
        width: p.width,
        kind: p.kind,
      };
      if (style) item.style = style;
      return item;
    });

    // Where the next character will land: the live run's cursor, or after a
    // freeze, the end of what is still shown.
    const last = visible[visible.length - 1];
    const next = this.predictedCursor ?? {
      row: last.row,
      col: last.kind === 'erase' ? last.col : last.col + last.width,
    };
    const covers = (row: number, col: number) =>
      items.some((p) => p.row === row && p.col <= col && col < p.col + p.width);

    const terminal = this.getTerminal();
    const active = terminal?.buffer.active;

    // The placeholder of an empty agent box goes with the first key typed.
    const field = this.field;
    if (active && field && this.runStartedEmpty && field.agentLike && next.row === field.row) {
      const line = active.getLine(next.row);
      for (let col = next.col; col < field.endCol; col++) {
        if (covers(next.row, col)) continue;
        if (normalizeBlank(line?.getCell(col)?.getChars() ?? '') === ' ') continue;
        const item: OverlayItem = { row: next.row, col, char: ' ', width: 1, kind: 'erase' };
        if (style) item.style = style;
        items.push(item);
      }
    }

    if (active) {
      const server = { row: active.baseY + active.cursorY, col: active.cursorX };
      if (!covers(server.row, server.col) && (server.row !== next.row || server.col !== next.col)) {
        const chars = active.getLine(server.row)?.getCell(server.col)?.getChars() ?? '';
        const item: OverlayItem = {
          row: server.row,
          col: server.col,
          char: normalizeBlank(chars),
          width: 1,
          kind: 'mask',
        };
        if (style) item.style = style;
        items.push(item);
      }
    }

    // A block caret is drawn over the character under it, so carry that
    // along: what a pending prediction puts there, else what the server drew.
    const pending = items.find(
      (p) => p.row === next.row && p.col === next.col && p.kind !== 'mask',
    );
    const under = pending
      ? pending.char
      : normalizeBlank(active?.getLine(next.row)?.getCell(next.col)?.getChars() ?? '');
    items.push({ row: next.row, col: next.col, char: under, width: 1, kind: 'caret' });
    return items;
  }

  getState(): PredictiveEchoState {
    return this.field && this.confidentKeys.has(this.field.key) ? 'confident' : 'tentative';
  }

  getField(): PredictionField | null {
    return this.field;
  }

  getMismatchCount(): number {
    return this.mismatches;
  }

  getEchoSrttMs(): number | null {
    return this.srtt;
  }

  /** The last decisions that ended, refused or discarded predictions, newest last. */
  getTrace(): ReadonlyArray<PredictionTraceEntry> {
    return this.trace;
  }

  /**
   * What may be drawn: predictions of a field that has earned confidence, and
   * frozen ones that were already on screen when their run ended. A run on
   * probation shows nothing until one of its guesses is confirmed.
   */
  private visiblePredictions(): PendingPrediction[] {
    const confident = this.getState() === 'confident';
    return this.predictions.filter((p) =>
      p.frozenFrom ? p.shownWhenFrozen : confident && !p.probation,
    );
  }

  /**
   * Ends the run after a key whose effect cannot be modelled, without taking
   * back what is already on screen: every key typed before it reaches the
   * server first and will still be echoed. Wiping those made the line blink
   * empty until the echo arrived. New predictions wait for the caret to move.
   */
  private freeze(reason: string, options: { demote?: boolean } = {}): void {
    const terminal = this.getTerminal();
    const caret = terminal
      ? {
          row: terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
          col: terminal.buffer.active.cursorX,
        }
      : null;
    const shown = this.getState() === 'confident';
    for (const p of this.predictions) {
      if (!p.frozenFrom) {
        p.frozenFrom = caret ?? { row: p.row, col: p.col };
        p.shownWhenFrozen = shown && !p.probation;
      }
    }
    // Where the caret will be once every key before this one has landed: the
    // run's next cell, or the caret itself when nothing is on its way.
    const expected = this.predictedCursor ? { ...this.predictedCursor } : caret;
    // Keys sent before this one without a prediction may still be landing, and
    // nothing says where: whatever is predicted next is a guess until proven.
    // (A guessed width before the last prediction is checked as that
    // prediction lands; see `settle`.)
    const untracked = this.inFlight.length > 0 || this.inFlightUnknown || this.lastSentUndrawn;
    this.predictedCursor = null;
    this.note(`freeze: ${reason}${options.demote ? ' (demote)' : ''}`);

    if (options.demote) {
      const field = this.field ?? this.getFieldOption?.() ?? null;
      if (field) {
        this.confidentKeys.delete(field.key);
      }
    }

    this.isSuppressed = true;
    this.suppressSentAt = this.now();
    this.suppressCursor = expected;
    this.forgetInFlight();
    this.inFlightUnknown = untracked;
  }

  private forgetInFlight(): void {
    this.inFlight = [];
    this.inFlightUnknown = false;
    this.runInFlight = [];
    this.runSent = [];
    this.probationRun = false;
    this.lastSentUndrawn = false;
  }

  private suppressTimeout(): number {
    return Math.max(300, (this.srtt ?? 300) * 1.5);
  }

  private predictionTimeout(): number {
    return Math.min(
      MAX_PREDICTION_TIMEOUT_MS,
      Math.max(MIN_PREDICTION_TIMEOUT_MS, (this.srtt ?? 0) * 4),
    );
  }

  /**
   * If a control key (Enter, arrows, etc.) or external event recently reset the cursor,
   * the true terminal cursor has not yet caught up to remote host coordinates.
   * Predictions wait until onServerOutput() sees it move, or a timeout passes.
   */
  private stillSuppressed(): boolean {
    if (!this.isSuppressed) {
      return false;
    }
    if (this.now() - this.suppressSentAt >= this.suppressTimeout()) {
      this.liftSuppression();
      return false;
    }
    return true;
  }

  private liftSuppression(): void {
    this.isSuppressed = false;
    this.suppressCursor = null;
  }

  /** Returns false when the character was refused and the rest of the input should be too. */
  private handlePrintable(char: string, width: 1 | 2, terminal: PredictionTerminal): boolean {
    const field = this.ensureField(terminal);
    if (!field || !this.predictedCursor) {
      // Not an input field: the key goes to the server untouched.
      this.note('refused: caret is not in an input field');
      return false;
    }

    const cursor = this.predictedCursor;
    const atFieldStart =
      this.predictions.every((p) => p.frozenFrom) && cursor.col === field.caretCol;
    if (field.agentLike && field.empty && atFieldStart && MODE_SWITCH_FIRST_KEYS.includes(char)) {
      this.freeze('agent mode switch');
      return false;
    }

    // When a cell is refused, the key still goes to the server, so the
    // modelled caret would drift from the real one: end the whole run instead.
    // Never predict into the last cell, where wrap behaviour is unknowable.
    if (cursor.col + width > field.endCol - 1) {
      this.freeze('cursor would reach the edge of the field');
      return false;
    }

    const cell = terminal.buffer.active.getLine(cursor.row)?.getCell(cursor.col);
    const before = [normalizeBlank(cell ? cell.getChars() : '')];

    // Retyping a cell that a pending backspace is clearing: the server may
    // still show the old character, the cleared cell, or the new one.
    const last = this.predictions[this.predictions.length - 1];
    let replaces: PendingPrediction | undefined;
    if (
      last &&
      last.kind === 'erase' &&
      !last.frozenFrom &&
      last.row === cursor.row &&
      last.col === cursor.col
    ) {
      replaces = this.predictions.pop();
      before.push(...last.before, ' ');
    }

    this.predictions.push({
      row: cursor.row,
      col: cursor.col,
      char,
      width,
      kind: 'char',
      before,
      sentAt: this.now(),
      replaces,
      probation: this.probationRun || undefined,
    });
    if (this.probationRun) this.runSent.push(char);
    this.lastSentUndrawn = false;

    cursor.col += width;
    return true;
  }

  /**
   * A character whose width the layers may disagree on (emoji, ambiguous
   * symbols such as box drawing) is not drawn, but the run goes on after it
   * at the width the terminal gives it. That is a guess, so everything after
   * it stays hidden until an echo proves it, and a wrong guess is dropped
   * without a trace. Ending the run here instead left every key after it to
   * be placed from a caret still catching up with the keys before it.
   */
  private skipUnpredictable(
    char: string,
    codePoint: number,
    terminal: PredictionTerminal,
  ): boolean {
    const field = this.ensureField(terminal);
    const cursor = this.predictedCursor;
    if (!field || !cursor) {
      this.note('refused: caret is not in an input field');
      return false;
    }
    const width = this.assumedWidth(codePoint);
    if (cursor.col + width > field.endCol - 1) {
      this.freeze('cursor would reach the edge of the field');
      return false;
    }
    if (!this.probationRun) {
      this.probationRun = true;
      this.runSent = [];
    }
    this.runSent.push(char);
    this.lastSentUndrawn = true;
    cursor.col += width;
    this.note('width unknown: guessing');
    return true;
  }

  private assumedWidth(codePoint: number): number {
    const width = this.charWidth?.(codePoint);
    return width === 0 || width === 1 || width === 2 ? width : 1;
  }

  /** Returns false when the backspace could not be predicted. */
  private handleBackspace(terminal: PredictionTerminal): boolean {
    // If we have unconfirmed predictions on this line, we know what was typed and can safely undo it.
    const last = this.predictions[this.predictions.length - 1];
    if (
      this.predictedCursor &&
      last &&
      !last.frozenFrom &&
      !last.echoed &&
      last.kind === 'char' &&
      last.row === this.predictedCursor.row &&
      last.col + last.width === this.predictedCursor.col
    ) {
      this.predictions.pop();
      if (last.probation) this.runSent.pop();
      this.predictedCursor.col = last.col;
      if (last.replaces) {
        // The erase it was typed over still stands.
        this.predictions.push(last.replaces);
      }
      return true;
    }

    if (!this.stillSuppressed()) {
      const field = this.ensureField(terminal);
      const cursor = this.predictedCursor;
      if (field && cursor) {
        const line = terminal.buffer.active.getLine(cursor.row);
        const trailing = line?.getCell(cursor.col - 1);
        const width: 1 | 2 = trailing && trailing.getWidth?.() === 0 ? 2 : 1;
        const col = cursor.col - width;
        // Erasing text the server drew is only predicted inside the field, never
        // its first character (a placeholder or suggestion may reappear there),
        // and only at the end of the text, where nothing shifts left to fill the gap.
        let restIsBlank = true;
        for (let x = cursor.col; x < field.endCol && restIsBlank; x++) {
          restIsBlank =
            this.coveredByPrediction(cursor.row, x) ||
            normalizeBlank(line?.getCell(x)?.getChars() ?? '') === ' ';
        }
        const erased = normalizeBlank(line?.getCell(col)?.getChars() ?? '');
        if (col > field.startCol && restIsBlank && erased !== ' ') {
          // A character the server has echoed but not yet moved past is
          // what this backspace deletes: it must not be painted back.
          this.predictions = this.predictions.filter(
            (p) => !(p.echoed && p.row === cursor.row && p.col + p.width > col),
          );
          this.predictions.push({
            row: cursor.row,
            col,
            char: ' ',
            width,
            kind: 'erase',
            before: [erased],
            sentAt: this.now(),
            probation: this.probationRun || undefined,
          });
          this.lastSentUndrawn = false;
          cursor.col = col;
          return true;
        }
      }
    } else {
      this.inFlightUnknown = true;
    }

    // Backspacing into server-rendered characters cannot be predicted locally
    // because we do not know whether the remote program handles wide characters, tabs,
    // or protected shell prompt boundaries. Wipe all speculation and suppress until server responds.
    this.freeze('backspace into server content');
    return false;
  }

  private coveredByPrediction(row: number, col: number): boolean {
    return this.predictions.some(
      (p) => p.echoed && p.row === row && p.col <= col && col < p.col + p.width,
    );
  }

  /**
   * Starts a run of predictions at the field's caret. A run always begins
   * from a fresh reading of the field; later keys extend it.
   */
  private ensureField(terminal: PredictionTerminal): PredictionField | null {
    if (this.predictedCursor && this.field) {
      return this.field;
    }
    const field = this.getFieldOption ? this.getFieldOption() : legacyField(terminal);
    if (!field) {
      return null;
    }
    // Keys sent without a prediction are still reaching the caret: the run
    // starts after the part of them the server has not drawn yet, and stays
    // hidden until an echo proves the guess.
    let caretCol = field.caretCol;
    let pending: string[] = [];
    let onProbation = this.inFlightUnknown;
    if (this.inFlight.length > 0 && !this.inFlightUnknown) {
      pending = this.inFlight.slice(
        echoedPrefix(this.inFlight, charsBefore(terminal, field.row, caretCol)),
      );
      for (const char of pending) {
        const codePoint = char.codePointAt(0) ?? 0;
        caretCol += predictableWidth(codePoint) || this.assumedWidth(codePoint);
      }
      // All of it drawn just before the caret: the caret is where it seems.
      onProbation = pending.length > 0;
    }
    this.inFlight = [];
    this.inFlightUnknown = false;
    this.field = field;
    this.runStartedEmpty = field.empty && pending.length === 0;
    // Frozen predictions from the last run stay until their echo lands.
    this.predictions = this.predictions.filter((p) => p.frozenFrom);
    this.predictedCursor = { row: field.row, col: caretCol };
    this.runInFlight = pending;
    this.probationRun = onProbation;
    this.runSent = [];
    return field;
  }

  private confirm(p: PendingPrediction, field: PredictionField | null): void {
    // Confirmation success! Server proved the remote program is echoing faithfully.
    this.updateSrtt(Math.max(0, this.now() - p.sentAt));
    // A frozen prediction was typed before a key that may have switched
    // modes (Esc into vim normal mode); its echo vouches for nothing after.
    if (field && !p.frozenFrom) {
      this.markConfident(field.key);
    }
    if (p.probation) {
      // The guess was right: the run is where the server's caret is.
      for (const q of this.predictions) q.probation = undefined;
      this.probationRun = false;
      this.runInFlight = [];
      this.runSent = [];
    }
  }

  private learnStyle(key: string, cell: PredictionCell | undefined): void {
    const style = readCellStyle(cell);
    if (!style) return;
    this.fieldStyles.delete(key);
    this.fieldStyles.set(key, style);
    while (this.fieldStyles.size > MAX_CONFIDENT_FIELDS) {
      const oldest = this.fieldStyles.keys().next().value;
      if (oldest === undefined) break;
      this.fieldStyles.delete(oldest);
    }
  }

  private markConfident(key: string): void {
    this.confidentKeys.delete(key);
    this.confidentKeys.add(key);
    while (this.confidentKeys.size > MAX_CONFIDENT_FIELDS) {
      const oldest = this.confidentKeys.values().next().value;
      if (oldest === undefined) break;
      this.confidentKeys.delete(oldest);
    }
  }

  private mismatch(reason: string): void {
    this.mismatches++;
    this.note(`mismatch: ${reason}`);
    this.predictions = [];
    this.predictedCursor = null;
    if (this.field) {
      this.confidentKeys.delete(this.field.key);
    }
    this.isSuppressed = false;
    this.suppressCursor = null;
  }

  private note(event: string): void {
    const last = this.trace[this.trace.length - 1];
    if (last && last.event === event) {
      last.count++;
      last.at = this.now();
      return;
    }
    this.trace.push({ at: this.now(), event, count: 1 });
    if (this.trace.length > TRACE_LENGTH) this.trace.shift();
  }

  /**
   * Drops predictions pending too long without server feedback: packets may
   * be lost, or the program may not echo at all (a sudo prompt). The limit
   * grows with the measured round trip, so a slow link does not blank what
   * it is about to confirm. Timing out is not treated as a prediction error.
   */
  private pruneExpired(): void {
    if (this.predictions.length === 0) {
      return;
    }

    const currentTime = this.now();
    const timeout = this.predictionTimeout();
    const fresh = this.predictions.filter((p) => currentTime - p.sentAt <= timeout);

    if (fresh.length !== this.predictions.length) {
      this.note('expired without an echo');
      this.predictions = fresh;
      if (this.predictions.length === 0) {
        this.predictedCursor = null;
      }
    }
  }

  private updateSrtt(sampleMs: number): void {
    if (this.srtt === null) {
      this.srtt = sampleMs;
    } else {
      this.srtt = this.srtt * 0.8 + sampleMs * 0.2;
    }
  }
}
