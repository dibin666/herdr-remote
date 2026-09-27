// What each key the user types does to the run of predictions: a character
// placed at the modelled caret, one whose width is only guessed, and a
// backspace. `PredictiveEcho` routes keys here and settles them against what
// the server draws.

import { normalizeBlank, type PendingPrediction, type PredictionTerminal } from './predictionModel';
import { PredictionState } from './predictionState';

/**
 * Keys an agent reads as a mode switch when they are the first thing typed
 * into an empty box: Claude opens help on `?` and enters shell mode on `!`,
 * turning the prompt glyph into `!` instead of inserting it.
 */
const MODE_SWITCH_FIRST_KEYS = '?!#';

export abstract class PredictionKeys extends PredictionState {
  /** Returns false when the character was refused and the rest of the input should be too. */
  protected handlePrintable(char: string, width: 1 | 2, terminal: PredictionTerminal): boolean {
    const field = this.ensureField(terminal);
    if (!field || !this.predictedCursor) {
      // Not an input field: the key goes to the server untouched.
      this.note('refused: caret is not in an input field');
      return false;
    }

    const cursor = this.predictedCursor;
    const atFieldStart =
      this.predictions.every((p) => p.frozenFrom || p.cancelled) && cursor.col === field.caretCol;
    if (field.agentLike && field.empty && atFieldStart && MODE_SWITCH_FIRST_KEYS.includes(char)) {
      this.freeze('agent mode switch');
      return false;
    }
    if (field.midWord && atFieldStart) {
      this.freeze('the word above may move down');
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
    // still show the old character, the cleared cell, or the new one. The
    // same goes for a character taken back before its echo.
    const erasing = this.predictions.findIndex(
      (p) => p.kind === 'erase' && !p.frozenFrom && p.row === cursor.row && p.col === cursor.col,
    );
    let replaces: PendingPrediction | undefined;
    if (erasing >= 0) {
      [replaces] = this.predictions.splice(erasing, 1);
      before.push(...replaces.before, ' ');
    }
    for (const p of this.predictions) {
      if (p.cancelled && p.row === cursor.row && p.col === cursor.col) before.push(p.char);
    }
    const active = terminal.buffer.active;
    const serverRow = active.baseY + active.cursorY;
    const behindCaret =
      serverRow > cursor.row || (serverRow === cursor.row && active.cursorX > cursor.col);

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
      behindCaret: behindCaret || undefined,
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
  protected skipUnpredictable(
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
  protected handleBackspace(terminal: PredictionTerminal): boolean {
    // If we have unconfirmed predictions on this line, we know what was typed and can safely undo it.
    let last: PendingPrediction | undefined;
    for (let i = this.predictions.length - 1; i >= 0 && !last; i--) {
      if (!this.predictions[i].cancelled) last = this.predictions[i];
    }
    if (
      this.predictedCursor &&
      last &&
      !last.frozenFrom &&
      !last.echoed &&
      last.kind === 'char' &&
      last.row === this.predictedCursor.row &&
      last.col + last.width === this.predictedCursor.col
    ) {
      // Both keys are on their way; see `cancelled`.
      last.cancelled = true;
      if (last.probation) this.runSent.pop();
      this.predictedCursor.col = last.col;
      if (last.replaces) {
        // The erase it was typed over still stands, and was typed before it.
        this.predictions.splice(this.predictions.indexOf(last), 0, last.replaces);
        last.replaces = undefined;
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
