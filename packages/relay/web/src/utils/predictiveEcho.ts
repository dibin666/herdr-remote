/**
 * Minimal read-only interface required by PredictiveEcho.
 * Intentionally decoupled from @xterm/xterm to allow unit testing with mock terminals.
 */
export interface PredictionCell {
  getChars(): string;
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

export interface PredictiveEchoOptions {
  getTerminal: () => PredictionTerminal | null;
  now?: () => number;
}

export interface ResetOptions {
  suppress?: boolean;
}

export type PredictiveEchoState = "tentative" | "confident";

export interface VisiblePrediction {
  row: number;
  col: number;
  char: string;
}

interface PendingPrediction {
  row: number;
  col: number;
  char: string;
  charBefore: string;
  sentAt: number;
}

/**
 * Predictive local echo state machine inspired by Mosh.
 *
 * Remote terminal connections through relays can suffer from round-trip latencies
 * of 150ms or more. Typing feels sluggish unless characters are rendered speculatively
 * before the round trip completes.
 *
 * To guarantee that the user never sees phantom characters or corrupted screens:
 * 1. Predictions start in the 'tentative' state, where predictive calculations happen
 *    internally but remain completely invisible to the renderer.
 * 2. Only after at least one prediction is confirmed by authentic server output does the
 *    state machine transition to 'confident', allowing predictions to be displayed.
 * 3. Any single prediction mismatch immediately wipes all pending predictions and drops
 *    back to 'tentative'.
 */
export class PredictiveEcho {
  private readonly getTerminal: () => PredictionTerminal | null;
  private readonly now: () => number;
  private readonly textDecoder = new TextDecoder("utf-8");

  private state: PredictiveEchoState = "tentative";
  private predictions: PendingPrediction[] = [];
  private predictedCursor: { row: number; col: number } | null = null;
  private srtt: number | null = null;
  private isSuppressed = false;
  private suppressCursor: { row: number; col: number } | null = null;
  private suppressSentAt = 0;

  constructor(options: PredictiveEchoOptions) {
    this.getTerminal = options.getTerminal;
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
        this.handleBackspace();
        continue;
      }

      // Only predict ASCII printable characters (0x20 through 0x7e).
      // Multi-byte Unicode or wide characters (e.g. CJK ideographs) span multiple terminal
      // cells, where trailing cells return empty getChars(). Attempting naive single-column
      // increments across wide characters causes severe cursor misalignments.
      if (codePoint >= 0x20 && codePoint <= 0x7e) {
        this.handlePrintable(char, terminal);
        continue;
      }

