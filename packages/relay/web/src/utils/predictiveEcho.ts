import { classifyInput, isLoneEscape } from "./inputClassifier";
import { predictableWidth } from "./wideChars";

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
}

export interface PredictiveEchoOptions {
  getTerminal: () => PredictionTerminal | null;
  /**
   * The input field under the caret, or null when the caret is not in one —
   * in which case nothing is predicted. Without this option every row counts
   * as a field that starts at the caret.
   */
  getField?: () => PredictionField | null;
  now?: () => number;
}

export interface ResetOptions {
  /** Hold new predictions until the caret moves (default true). */
  suppress?: boolean;
  /** Drop the field's confidence, so it must see a fresh echo before predictions show again. */
  demote?: boolean;
}

export type PredictiveEchoState = "tentative" | "confident";

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
  kind: "char" | "erase" | "caret";
}

interface PendingPrediction {
  row: number;
  col: number;
  char: string;
  width: 1 | 2;
  kind: "char" | "erase";
  /** What the cell may still show while the echo is in flight. */
  before: string[];
  sentAt: number;
  /** A pending erase of the same cell that this character was typed over. */
  replaces?: PendingPrediction;
}

/** Herdr's prefix key: whatever follows goes to Herdr, not to the pane. */
const HERDR_PREFIX = 0x02;
/**
 * Keys an agent reads as a mode switch when they are the first thing typed
 * into an empty box: Claude opens help on `?` and enters shell mode on `!`,
 * turning the prompt glyph into `!` instead of inserting it.
 */
const MODE_SWITCH_FIRST_KEYS = "?!#";
/** Fields whose confidence is remembered, so hopping between two panes does not re-learn each time. */
const MAX_CONFIDENT_FIELDS = 8;
const PREDICTION_TIMEOUT_MS = 1500;

function normalizeBlank(chars: string): string {
  return chars === "" || chars === " " ? " " : chars;
}

