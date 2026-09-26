// The bookkeeping under predictive echo: the run of pending predictions,
// keys in flight without one, suppression after a key that cannot be
// modelled, which fields have earned confidence, and the echo round trip.
// `PredictiveEcho` builds the reactions to keys and server output on it.

import { type CellStyle, readCellStyle } from '../render/cell';
import {
  charsBefore,
  echoedPrefix,
  legacyField,
  type PendingPrediction,
  type PredictionCell,
  type PredictionField,
  type PredictionTerminal,
  type PredictionTraceEntry,
  type PredictiveEchoOptions,
  type PredictiveEchoState,
  type ResetOptions,
} from './predictionModel';
import { predictableWidth } from './wideChars';

/** Fields whose confidence is remembered, so hopping between two panes does not re-learn each time. */
const MAX_CONFIDENT_FIELDS = 8;
/** Predictions without any server feedback for this long are dropped; stretched on slow links. */
const MIN_PREDICTION_TIMEOUT_MS = 1500;
const MAX_PREDICTION_TIMEOUT_MS = 4000;
const TRACE_LENGTH = 20;

export abstract class PredictionState {
  protected readonly getTerminal: () => PredictionTerminal | null;
  protected readonly getFieldOption: (() => PredictionField | null) | undefined;
  protected readonly charWidth: ((codePoint: number) => number) | undefined;
  protected readonly now: () => number;
  protected readonly textDecoder = new TextDecoder('utf-8');

  protected readonly confidentKeys = new Set<string>();
  /** How each field draws typed text, learned from its echoes. */
  protected readonly fieldStyles = new Map<string, CellStyle>();
  protected field: PredictionField | null = null;
  /** Whether the current run began in an empty field, whose placeholder the first key clears. */
  protected runStartedEmpty = false;
  protected predictions: PendingPrediction[] = [];
  protected predictedCursor: { row: number; col: number } | null = null;
  protected srtt: number | null = null;
  protected isSuppressed = false;
  protected suppressCursor: { row: number; col: number } | null = null;
  protected suppressSentAt = 0;
  /**
   * Text sent to the server without a prediction tracking where it lands:
   * keys refused while suppressed, and the keys of a probation run found to
   * be in the wrong place. It is on its way to the caret, so the next run
   * starts after whatever part of it the server has not drawn yet.
   */
  protected inFlight: string[] = [];
  /** A backspace went out untracked: how much of `inFlight` survives is unknown. */
  protected inFlightUnknown = false;
  /** The part of `inFlight` the current run was placed after, in case that guess was wrong. */
  protected runInFlight: string[] = [];
  /** The current run is on probation until one of its guesses is confirmed. */
  protected probationRun = false;
  /** Every key sent since the run went on probation, drawn or not, in order. */
  protected runSent: string[] = [];
  /** The last key of the run went out undrawn, so no prediction will tell when it has landed. */
  protected lastSentUndrawn = false;
  protected awaitingPrefixCommand = false;
  protected mismatches = 0;
  protected readonly trace: PredictionTraceEntry[] = [];

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
   * Suppression ends when the key that caused it has visibly done something.
   *
   * In full-screen TUIs like Herdr, background output (status bar, clocks,
   * spinners) arrives constantly without meaning the program has processed
   * Enter or an arrow key, so only the caret moving counts. And on a slow link
   * the caret keeps moving for a while as the keys typed *before* that one are
   * echoed: that is not the key's doing either. So the caret must first reach
   * where those keys leave it, and then move from there.
   */
  protected updateSuppression(caret: { row: number; col: number } | null): void {
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
  protected visiblePredictions(): PendingPrediction[] {
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
  protected freeze(reason: string, options: { demote?: boolean } = {}): void {
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

  protected forgetInFlight(): void {
    this.inFlight = [];
    this.inFlightUnknown = false;
    this.runInFlight = [];
    this.runSent = [];
    this.probationRun = false;
    this.lastSentUndrawn = false;
  }

  protected suppressTimeout(): number {
    return Math.max(300, (this.srtt ?? 300) * 1.5);
  }

  protected predictionTimeout(): number {
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
  protected stillSuppressed(): boolean {
    if (!this.isSuppressed) {
      return false;
    }
    if (this.now() - this.suppressSentAt >= this.suppressTimeout()) {
      this.liftSuppression();
      return false;
    }
    return true;
  }

  protected liftSuppression(): void {
    this.isSuppressed = false;
    this.suppressCursor = null;
  }

  protected assumedWidth(codePoint: number): number {
    const width = this.charWidth?.(codePoint);
    return width === 0 || width === 1 || width === 2 ? width : 1;
  }

  protected coveredByPrediction(row: number, col: number): boolean {
    return this.predictions.some(
      (p) => p.echoed && p.row === row && p.col <= col && col < p.col + p.width,
    );
  }

  /**
   * Starts a run of predictions at the field's caret. A run always begins
   * from a fresh reading of the field; later keys extend it.
   */
  protected ensureField(terminal: PredictionTerminal): PredictionField | null {
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

  protected confirm(p: PendingPrediction, field: PredictionField | null): void {
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

  protected learnStyle(key: string, cell: PredictionCell | undefined): void {
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

  protected markConfident(key: string): void {
    this.confidentKeys.delete(key);
    this.confidentKeys.add(key);
    while (this.confidentKeys.size > MAX_CONFIDENT_FIELDS) {
      const oldest = this.confidentKeys.values().next().value;
      if (oldest === undefined) break;
      this.confidentKeys.delete(oldest);
    }
  }

  protected mismatch(reason: string): void {
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

  protected note(event: string): void {
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
  protected pruneExpired(): void {
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

  protected updateSrtt(sampleMs: number): void {
    if (this.srtt === null) {
      this.srtt = sampleMs;
    } else {
      this.srtt = this.srtt * 0.8 + sampleMs * 0.2;
    }
  }
}
