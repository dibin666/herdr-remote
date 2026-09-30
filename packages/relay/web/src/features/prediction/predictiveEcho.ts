import { classifyInput, isLoneEscape } from '@/shared/keys/inputClassifier';
import {
  normalizeBlank,
  type OverlayItem,
  type PendingPrediction,
  type PredictionTerminal,
  type VisiblePrediction,
} from './predictionModel';
import { overlayItems } from './predictionOverlay';
import { PredictionKeys } from './predictionKeys';
import { predictableWidth } from './wideChars';

/**
 * Predictive local echo state machine inspired by Mosh.
 *
 * Remote terminal connections through relays can suffer from round-trip latencies
 * of 150ms or more. Typing feels sluggish unless characters are rendered speculatively
 * before the round trip completes.
 *
 * To limit incorrect guesses while leaving the authoritative buffer untouched:
 * 1. Predictions stay within a detected field or an observed cursor region.
 * 2. Predictions in a field stay invisible until one of them has been confirmed by
 *    authentic server output in that same field.
 * 3. A prediction is settled once the server's caret has moved past it: the cell
 *    then either shows the predicted character, or the prediction was wrong. A
 *    wrong prediction wipes all pending ones and demotes the field again. Until
 *    it is settled, whatever the cell shows is the program still at work: a
 *    redraw in between is not a verdict.
 */
export class PredictiveEcho extends PredictionKeys {
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

    const prefix = this.herdrPrefix();
    // A bare Escape is how vim-style editors, Claude Code's included, leave
    // insert mode; the keys that follow are commands until an echo says
    // otherwise. Without vim mode it only interrupts or clears, and the field
    // is as trustworthy as it was. (Unless Escape is itself a prefix key.)
    if (isLoneEscape(text) && !prefix.startsAt(text, 0)) {
      const field = this.field ?? this.getFieldOption?.() ?? null;
      this.freeze('escape', { demote: field?.modal !== false });
      return;
    }

    const terminal = this.getTerminal();
    if (!terminal) {
      this.reset('terminal unavailable', true);
      return;
    }

    const chars = Array.from(text);
    let offset = 0;
    for (let index = 0; index < chars.length; index++) {
      const char = chars[index];
      const codePoint = char.codePointAt(0);
      if (codePoint === undefined) {
        continue;
      }
      const at = offset;
      offset += char.length;

      // Herdr's prefix key: whatever follows goes to Herdr, not to the pane.
      if (prefix.startsAt(text, at)) {
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
          if (index < chars.length - 1) this.inFlightUnknown = true;
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
        if (this.predictions.every((p) => p.frozenFrom || p.echoed || p.cancelled)) {
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

    let remaining: PendingPrediction[] = [];
    // A character taken back is still on its way, and the keys typed after it
    // are behind it: until it has landed, where the caret is says nothing.
    let blocked = false;

    for (const p of this.predictions) {
      if (p.cancelled) {
        // Only the first one still on its way can be read off the caret:
        // several may share a cell, and the caret passes it once for each.
        if (!blocked) {
          const past = caret.row > p.row || (caret.row === p.row && caret.col >= p.col + p.width);
          if (!past) p.behindCaret = undefined;
          // Drawn, then the caret came back: its backspace has landed too.
          if (p.passed && !past) continue;
          if (past && !p.behindCaret) p.passed = true;
        }
        remaining.push(p);
        blocked = true;
        continue;
      }
      const cell = terminal.buffer.active.getLine(p.row)?.getCell(p.col);
      const actual = normalizeBlank(cell ? cell.getChars() : '');
      const matches =
        p.kind === 'char'
          ? actual === p.char && (p.width === 1 || (cell?.getWidth?.() ?? 2) === 2)
          : actual === ' ';
      const unchanged = p.before.includes(actual);
      if (p.behindCaret && (caret.row < p.row || (caret.row === p.row && caret.col <= p.col))) {
        p.behindCaret = undefined;
      }
      // The server has processed a keystroke once its caret has moved past
      // the cell that keystroke affects.
      const settled =
        p.kind === 'char'
          ? (caret.row > p.row || (caret.row === p.row && caret.col >= p.col + p.width)) &&
            !(p.behindCaret && unchanged)
          : caret.row < p.row || (caret.row === p.row && caret.col <= p.col);
      // The character arrived, one cell wide where two were predicted (or
      // the reverse): that is a verdict, whether or not the caret has passed.
      const wrongWidth = p.kind === 'char' && actual === p.char && !matches;

      if (blocked && !p.frozenFrom) {
        if (!matches || unchanged) {
          remaining.push(p);
          continue;
        }
        // It landed, so every key typed before it has too.
        remaining = remaining.filter((q) => !q.cancelled);
        blocked = false;
      }

      if (p.echoed && !matches) {
        // The server drew it, then drew something else before its caret
        // passed (a backspace it has processed, a redraw): stop painting it.
        continue;
      }
      if (field?.observed && matches && !settled) {
        // TUI redraws may contain the typed letters without consuming any input.
        remaining.push(p);
      } else if (matches && (settled || !unchanged)) {
        if (field?.observed && (unchanged || caret.row !== p.row || p.kind !== 'char')) {
          // Traversing existing text or clearing a cell cannot establish echo behaviour.
          if (!settled) remaining.push(p);
          continue;
        }
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
        // Backspaces landing take the caret back, towards an erase and away
        // from where it was frozen.
        const onTrack = p.kind === 'erase' || caret.col >= from.col;
        if (!settled && caret.row === from.row && onTrack) {
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
        // Tentative input may be a password; diagnostics must not reveal its characters.
        this.mismatch('echo differs from prediction');
        return;
      }
    }

    this.predictions = remaining;
    if (remaining.length === 0) {
      this.predictedCursor = null;
      // The run ended unproven: what it was placed after is still unaccounted for.
      if (this.probationRun) this.inFlightUnknown = true;
    }
  }

  /**
   * Returns predictions currently eligible for rendering.
   * Tentative guesses stay hidden until server output supports them.
   */
  getVisiblePredictions(): ReadonlyArray<VisiblePrediction> {
    this.pruneExpired();

    return this.visiblePredictions()
      .filter((p) => !p.echoed && !p.cancelled)
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
}
