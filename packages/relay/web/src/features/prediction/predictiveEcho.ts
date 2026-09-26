import { classifyInput, isLoneEscape } from '@/shared/keys/inputClassifier';
import {
  normalizeBlank,
  type OverlayItem,
  type PendingPrediction,
  type PredictionTerminal,
  type VisiblePrediction,
} from './predictionModel';
import { overlayItems } from './predictionOverlay';
import { PredictionState } from './predictionState';
import { predictableWidth } from './wideChars';

/** Herdr's prefix key: whatever follows goes to Herdr, not to the pane. */
const HERDR_PREFIX = 0x02;
/**
 * Keys an agent reads as a mode switch when they are the first thing typed
 * into an empty box: Claude opens help on `?` and enters shell mode on `!`,
 * turning the prompt glyph into `!` instead of inserting it.
 */
const MODE_SWITCH_FIRST_KEYS = '?!#';

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
export class PredictiveEcho extends PredictionState {
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

    return overlayItems(visible, {
      style: this.field ? this.fieldStyles.get(this.field.key) : undefined,
      predictedCursor: this.predictedCursor,
      field: this.field,
      runStartedEmpty: this.runStartedEmpty,
      active: this.getTerminal()?.buffer.active,
    });
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
}
