import { describe, it, expect, beforeEach } from 'vitest';
import {
  PredictiveEcho,
  type PredictionTerminal,
  type PredictionLine,
  type PredictionCell,
} from '../utils/predictiveEcho';

function createMockTerminal(initial?: {
  cols?: number;
  rows?: number;
  baseY?: number;
  cursorX?: number;
  cursorY?: number;
}): PredictionTerminal & {
  setCell(row: number, col: number, char: string): void;
  setCursor(x: number, y: number, newBaseY?: number): void;
} {
  const cols = initial?.cols ?? 80;
  const rows = initial?.rows ?? 24;
  let baseY = initial?.baseY ?? 0;
  let cursorX = initial?.cursorX ?? 0;
  let cursorY = initial?.cursorY ?? 0;

  // Stores characters written to (row, col)
  const grid = new Map<number, Map<number, string>>();

  const getLine = (row: number): PredictionLine | undefined => {
    if (row < 0) {
      return undefined;
    }
    return {
      getCell(col: number): PredictionCell | undefined {
        if (col < 0 || col >= cols) {
          return undefined;
        }
        const rowMap = grid.get(row);
        const chars = rowMap?.get(col) ?? '';
        return {
          getChars: () => chars,
        };
      },
    };
  };

  return {
    cols,
    rows,
    buffer: {
      active: {
        get baseY() {
          return baseY;
        },
        get cursorX() {
          return cursorX;
        },
        get cursorY() {
          return cursorY;
        },
        getLine,
      },
    },
    setCell(row: number, col: number, char: string) {
      let rowMap = grid.get(row);
      if (!rowMap) {
        rowMap = new Map();
        grid.set(row, rowMap);
      }
      rowMap.set(col, char);
    },
    setCursor(x: number, y: number, newBaseY?: number) {
      cursorX = x;
      cursorY = y;
      if (newBaseY !== undefined) {
        baseY = newBaseY;
      }
    },
  };
}

const textEncoder = new TextEncoder();
const encode = (str: string) => textEncoder.encode(str);