      // Characters outside ASCII printable range (> 0x7e) abort speculation safely.
      this.reset("non-ASCII character", true);
      return;
    }
  }

  /**
   * Called after server output has been written to the terminal and parsed.
   * Compares the actual buffer cells against pending predictions.
   */
  onServerOutput(): void {
    if (this.isSuppressed) {
      const terminal = this.getTerminal();
      const timeoutThreshold = Math.max(300, (this.srtt ?? 300) * 1.5);
      const isTimedOut = this.now() - this.suppressSentAt >= timeoutThreshold;

      let cursorMoved = false;
      if (terminal && this.suppressCursor) {
        const currentRow = terminal.buffer.active.baseY + terminal.buffer.active.cursorY;
        const currentCol = terminal.buffer.active.cursorX;
        cursorMoved =
          currentRow !== this.suppressCursor.row ||
          currentCol !== this.suppressCursor.col;
      }

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

    if (this.predictions.length === 0) {
      return;
    }

    const terminal = this.getTerminal();
    if (!terminal) {
      return;
    }

    const remaining: PendingPrediction[] = [];

    for (let i = 0; i < this.predictions.length; i++) {
      const p = this.predictions[i];
      const line = terminal.buffer.active.getLine(p.row);
      const cell = line ? line.getCell(p.col) : undefined;
      const actual = cell ? cell.getChars() : "";

      if (actual === p.charBefore) {
        // The server has not yet repainted this cell with the new keystroke.
        // In full-screen TUI apps like herdr, input cells already contain spaces (" ").
        // Matching charBefore proves the cell has not yet received remote echo.
        // Edge case: if the user typed the exact character already in the cell (p.char === p.charBefore),
        // we cannot disambiguate remote repaint vs unpainted stale content. Retain pending until 1500ms
        // timeout drops it safely without misidentifying it as an error.
        remaining.push(p);
      } else if (actual === p.char) {
        // Confirmation success! Server proved the remote shell is echoing faithfully.
        const sample = Math.max(0, this.now() - p.sentAt);
        this.updateSrtt(sample);
        this.state = "confident";
      } else {
        // Prediction error: remote host displayed something different (e.g. password masking,
        // modal vim mode, or auto-completion). Immediate rollback to tentative to prevent artifacts.
        this.predictions = [];
        this.predictedCursor = null;
        this.state = "tentative";
        this.isSuppressed = false;
        this.suppressCursor = null;
        return;
      }
    }

    this.predictions = remaining;
  }

  /**
   * Resets internal pending predictions and cursor without demoting confident state.
   * Called on control keys, resizes, screen switches, reconnects, pastes, and scrolls.
   * Defaults to suppressing new predictions until next onServerOutput() arrives.
   */
  reset(_reason?: string, options?: ResetOptions | boolean): void {
    this.predictions = [];
    this.predictedCursor = null;

    const shouldSuppress =
      typeof options === "boolean"
        ? options
        : (options?.suppress ?? true);

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

  /**
   * Returns predictions currently eligible for rendering.
   * Returns empty array when in tentative state to guarantee zero false visual echoes.
   */
  getVisiblePredictions(): ReadonlyArray<VisiblePrediction> {
    this.pruneExpired();

    if (this.state !== "confident") {
      return [];
    }

    return this.predictions.map((p) => ({
      row: p.row,
      col: p.col,
      char: p.char,
    }));
  }

  getState(): PredictiveEchoState {
    return this.state;
  }

  getEchoSrttMs(): number | null {
    return this.srtt;
  }

  private handlePrintable(char: string, terminal: PredictionTerminal): void {
    // If a control key (Enter, arrows, etc.) or external event recently reset the cursor,
    // the true terminal cursor has not yet caught up to remote host coordinates.
    // Suppress predictions until onServerOutput() confirms the new screen state.
    if (this.isSuppressed) {
      const timeoutThreshold = Math.max(300, (this.srtt ?? 300) * 1.5);
      if (this.now() - this.suppressSentAt >= timeoutThreshold) {
        this.isSuppressed = false;
        this.suppressCursor = null;
      } else {
        return;
      }
    }

    // Lazy-initialize predicted cursor from true terminal cursor on first prediction.
    if (!this.predictedCursor) {
      this.predictedCursor = {
        row: terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
        col: terminal.buffer.active.cursorX,
      };
    }

    // When the cursor is at `cols - 1`, writing a character causes the cursor to reach `cols`,
    // triggering line wrapping (autowrap delay or immediate line feed depending on the TUI application).
    // Because wrap behavior and cursor positioning across margins cannot be inferred reliably,
    // we refuse to predict at the right boundary and wipe existing predictions for safety.
    if (this.predictedCursor.col + 1 >= terminal.cols) {
      this.reset("cursor would reach or exceed column boundary", true);
      return;
    }

    const line = terminal.buffer.active.getLine(this.predictedCursor.row);
    const cell = line ? line.getCell(this.predictedCursor.col) : undefined;
    const charBefore = cell ? cell.getChars() : "";

    this.predictions.push({
      row: this.predictedCursor.row,
      col: this.predictedCursor.col,
      char,
      charBefore,
      sentAt: this.now(),
    });

    this.predictedCursor.col++;
  }

  private handleBackspace(): void {
    // If we have unconfirmed predictions on this line, we know what was typed and can safely undo it.
    if (this.predictedCursor && this.predictions.length > 0) {
      const last = this.predictions[this.predictions.length - 1];
      if (last.row === this.predictedCursor.row && last.col === this.predictedCursor.col - 1) {
        this.predictions.pop();
        this.predictedCursor.col--;
        return;
      }
    }

    // Backspacing into server-rendered characters cannot be predicted locally
    // because we do not know whether the remote program handles wide characters, tabs,
    // or protected shell prompt boundaries. Wipe all speculation and suppress until server responds.
    this.reset("backspace into server content", true);
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
    const fresh: PendingPrediction[] = [];

    for (const p of this.predictions) {
      if (currentTime - p.sentAt <= 1500) {
        fresh.push(p);
      }
    }

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