function legacyField(terminal: PredictionTerminal): PredictionField {
  const active = terminal.buffer.active;
  return {
    key: "legacy",
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
 *    then either shows the predicted character, or the prediction was wrong. Any
 *    wrong prediction wipes all pending ones and demotes the field again.
 */
export class PredictiveEcho {
  private readonly getTerminal: () => PredictionTerminal | null;
  private readonly getFieldOption: (() => PredictionField | null) | undefined;
  private readonly now: () => number;
  private readonly textDecoder = new TextDecoder("utf-8");

  private readonly confidentKeys = new Set<string>();
  private field: PredictionField | null = null;
  private predictions: PendingPrediction[] = [];
  private predictedCursor: { row: number; col: number } | null = null;
  private srtt: number | null = null;
  private isSuppressed = false;
  private suppressCursor: { row: number; col: number } | null = null;
  private suppressSentAt = 0;
  private awaitingPrefixCommand = false;
  private mismatches = 0;

  constructor(options: PredictiveEchoOptions) {
    this.getTerminal = options.getTerminal;
    this.getFieldOption = options.getField;
    this.now =
      options.now ??
      (typeof performance !== "undefined" && typeof performance.now === "function"
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
    if (inputClass === "passive") {
      return;
    }
    if (inputClass === "pointer") {
      this.reset("pointer", { suppress: true });
      return;
    }

    if (this.awaitingPrefixCommand) {
      this.awaitingPrefixCommand = false;
      this.reset("Herdr prefix command", { suppress: true, demote: true });
      return;
    }

    // A bare Escape is how vim-style editors, Claude Code's included, leave
    // insert mode; the keys that follow are commands until an echo says otherwise.
    if (isLoneEscape(text)) {
      this.reset("escape", { suppress: true, demote: true });
      return;
    }

    const terminal = this.getTerminal();
    if (!terminal) {
      this.reset("terminal unavailable", true);
      return;
    }

    for (const char of text) {
      const codePoint = char.codePointAt(0);
      if (codePoint === undefined) {
        continue;
      }

      if (codePoint === HERDR_PREFIX) {
        this.awaitingPrefixCommand = true;
        this.reset("Herdr prefix", { suppress: true, demote: true });
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
        this.reset("control or escape sequence", true);
        return;
      }

      // Backspace: 0x08 (BS) or 0x7f (DEL)
      if (codePoint === 0x08 || codePoint === 0x7f) {
        if (!this.handleBackspace(terminal)) {
          return;
        }
        continue;
      }

      // Only characters whose cell width every layer agrees on are drawn;
      // see wideChars.ts. Anything else aborts speculation.
      const width = predictableWidth(codePoint);
      if (width === 0) {
        this.reset("unpredictable character", true);
        return;
      }

      if (!this.handlePrintable(char, width, terminal)) {
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

    if (this.isSuppressed) {
      const isTimedOut = this.now() - this.suppressSentAt >= this.suppressTimeout();
      const cursorMoved =
        !!caret &&
        !!this.suppressCursor &&
        (caret.row !== this.suppressCursor.row || caret.col !== this.suppressCursor.col);

      // In full-screen TUIs like herdr, background output (status bar, clocks, spinners)
      // arrives constantly without meaning the remote shell has finished processing Enter
      // or arrow keys. If we unsuppress on arbitrary output while the cursor hasn't moved,
      // local predictions render at the stale cursor position on the previous line.
      // We only unsuppress when the true cursor actually moves, or when the safety timeout expires.
      if (cursorMoved || isTimedOut) {
        this.isSuppressed = false;
        this.suppressCursor = null;
      }
    }

    this.pruneExpired();

    if (this.predictions.length === 0 || !terminal || !caret) {
      return;
    }

    // The field the predictions were typed into must still be under the caret.
    // If it closed or became something else, whatever the server drew there
    // was not an echo.
    const field = this.field;
    if (this.getFieldOption) {
      const current = this.getFieldOption();
      if (!current || current.key !== field?.key) {
        this.mismatch();
        return;
      }
      if (current.layout !== field.layout) {
        // The text reflowed (Claude's box grows upwards when a line wraps) and
        // the server has already drawn it in its new place. The run ends;
        // the field is as trustworthy as it was.
        this.predictions = [];
        this.predictedCursor = null;
        this.field = current;
        return;
      }
    }

    const remaining: PendingPrediction[] = [];

    for (const p of this.predictions) {
      const cell = terminal.buffer.active.getLine(p.row)?.getCell(p.col);
      const actual = normalizeBlank(cell ? cell.getChars() : "");
      const matches =
        p.kind === "char"
          ? actual === p.char && (p.width === 1 || (cell?.getWidth?.() ?? 2) === 2)
          : actual === " ";
      // The server has processed a keystroke once its caret has moved past
      // the cell that keystroke affects.
      const settled =
        p.kind === "char"
          ? caret.row > p.row || (caret.row === p.row && caret.col >= p.col + p.width)
          : caret.row < p.row || (caret.row === p.row && caret.col <= p.col);
      const unchanged = p.before.includes(actual);

      if (matches && (settled || !unchanged)) {
        // Confirmation success! Server proved the remote program is echoing faithfully.
        this.updateSrtt(Math.max(0, this.now() - p.sentAt));
        if (field) {
          this.markConfident(field.key);
        }
      } else if (!settled && unchanged) {
        // Not echoed yet. When the typed character equals what the cell already
        // held, only the caret moving past it can tell the two apart.
        remaining.push(p);
      } else {
        // Prediction error: remote host displayed something different (e.g. password masking,
        // modal vim mode, auto-completion, or a word wrapped onto the next row).
        this.mismatch();
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
  reset(_reason?: string, options?: ResetOptions | boolean): void {
    this.predictions = [];
    this.predictedCursor = null;

    const shouldSuppress =
      typeof options === "boolean"
        ? options
        : (options?.suppress ?? true);
    const shouldDemote = typeof options === "object" && options?.demote === true;

    if (shouldDemote) {
      const field = this.field ?? this.getFieldOption?.() ?? null;
      if (field) {
        this.confidentKeys.delete(field.key);
      }
    }

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
    this.field = null;
  }

  /**
   * Returns predictions currently eligible for rendering.
   * Returns empty array when in tentative state to guarantee zero false visual echoes.
   */
  getVisiblePredictions(): ReadonlyArray<VisiblePrediction> {
    this.pruneExpired();

    if (this.getState() !== "confident") {
      return [];
    }

    return this.predictions.map((p) => ({
      row: p.row,
      col: p.col,
      char: p.char,
    }));
  }

  /**
   * Everything the overlay should draw: the pending predictions plus a caret
   * where the next character will land, so typing does not appear to happen
   * behind the old caret.
   */
  getOverlayItems(): ReadonlyArray<OverlayItem> {
    this.pruneExpired();

    if (this.getState() !== "confident" || this.predictions.length === 0 || !this.predictedCursor) {
      return [];
    }

    const items: OverlayItem[] = this.predictions.map((p) => ({
      row: p.row,
      col: p.col,
      char: p.char,
      width: p.width,
      kind: p.kind,
    }));

    // A backspace leaves the old caret to the right of every prediction; cover it.
    const field = this.field;
    if (field) {
      const covered = this.predictions.some(
        (p) => p.row === field.row && p.col <= field.caretCol && field.caretCol < p.col + p.width,
      );
      if (!covered) {
        items.push({ row: field.row, col: field.caretCol, char: " ", width: 1, kind: "erase" });
      }
    }

    // A block caret is drawn over the character under it, so carry that
    // along: what a pending prediction puts there, else what the server drew.
    const { row, col } = this.predictedCursor;
    const pending = this.predictions.find((p) => p.row === row && p.col === col);
    const under = pending
      ? pending.char
      : normalizeBlank(this.getTerminal()?.buffer.active.getLine(row)?.getCell(col)?.getChars() ?? "");
    items.push({ row, col, char: under, width: 1, kind: "caret" });
    return items;
  }

  getState(): PredictiveEchoState {
    return this.field && this.confidentKeys.has(this.field.key) ? "confident" : "tentative";
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

  private suppressTimeout(): number {
    return Math.max(300, (this.srtt ?? 300) * 1.5);
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
      this.isSuppressed = false;
      this.suppressCursor = null;
      return false;
    }
    return true;
  }

  /** Returns false when the character was refused and the rest of the input should be too. */
  private handlePrintable(char: string, width: 1 | 2, terminal: PredictionTerminal): boolean {
    if (this.stillSuppressed()) {
      return false;
    }

    const field = this.ensureField(terminal);
    if (!field || !this.predictedCursor) {
      // Not an input field: the key goes to the server untouched.
      return false;
    }

    const cursor = this.predictedCursor;
    const atFieldStart = this.predictions.length === 0 && cursor.col === field.caretCol;
    if (field.agentLike && field.empty && atFieldStart && MODE_SWITCH_FIRST_KEYS.includes(char)) {
      this.reset("agent mode switch", { suppress: true });
      return false;
    }

    // When a cell is refused, the key still goes to the server, so the
    // modelled caret would drift from the real one: end the whole run instead.
    // Never predict into the last cell, where wrap behaviour is unknowable.
    if (cursor.col + width > field.endCol - 1) {
      this.reset("cursor would reach the edge of the field", true);
      return false;
    }

    const cell = terminal.buffer.active.getLine(cursor.row)?.getCell(cursor.col);
    const before = [normalizeBlank(cell ? cell.getChars() : "")];

    // Retyping a cell that a pending backspace is clearing: the server may
    // still show the old character, the cleared cell, or the new one.
    const last = this.predictions[this.predictions.length - 1];
    let replaces: PendingPrediction | undefined;
    if (last && last.kind === "erase" && last.row === cursor.row && last.col === cursor.col) {
      replaces = this.predictions.pop();
      before.push(...last.before, " ");
    }

    this.predictions.push({
      row: cursor.row,
      col: cursor.col,
      char,
      width,
      kind: "char",
      before,
      sentAt: this.now(),
      replaces,
    });

    cursor.col += width;
    return true;
  }

  /** Returns false when the backspace could not be predicted. */
  private handleBackspace(terminal: PredictionTerminal): boolean {
    // If we have unconfirmed predictions on this line, we know what was typed and can safely undo it.
    const last = this.predictions[this.predictions.length - 1];
    if (
      this.predictedCursor &&
      last &&
      last.kind === "char" &&
      last.row === this.predictedCursor.row &&
      last.col + last.width === this.predictedCursor.col
    ) {
      this.predictions.pop();
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
          restIsBlank = normalizeBlank(line?.getCell(x)?.getChars() ?? "") === " ";
        }
        const erased = normalizeBlank(line?.getCell(col)?.getChars() ?? "");
        if (col > field.startCol && restIsBlank && erased !== " ") {
          this.predictions.push({
            row: cursor.row,
            col,
            char: " ",
            width,
            kind: "erase",
            before: [erased],
            sentAt: this.now(),
          });
          cursor.col = col;
          return true;
        }
      }
    }

    // Backspacing into server-rendered characters cannot be predicted locally
    // because we do not know whether the remote program handles wide characters, tabs,
    // or protected shell prompt boundaries. Wipe all speculation and suppress until server responds.
    this.reset("backspace into server content", true);
    return false;
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
    this.field = field;
    this.predictions = [];
    this.predictedCursor = { row: field.row, col: field.caretCol };
    return field;
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

  private mismatch(): void {
    this.mismatches++;
    this.predictions = [];
    this.predictedCursor = null;
    if (this.field) {
      this.confidentKeys.delete(this.field.key);
    }
    this.isSuppressed = false;
    this.suppressCursor = null;
  }

  /**
   * Drops predictions pending longer than 1500ms without server feedback.
   * Packets might be dropped or commands might suppress echo (e.g. sudo prompt).
   * Timeout drops stale entries without treating it as a prediction error.
   */
  private pruneExpired(): void {
    if (this.predictions.length === 0) {
      return;
    }

    const currentTime = this.now();
    const fresh = this.predictions.filter((p) => currentTime - p.sentAt <= PREDICTION_TIMEOUT_MS);

    if (fresh.length !== this.predictions.length) {
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