describe('PredictiveEcho State Machine & Verification', () => {
  let currentTime = 1000;
  const now = () => currentTime;

  beforeEach(() => {
    currentTime = 1000;
  });

  // Requirement 1
  it('starts in tentative state and keeps predictions hidden when typing multiple characters', () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    expect(echo.getState()).toBe('tentative');

    echo.handleUserInput(encode('abc'));

    // Predictions are calculated internally but must remain completely invisible
    // to prevent leaking ghost characters before confirmation
    expect(echo.getVisiblePredictions()).toEqual([]);
    expect(echo.getState()).toBe('tentative');
  });

  // Requirement 2
  it('transitions to confident on matching server output, making subsequent predictions visible', () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 5, cursorY: 2, baseY: 10 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // User types 'x' at cursor position (absolute row = baseY + cursorY = 12, col = 5)
    echo.handleUserInput(encode('x'));
    expect(echo.getVisiblePredictions()).toEqual([]);

    // Server output arrives and paints 'x' at (12, 5), moving the cursor past it
    terminal.setCell(12, 5, 'x');
    terminal.setCursor(6, 2);
    currentTime += 50;
    echo.onServerOutput();

    // Proven that host is echoing: upgraded to confident
    expect(echo.getState()).toBe('confident');

    // Next character typed by user should immediately be visible in getVisiblePredictions()
    echo.handleUserInput(encode('y'));
    const visible = echo.getVisiblePredictions();
    expect(visible).toEqual([{ row: 12, col: 6, char: 'y' }]);
  });

  // Requirement 3
  it('wipes all predictions and reverts to tentative when server output mismatches', () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // First confirm one character to reach confident state
    echo.handleUserInput(encode('a'));
    terminal.setCell(0, 0, 'a');
    echo.onServerOutput();
    expect(echo.getState()).toBe('confident');

    // Now user types 'b' (predicted at 0, 1) and 'c' (predicted at 0, 2)
    echo.handleUserInput(encode('bc'));
    expect(echo.getVisiblePredictions()).toHaveLength(2);

    // Server paints something unexpected at (0, 1), e.g. password asterisk or autocomplete.
    // While its caret has not moved past the cell this is still the program at work.
    terminal.setCell(0, 1, '*');
    echo.onServerOutput();
    expect(echo.getState()).toBe('confident');

    // Once the caret has moved past it, the cell is the program's answer.
    terminal.setCursor(2, 0);
    echo.onServerOutput();

    // Must immediately wipe all predictions and drop to tentative
    expect(echo.getState()).toBe('tentative');
    expect(echo.getVisiblePredictions()).toEqual([]);
  });

  // Requirement 4
  it('keeps what is on screen but predicts nothing new after Enter, arrows, Ctrl-C, Tab or CSI', () => {
    // Every key typed before the control key reaches the server first and is
    // still echoed, so wiping those predictions only made the line blink.
    for (const key of ['\r', '\n', '\t', '\x1b[A', '\x03', '\x1b[2J']) {
      const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 3, cursorY: 0 });
      const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

      echo.handleUserInput(encode('a'));
      terminal.setCell(0, 3, 'a');
      terminal.setCursor(4, 0);
      echo.onServerOutput();
      expect(echo.getState()).toBe('confident');

      echo.handleUserInput(encode('b'));
      echo.handleUserInput(encode(key));
      expect(echo.getVisiblePredictions()).toEqual([{ row: 0, col: 4, char: 'b' }]);

      // The run is over: nothing typed after the control key is predicted.
      echo.handleUserInput(encode('c'));
      expect(echo.getVisiblePredictions()).toEqual([{ row: 0, col: 4, char: 'b' }]);

      // The server echoes "b", then acts on the key and takes its caret away.
      terminal.setCell(0, 4, 'b');
      terminal.setCursor(0, 1);
      echo.onServerOutput();
      expect(echo.getVisiblePredictions()).toEqual([]);
      expect(echo.getMismatchCount()).toBe(0);
    }
  });

  it('lets a frozen prediction go quietly when the server moves back instead of echoing it', () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 3, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });
    echo.handleUserInput(encode('a'));
    terminal.setCell(0, 3, 'a');
    terminal.setCursor(4, 0);
    echo.onServerOutput();

    echo.handleUserInput(encode('b'));
    echo.handleUserInput(encode('\x15')); // Ctrl+U before the echo arrives
    expect(echo.getVisiblePredictions()).toHaveLength(1);

    // The line is cleared: the cell stays blank and the caret goes back.
    terminal.setCell(0, 3, '');
    terminal.setCursor(0, 0);
    echo.onServerOutput();
    expect(echo.getVisiblePredictions()).toEqual([]);
    expect(echo.getMismatchCount()).toBe(0);
    expect(echo.getState()).toBe('confident');
  });

  // Requirement 5
  it('handles backspace by undoing local predictions or resetting when backspacing into server content', () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // Promote to confident
    echo.handleUserInput(encode('x'));
    terminal.setCell(0, 0, 'x');
    terminal.setCursor(1, 0);
    echo.onServerOutput();
    expect(echo.getState()).toBe('confident');

    // User types 'a' (col 1) and 'b' (col 2)
    echo.handleUserInput(encode('ab'));
    expect(echo.getVisiblePredictions()).toEqual([
      { row: 0, col: 1, char: 'a' },
      { row: 0, col: 2, char: 'b' },
    ]);

    // Backspace (0x08) pops the last prediction 'b'
    echo.handleUserInput(new Uint8Array([0x08]));
    expect(echo.getVisiblePredictions()).toEqual([{ row: 0, col: 1, char: 'a' }]);

    // Typing a new character 'c' lands at the vacated col 2
    echo.handleUserInput(encode('c'));
    expect(echo.getVisiblePredictions()).toEqual([
      { row: 0, col: 1, char: 'a' },
      { row: 0, col: 2, char: 'c' },
    ]);

    // DEL / backspace (0x7f) pops 'c'
    echo.handleUserInput(new Uint8Array([0x7f]));
    expect(echo.getVisiblePredictions()).toEqual([{ row: 0, col: 1, char: 'a' }]);

    // Another backspace pops 'a'
    echo.handleUserInput(new Uint8Array([0x7f]));
    expect(echo.getVisiblePredictions()).toEqual([]);

    // Now there are no local predictions left.
    // Backspacing further touches server-rendered characters -> wipes speculation safely
    echo.handleUserInput(new Uint8Array([0x7f]));
    expect(echo.getVisiblePredictions()).toEqual([]);
  });

  // Requirement 6
  it('stops predicting and clears all predictions when cursor would reach or exceed line width (cols)', () => {
    const terminal = createMockTerminal({ cols: 4, rows: 10, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // Promote to confident
    echo.handleUserInput(encode('a'));
    terminal.setCell(0, 0, 'a');
    terminal.setCursor(1, 0);
    echo.onServerOutput();
    expect(echo.getState()).toBe('confident');

    // User types 'b' (col 1), 'c' (col 2)
    echo.handleUserInput(encode('bc'));
    expect(echo.getVisiblePredictions()).toEqual([
      { row: 0, col: 1, char: 'b' },
      { row: 0, col: 2, char: 'c' },
    ]);

    // Typing 'd' would advance cursor to col 4 (equals cols: 4). Margin
    // wrapping cannot be inferred, so 'd' is not predicted; what is already
    // shown stays until its echo.
    echo.handleUserInput(encode('d'));
    expect(echo.getVisiblePredictions()).toEqual([
      { row: 0, col: 1, char: 'b' },
      { row: 0, col: 2, char: 'c' },
    ]);

    // If terminal cursor is already at or beyond cols, any typing is refused
    terminal.setCursor(4, 0);
    echo.handleUserInput(encode('z'));
    expect(echo.getVisiblePredictions().map((p) => p.char)).not.toContain('z');
  });

  // Requirement 7
  it('prunes predictions older than 1500ms without demoting confident state', () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // Confirm initial character at t=1000
    echo.handleUserInput(encode('a'));
    terminal.setCell(0, 0, 'a');
    echo.onServerOutput();
    expect(echo.getState()).toBe('confident');

    // User types 'b' at t=1000
    echo.handleUserInput(encode('b'));
    expect(echo.getVisiblePredictions()).toHaveLength(1);

    // Time advances past 1500ms timeout
    currentTime += 1501;

    // Pruning drops stale prediction without treating it as a mismatch error
    expect(echo.getVisiblePredictions()).toEqual([]);
    expect(echo.getState()).toBe('confident');
  });

  // Requirement 8
  it('computes exponentially smoothed SRTT (srtt = srtt * 0.8 + sample * 0.2) on confirmations', () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    expect(echo.getEchoSrttMs()).toBeNull();

    // First keystroke at t=1000
    echo.handleUserInput(encode('a'));
    terminal.setCell(0, 0, 'a');
    terminal.setCursor(1, 0);

    // Confirmed at t=1100 (100ms sample)
    currentTime = 1100;
    echo.onServerOutput();
    expect(echo.getEchoSrttMs()).toBe(100);

    // Second keystroke at t=1200
    currentTime = 1200;
    echo.handleUserInput(encode('b'));
    terminal.setCell(0, 1, 'b');
    terminal.setCursor(2, 0);

    // Confirmed at t=1400 (200ms sample)
    // Smoothed SRTT = 100 * 0.8 + 200 * 0.2 = 80 + 40 = 120
    currentTime = 1400;
    echo.onServerOutput();
    expect(echo.getEchoSrttMs()).toBeCloseTo(120, 4);
  });

  // Additional edge-case & resilience tests
  it('retains pending predictions when server output cell is empty (untouched cell)', () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // Confirm to confident
    echo.handleUserInput(encode('a'));
    terminal.setCell(0, 0, 'a');
    terminal.setCursor(1, 0);
    echo.onServerOutput();

    // Type 'b' and 'c'
    echo.handleUserInput(encode('bc'));

    // Server output arrives but only paints 'b' at col 1; col 2 remains empty ""
    terminal.setCell(0, 1, 'b');
    terminal.setCursor(2, 0);
    echo.onServerOutput();

    // 'b' is confirmed and removed; 'c' remains pending at col 2
    expect(echo.getState()).toBe('confident');
    expect(echo.getVisiblePredictions()).toEqual([{ row: 0, col: 2, char: 'c' }]);
  });

  it('reset() clears pending predictions while preserving confident state', () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // Reach confident
    echo.handleUserInput(encode('a'));
    terminal.setCell(0, 0, 'a');
    echo.onServerOutput();
    expect(echo.getState()).toBe('confident');

    echo.handleUserInput(encode('b'));
    expect(echo.getVisiblePredictions()).toHaveLength(1);

    // External event triggers reset (e.g. resize, scroll, tab switch)
    echo.reset('terminal resize');

    expect(echo.getVisiblePredictions()).toEqual([]);
    expect(echo.getState()).toBe('confident');
  });

  it('retains predictions pending when TUI cells already contain spaces (charBefore), and confirms when repainted', () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    // Simulate herdr full-screen TUI: input line cells are already filled with spaces " "
    terminal.setCell(0, 0, ' ');
    terminal.setCell(0, 1, ' ');

    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // User types 'a' (row 0, col 0); charBefore is recorded as " "
    echo.handleUserInput(encode('a'));

    // Intermediate server output arrives (e.g. status bar refresh), but cell (0, 0) is still " "
    terminal.setCell(1, 0, 'S');
    echo.onServerOutput();

    // Must NOT be treated as mismatch; remains pending in tentative
    expect(echo.getState()).toBe('tentative');

    // Server repaints cell (0, 0) with 'a'
    terminal.setCell(0, 0, 'a');
    echo.onServerOutput();

    // Confirmed and upgraded to confident
    expect(echo.getState()).toBe('confident');

    // Edge case: user types ' ' when cell was already ' ' (char === charBefore)
    echo.handleUserInput(encode(' '));
    terminal.setCell(0, 1, ' '); // Still space
    echo.onServerOutput();
    // Must remain pending and NOT demote to tentative
    expect(echo.getState()).toBe('confident');
  });

  it('suppresses new predictions after Enter until cursor actually moves in server output', () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // Promote to confident
    echo.handleUserInput(encode('a'));
    terminal.setCell(0, 0, 'a');
    echo.onServerOutput();
    expect(echo.getState()).toBe('confident');

    // User presses Enter (\r)
    echo.handleUserInput(encode('\r'));
    expect(echo.getVisiblePredictions()).toEqual([]);

    // Immediately typing another character while RTT is in flight
    // Terminal cursor is still stuck at old row 0, col 0. Prediction must be suppressed!
    echo.handleUserInput(encode('b'));
    expect(echo.getVisiblePredictions()).toEqual([]);

    // Server responds to Enter: moves cursor to next line (row 1, col 0)
    terminal.setCursor(0, 1);
    echo.onServerOutput(); // Clears suppression flag because cursor moved

    // "b" went out unpredicted and has not been drawn yet, so "c" lands after
    // it. Where "b" really lands is a guess until an echo proves it: hidden.
    echo.handleUserInput(encode('c'));
    expect(echo.getVisiblePredictions()).toEqual([]);

    // The server draws "b", then "c" where it was predicted: the guess was right.
    terminal.setCell(1, 0, 'b');
    terminal.setCell(1, 1, 'c');
    terminal.setCursor(2, 1);
    echo.onServerOutput();
    expect(echo.getMismatchCount()).toBe(0);
    expect(echo.getState()).toBe('confident');

    echo.handleUserInput(encode('d'));
    expect(echo.getVisiblePredictions()).toEqual([{ row: 1, col: 2, char: 'd' }]);
  });

  it('places the next key after text sent while suppressed that the server has already drawn', () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    echo.handleUserInput(encode('a'));
    terminal.setCell(0, 0, 'a');
    echo.onServerOutput();

    echo.handleUserInput(encode('\r'));
    echo.handleUserInput(encode('ls'));

    // The new prompt and the "l" arrive together; "s" is still on its way.
    terminal.setCell(1, 0, 'l');
    terminal.setCursor(1, 1);
    echo.onServerOutput();

    echo.handleUserInput(encode(' '));
    terminal.setCell(1, 1, 's');
    terminal.setCell(1, 2, ' ');
    terminal.setCursor(3, 1);
    echo.onServerOutput();
    expect(echo.getMismatchCount()).toBe(0);

    echo.handleUserInput(encode('-'));
    expect(echo.getVisiblePredictions()).toEqual([{ row: 1, col: 3, char: '-' }]);
  });

  it('drops a wrong guess after refused keys quietly, without demoting the field', () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    echo.handleUserInput(encode('a'));
    terminal.setCell(0, 0, 'a');
    echo.onServerOutput();

    echo.handleUserInput(encode('\r'));
    echo.handleUserInput(encode('b'));
    terminal.setCursor(0, 1);
    echo.onServerOutput();

    // Guessed after "b"; the program drew something else there instead.
    echo.handleUserInput(encode('c'));
    terminal.setCell(1, 0, 'x');
    terminal.setCell(1, 1, 'y');
    terminal.setCursor(2, 1);
    echo.onServerOutput();

    expect(echo.getMismatchCount()).toBe(0);
    expect(echo.getState()).toBe('confident');
    expect(echo.getVisiblePredictions()).toEqual([]);
  });

  it('maintains suppression after Enter when server output does not move cursor (e.g. status bar update)', () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 5, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // Reach confident
    echo.handleUserInput(encode('a'));
    terminal.setCell(0, 5, 'a');
    echo.onServerOutput();
    expect(echo.getState()).toBe('confident');

    // Press Enter -> suppressed at cursor (0, 5)
    echo.handleUserInput(encode('\r'));

    // Unrelated server output arrives (e.g. TUI clock or status bar) without cursor movement
    terminal.setCell(23, 0, 'clock');
    echo.onServerOutput();

    // Must still be suppressed!
    echo.handleUserInput(encode('x'));
    expect(echo.getVisiblePredictions()).toEqual([]);
  });

  it('lifts suppression via safety timeout fallback when cursor does not move', () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // Reach confident
    echo.handleUserInput(encode('a'));
    terminal.setCell(0, 0, 'a');
    echo.onServerOutput();
    expect(echo.getState()).toBe('confident');

    // Enter pressed at t=1000. SRTT is null, so threshold = max(300, 300) = 300ms
    echo.handleUserInput(encode('\r'));
    expect(echo.getVisiblePredictions()).toEqual([]);

    // 100ms later: below threshold, still suppressed
    currentTime += 100;
    terminal.setCell(23, 0, 'TUI repaint');
    echo.onServerOutput();
    echo.handleUserInput(encode('b'));
    expect(echo.getVisiblePredictions()).toEqual([]);

    // Advance time past 300ms threshold (total +305ms from sentAt)
    currentTime += 205; // now = 1305, delta = 305ms >= 300ms
    echo.onServerOutput();

    // Suppression lifted by safety timeout. "b" is still on its way to the
    // caret, so "c" goes after it, hidden until an echo proves the guess.
    echo.handleUserInput(encode('c'));
    expect(echo.getVisiblePredictions()).toEqual([]);
    terminal.setCell(0, 0, 'b');
    terminal.setCell(0, 1, 'c');
    terminal.setCursor(2, 0);
    echo.onServerOutput();
    echo.handleUserInput(encode('d'));
    expect(echo.getVisiblePredictions()).toEqual([{ row: 0, col: 2, char: 'd' }]);
  });

  it('predicts at once after the timeout when nothing was typed meanwhile', () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    echo.handleUserInput(encode('a'));
    terminal.setCell(0, 0, 'a');
    terminal.setCursor(1, 0);
    echo.onServerOutput();

    // An arrow key the program ignores: the caret never moves.
    echo.handleUserInput(encode('\x1b[D'));
    currentTime += 305;
    echo.onServerOutput();

    echo.handleUserInput(encode('c'));
    expect(echo.getVisiblePredictions()).toEqual([{ row: 0, col: 1, char: 'c' }]);
  });

  it('keeps suppressing while the keys typed before Enter are still being echoed', () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });
    echo.handleUserInput(encode('a'));
    terminal.setCell(0, 0, 'a');
    terminal.setCursor(1, 0);
    echo.onServerOutput();

    // "bcd" and Enter go out together; the echoes trail a round trip behind.
    echo.handleUserInput(encode('bcd'));
    echo.handleUserInput(encode('\r'));
    terminal.setCell(0, 1, 'b');
    terminal.setCursor(2, 0);
    echo.onServerOutput();

    // The caret moved, but only because "b" landed: Enter has not been seen yet.
    echo.handleUserInput(encode('x'));
    expect(echo.getVisiblePredictions().map((p) => p.char)).not.toContain('x');

    terminal.setCell(0, 2, 'c');
    terminal.setCell(0, 3, 'd');
    terminal.setCursor(4, 0);
    echo.onServerOutput();
    // Every key before Enter has landed, and the caret is where they left it.
    echo.handleUserInput(encode('y'));
    expect(echo.getVisiblePredictions().map((p) => p.char)).not.toContain('y');

    // Enter takes effect: a new line. "x" and "y" are on their way to it.
    terminal.setCursor(0, 1);
    echo.onServerOutput();
    expect(echo.getMismatchCount()).toBe(0);
    echo.handleUserInput(encode('z'));
    terminal.setCell(1, 0, 'x');
    terminal.setCell(1, 1, 'y');
    terminal.setCell(1, 2, 'z');
    terminal.setCursor(3, 1);
    echo.onServerOutput();
    expect(echo.getMismatchCount()).toBe(0);
    expect(echo.getState()).toBe('confident');
  });

  it('goes on predicting after a character of uncertain width, hidden until an echo proves the guess', () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now, charWidth: () => 1 });
    echo.handleUserInput(encode('a'));
    terminal.setCell(0, 0, 'a');
    terminal.setCursor(1, 0);
    echo.onServerOutput();

    echo.handleUserInput(encode('b╭c'));
    expect(echo.getVisiblePredictions()).toEqual([{ row: 0, col: 1, char: 'b' }]);

    terminal.setCell(0, 1, 'b');
    terminal.setCell(0, 2, '╭');
    terminal.setCell(0, 3, 'c');
    terminal.setCursor(4, 0);
    echo.onServerOutput();
    expect(echo.getMismatchCount()).toBe(0);

    echo.handleUserInput(encode('d'));
    expect(echo.getVisiblePredictions()).toEqual([{ row: 0, col: 4, char: 'd' }]);
  });

  it('predicts CJK characters two cells wide, and refuses characters of uncertain width', () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // Reach confident state
    echo.handleUserInput(encode('x'));
    terminal.setCell(0, 0, 'x');
    terminal.setCursor(1, 0);
    echo.onServerOutput();
    expect(echo.getState()).toBe('confident');

    // An IME commit arrives as one burst; each ideograph takes two cells
    echo.handleUserInput(encode('y中文'));
    expect(echo.getVisiblePredictions()).toEqual([
      { row: 0, col: 1, char: 'y' },
      { row: 0, col: 2, char: '中' },
      { row: 0, col: 4, char: '文' },
    ]);

    // Emoji width differs between terminals: it is not drawn, and nothing
    // after it is predicted until the server has caught up.
    echo.handleUserInput(encode('😀'));
    echo.handleUserInput(encode('z'));
    expect(echo.getVisiblePredictions().map((p) => p.char)).toEqual(['y', '中', '文']);
  });

  it("draws predictions in the style the field's echo came back in", () => {
    const RED = 0x1000000 | 1;
    let cursorX = 0;
    const cells = new Map<number, { chars: string; fg: number }>();
    const terminal: PredictionTerminal = {
      cols: 80,
      rows: 24,
      buffer: {
        active: {
          baseY: 0,
          cursorY: 0,
          get cursorX() {
            return cursorX;
          },
          getLine: () => ({
            getCell: (col: number) => {
              const cell = cells.get(col) ?? { chars: '', fg: 0 };
              return { getChars: () => cell.chars, fg: cell.fg, bg: 0 } as PredictionCell;
            },
          }),
        },
      },
    };
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    echo.handleUserInput(encode('a'));
    cells.set(0, { chars: 'a', fg: RED });
    // Drawn, but the caret has not passed it yet: the style is not final.
    echo.onServerOutput();
    echo.handleUserInput(encode('b'));
    expect(echo.getOverlayItems().find((item) => item.char === 'b')?.style).toBeUndefined();

    cursorX = 1;
    echo.onServerOutput();
    echo.handleUserInput(encode('c'));
    expect(echo.getOverlayItems().find((item) => item.char === 'c')?.style).toEqual({
      fg: RED,
      bg: 0,
      ext: 0,
    });
  });

  it('keeps painting an early echo until the caret passes it, and lets it go if redrawn', () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });
    echo.handleUserInput(encode('a'));
    terminal.setCell(0, 0, 'a');
    terminal.setCursor(1, 0);
    echo.onServerOutput();

    echo.handleUserInput(encode('b'));
    // fish draws "b" in its dim autosuggestion before it has processed the key.
    terminal.setCell(0, 1, 'b');
    echo.onServerOutput();
    expect(echo.getVisiblePredictions()).toEqual([]);
    expect(
      echo
        .getOverlayItems()
        .filter((item) => item.kind === 'char')
        .map((item) => item.char),
    ).toEqual(['b']);

    // Then something else is drawn there before the caret passed: not ours to paint.
    terminal.setCell(0, 1, 'x');
    echo.onServerOutput();
    expect(echo.getOverlayItems()).toEqual([]);
    expect(echo.getMismatchCount()).toBe(0);
  });

  it('predicts the next line at once after Enter when every key before it was drawn', () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now, charWidth: () => 1 });
    echo.handleUserInput(encode('a'));
    terminal.setCell(0, 0, 'a');
    terminal.setCursor(1, 0);
    echo.onServerOutput();

    // An undrawn guess in the middle, drawn keys after it, then Enter.
    echo.handleUserInput(encode('╭bc\r'));
    terminal.setCell(0, 1, '╭');
    terminal.setCell(0, 2, 'b');
    terminal.setCell(0, 3, 'c');
    terminal.setCursor(0, 1);
    echo.onServerOutput();

    echo.handleUserInput(encode('x'));
    expect(echo.getVisiblePredictions()).toEqual([{ row: 1, col: 0, char: 'x' }]);
  });

  it('keeps the next line hidden until proven when the last key before Enter was not drawn', () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now, charWidth: () => 1 });
    echo.handleUserInput(encode('a'));
    terminal.setCell(0, 0, 'a');
    terminal.setCursor(1, 0);
    echo.onServerOutput();

    echo.handleUserInput(encode('b╭\r'));
    terminal.setCell(0, 1, 'b');
    terminal.setCursor(2, 0);
    echo.onServerOutput();
    // "b" has landed and the caret moved, but "╭" and Enter are still on their way.
    terminal.setCursor(0, 1);
    echo.onServerOutput();

    echo.handleUserInput(encode('x'));
    expect(echo.getVisiblePredictions()).toEqual([]);
    terminal.setCell(1, 0, 'x');
    terminal.setCursor(1, 1);
    echo.onServerOutput();
    echo.handleUserInput(encode('y'));
    expect(echo.getVisiblePredictions()).toEqual([{ row: 1, col: 1, char: 'y' }]);
  });

  it('handles null terminal gracefully without throwing', () => {
    let terminalAvailable = false;
    const terminal = createMockTerminal();
    const echo = new PredictiveEcho({
      getTerminal: () => (terminalAvailable ? terminal : null),
      now,
    });

    // Should not throw when terminal is null
    expect(() => echo.handleUserInput(encode('a'))).not.toThrow();
    expect(() => echo.onServerOutput()).not.toThrow();
    expect(echo.getVisiblePredictions()).toEqual([]);

    terminalAvailable = true;
    expect(() => echo.handleUserInput(encode('a'))).not.toThrow();
  });
});
