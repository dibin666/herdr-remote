import { describe, it, expect, beforeEach } from "vitest";
import {
  PredictiveEcho,
  type PredictionTerminal,
  type PredictionLine,
  type PredictionCell,
} from "../utils/predictiveEcho";

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
        const chars = rowMap?.get(col) ?? "";
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

describe("PredictiveEcho State Machine & Verification", () => {
  let currentTime = 1000;
  const now = () => currentTime;

  beforeEach(() => {
    currentTime = 1000;
  });

  // Requirement 1
  it("starts in tentative state and keeps predictions hidden when typing multiple characters", () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    expect(echo.getState()).toBe("tentative");

    echo.handleUserInput(encode("abc"));

    // Predictions are calculated internally but must remain completely invisible
    // to prevent leaking ghost characters before confirmation
    expect(echo.getVisiblePredictions()).toEqual([]);
    expect(echo.getState()).toBe("tentative");
  });

  // Requirement 2
  it("transitions to confident on matching server output, making subsequent predictions visible", () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 5, cursorY: 2, baseY: 10 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // User types 'x' at cursor position (absolute row = baseY + cursorY = 12, col = 5)
    echo.handleUserInput(encode("x"));
    expect(echo.getVisiblePredictions()).toEqual([]);

    // Server output arrives and paints 'x' at (12, 5)
    terminal.setCell(12, 5, "x");
    currentTime += 50;
    echo.onServerOutput();

    // Proven that host is echoing: upgraded to confident
    expect(echo.getState()).toBe("confident");

    // Next character typed by user should immediately be visible in getVisiblePredictions()
    echo.handleUserInput(encode("y"));
    const visible = echo.getVisiblePredictions();
    expect(visible).toEqual([{ row: 12, col: 6, char: "y" }]);
  });

  // Requirement 3
  it("wipes all predictions and reverts to tentative when server output mismatches", () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // First confirm one character to reach confident state
    echo.handleUserInput(encode("a"));
    terminal.setCell(0, 0, "a");
    echo.onServerOutput();
    expect(echo.getState()).toBe("confident");

    // Now user types 'b' (predicted at 0, 1) and 'c' (predicted at 0, 2)
    echo.handleUserInput(encode("bc"));
    expect(echo.getVisiblePredictions()).toHaveLength(2);

    // Server paints something unexpected at (0, 1), e.g. password asterisk or autocomplete
    terminal.setCell(0, 1, "*");
    echo.onServerOutput();

    // Must immediately wipe all predictions and drop to tentative
    expect(echo.getState()).toBe("tentative");
    expect(echo.getVisiblePredictions()).toEqual([]);
  });

  // Requirement 4
  it("clears active predictions and does not predict on Enter, arrow keys, Ctrl-C, Tab, or CSI sequences", () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // Reach confident state
    echo.handleUserInput(encode("z"));
    terminal.setCell(0, 0, "z");
    echo.onServerOutput();
    expect(echo.getState()).toBe("confident");

    // Helper to generate a visible prediction
    const seedPrediction = () => {
      currentTime += 301; // Advance past suppression threshold
      echo.onServerOutput();
      echo.handleUserInput(encode("k"));
      expect(echo.getVisiblePredictions().length).toBeGreaterThan(0);
    };

    // 1. Carriage return / Enter (\r)
    seedPrediction();
    echo.handleUserInput(encode("\r"));
    expect(echo.getVisiblePredictions()).toEqual([]);

    // 2. Line feed (\n)
    seedPrediction();
    echo.handleUserInput(encode("\n"));
    expect(echo.getVisiblePredictions()).toEqual([]);

    // 3. Tab (\t)
    seedPrediction();
    echo.handleUserInput(encode("\t"));
    expect(echo.getVisiblePredictions()).toEqual([]);

    // 4. Arrow keys (Up: \x1b[A)
    seedPrediction();
    echo.handleUserInput(encode("\x1b[A"));
    expect(echo.getVisiblePredictions()).toEqual([]);

    // 5. Ctrl-C (0x03)
    seedPrediction();
    echo.handleUserInput(new Uint8Array([0x03]));
    expect(echo.getVisiblePredictions()).toEqual([]);

    // 6. Arbitrary CSI sequence (\x1b[2J)
    seedPrediction();
    echo.handleUserInput(encode("\x1b[2J"));
    expect(echo.getVisiblePredictions()).toEqual([]);
  });

  // Requirement 5
  it("handles backspace by undoing local predictions or resetting when backspacing into server content", () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // Promote to confident
    echo.handleUserInput(encode("x"));
    terminal.setCell(0, 0, "x");
    echo.onServerOutput();
    expect(echo.getState()).toBe("confident");

    // User types 'a' (col 1) and 'b' (col 2)
    echo.handleUserInput(encode("ab"));
    expect(echo.getVisiblePredictions()).toEqual([
      { row: 0, col: 1, char: "a" },
      { row: 0, col: 2, char: "b" },
    ]);

    // Backspace (0x08) pops the last prediction 'b'
    echo.handleUserInput(new Uint8Array([0x08]));
    expect(echo.getVisiblePredictions()).toEqual([{ row: 0, col: 1, char: "a" }]);

    // Typing a new character 'c' lands at the vacated col 2
    echo.handleUserInput(encode("c"));
    expect(echo.getVisiblePredictions()).toEqual([
      { row: 0, col: 1, char: "a" },
      { row: 0, col: 2, char: "c" },
    ]);

    // DEL / backspace (0x7f) pops 'c'
    echo.handleUserInput(new Uint8Array([0x7f]));
    expect(echo.getVisiblePredictions()).toEqual([{ row: 0, col: 1, char: "a" }]);

    // Another backspace pops 'a'
    echo.handleUserInput(new Uint8Array([0x7f]));
    expect(echo.getVisiblePredictions()).toEqual([]);

    // Now there are no local predictions left.
    // Backspacing further touches server-rendered characters -> wipes speculation safely
    echo.handleUserInput(new Uint8Array([0x7f]));
    expect(echo.getVisiblePredictions()).toEqual([]);
  });

  // Requirement 6
  it("stops predicting and clears all predictions when cursor would reach or exceed line width (cols)", () => {
    const terminal = createMockTerminal({ cols: 4, rows: 10, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // Promote to confident
    echo.handleUserInput(encode("a"));
    terminal.setCell(0, 0, "a");
    echo.onServerOutput();
    expect(echo.getState()).toBe("confident");

    // User types 'b' (col 1), 'c' (col 2)
    echo.handleUserInput(encode("bc"));
    expect(echo.getVisiblePredictions()).toEqual([
      { row: 0, col: 1, char: "b" },
      { row: 0, col: 2, char: "c" },
    ]);

    // Typing 'd' would advance cursor to col 4 (equals cols: 4)
    // Margin wrapping behavior cannot be inferred reliably -> abort and wipe
    echo.handleUserInput(encode("d"));
    expect(echo.getVisiblePredictions()).toEqual([]);

    // If terminal cursor is already at or beyond cols, any typing is refused
    terminal.setCursor(4, 0);
    echo.handleUserInput(encode("z"));
    expect(echo.getVisiblePredictions()).toEqual([]);
  });

  // Requirement 7
  it("prunes predictions older than 1500ms without demoting confident state", () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // Confirm initial character at t=1000
    echo.handleUserInput(encode("a"));
    terminal.setCell(0, 0, "a");
    echo.onServerOutput();
    expect(echo.getState()).toBe("confident");

    // User types 'b' at t=1000
    echo.handleUserInput(encode("b"));
    expect(echo.getVisiblePredictions()).toHaveLength(1);

    // Time advances past 1500ms timeout
    currentTime += 1501;

    // Pruning drops stale prediction without treating it as a mismatch error
    expect(echo.getVisiblePredictions()).toEqual([]);
    expect(echo.getState()).toBe("confident");
  });

  // Requirement 8
  it("computes exponentially smoothed SRTT (srtt = srtt * 0.8 + sample * 0.2) on confirmations", () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    expect(echo.getEchoSrttMs()).toBeNull();

    // First keystroke at t=1000
    echo.handleUserInput(encode("a"));
    terminal.setCell(0, 0, "a");

    // Confirmed at t=1100 (100ms sample)
    currentTime = 1100;
    echo.onServerOutput();
    expect(echo.getEchoSrttMs()).toBe(100);

    // Second keystroke at t=1200
    currentTime = 1200;
    echo.handleUserInput(encode("b"));
    terminal.setCell(0, 1, "b");

    // Confirmed at t=1400 (200ms sample)
    // Smoothed SRTT = 100 * 0.8 + 200 * 0.2 = 80 + 40 = 120
    currentTime = 1400;
    echo.onServerOutput();
    expect(echo.getEchoSrttMs()).toBeCloseTo(120, 4);
  });

  // Additional edge-case & resilience tests
  it("retains pending predictions when server output cell is empty (untouched cell)", () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // Confirm to confident
    echo.handleUserInput(encode("a"));
    terminal.setCell(0, 0, "a");
    echo.onServerOutput();

    // Type 'b' and 'c'
    echo.handleUserInput(encode("bc"));

    // Server output arrives but only paints 'b' at col 1; col 2 remains empty ""
    terminal.setCell(0, 1, "b");
    echo.onServerOutput();

    // 'b' is confirmed and removed; 'c' remains pending at col 2
    expect(echo.getState()).toBe("confident");
    expect(echo.getVisiblePredictions()).toEqual([{ row: 0, col: 2, char: "c" }]);
  });

  it("reset() clears pending predictions while preserving confident state", () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // Reach confident
    echo.handleUserInput(encode("a"));
    terminal.setCell(0, 0, "a");
    echo.onServerOutput();
    expect(echo.getState()).toBe("confident");

    echo.handleUserInput(encode("b"));
    expect(echo.getVisiblePredictions()).toHaveLength(1);

    // External event triggers reset (e.g. resize, scroll, tab switch)
    echo.reset("terminal resize");

    expect(echo.getVisiblePredictions()).toEqual([]);
    expect(echo.getState()).toBe("confident");
  });

  it("retains predictions pending when TUI cells already contain spaces (charBefore), and confirms when repainted", () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    // Simulate herdr full-screen TUI: input line cells are already filled with spaces " "
    terminal.setCell(0, 0, " ");
    terminal.setCell(0, 1, " ");

    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // User types 'a' (row 0, col 0); charBefore is recorded as " "
    echo.handleUserInput(encode("a"));

    // Intermediate server output arrives (e.g. status bar refresh), but cell (0, 0) is still " "
    terminal.setCell(1, 0, "S");
    echo.onServerOutput();

    // Must NOT be treated as mismatch; remains pending in tentative
    expect(echo.getState()).toBe("tentative");

    // Server repaints cell (0, 0) with 'a'
    terminal.setCell(0, 0, "a");
    echo.onServerOutput();

    // Confirmed and upgraded to confident
    expect(echo.getState()).toBe("confident");

    // Edge case: user types ' ' when cell was already ' ' (char === charBefore)
    echo.handleUserInput(encode(" "));
    terminal.setCell(0, 1, " "); // Still space
    echo.onServerOutput();
    // Must remain pending and NOT demote to tentative
    expect(echo.getState()).toBe("confident");
  });

  it("suppresses new predictions after Enter until cursor actually moves in server output", () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // Promote to confident
    echo.handleUserInput(encode("a"));
    terminal.setCell(0, 0, "a");
    echo.onServerOutput();
    expect(echo.getState()).toBe("confident");

    // User presses Enter (\r)
    echo.handleUserInput(encode("\r"));
    expect(echo.getVisiblePredictions()).toEqual([]);

    // Immediately typing another character while RTT is in flight
    // Terminal cursor is still stuck at old row 0, col 0. Prediction must be suppressed!
    echo.handleUserInput(encode("b"));
    expect(echo.getVisiblePredictions()).toEqual([]);

    // Server responds to Enter: moves cursor to next line (row 1, col 0)
    terminal.setCursor(0, 1);
    echo.onServerOutput(); // Clears suppression flag because cursor moved

    // Next typed character can now be predicted from the new cursor position
    echo.handleUserInput(encode("c"));
    expect(echo.getVisiblePredictions()).toEqual([{ row: 1, col: 0, char: "c" }]);
  });

  it("maintains suppression after Enter when server output does not move cursor (e.g. status bar update)", () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 5, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // Reach confident
    echo.handleUserInput(encode("a"));
    terminal.setCell(0, 5, "a");
    echo.onServerOutput();
    expect(echo.getState()).toBe("confident");

    // Press Enter -> suppressed at cursor (0, 5)
    echo.handleUserInput(encode("\r"));

    // Unrelated server output arrives (e.g. TUI clock or status bar) without cursor movement
    terminal.setCell(23, 0, "clock");
    echo.onServerOutput();

    // Must still be suppressed!
    echo.handleUserInput(encode("x"));
    expect(echo.getVisiblePredictions()).toEqual([]);
  });

  it("lifts suppression via safety timeout fallback when cursor does not move", () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // Reach confident
    echo.handleUserInput(encode("a"));
    terminal.setCell(0, 0, "a");
    echo.onServerOutput();
    expect(echo.getState()).toBe("confident");

    // Enter pressed at t=1000. SRTT is null, so threshold = max(300, 300) = 300ms
    echo.handleUserInput(encode("\r"));
    expect(echo.getVisiblePredictions()).toEqual([]);

    // 100ms later: below threshold, still suppressed
    currentTime += 100;
    terminal.setCell(23, 0, "TUI repaint");
    echo.onServerOutput();
    echo.handleUserInput(encode("b"));
    expect(echo.getVisiblePredictions()).toEqual([]);

    // Advance time past 300ms threshold (total +305ms from sentAt)
    currentTime += 205; // now = 1305, delta = 305ms >= 300ms
    echo.onServerOutput();

    // Suppression lifted by safety timeout
    echo.handleUserInput(encode("c"));
    expect(echo.getVisiblePredictions()).toEqual([{ row: 0, col: 0, char: "c" }]);
  });

  it("refuses to predict CJK/wide characters and wipes existing predictions", () => {
    const terminal = createMockTerminal({ cols: 80, rows: 24, cursorX: 0, cursorY: 0 });
    const echo = new PredictiveEcho({ getTerminal: () => terminal, now });

    // Reach confident state
    echo.handleUserInput(encode("x"));
    terminal.setCell(0, 0, "x");
    echo.onServerOutput();
    expect(echo.getState()).toBe("confident");

    // Type ASCII character
    echo.handleUserInput(encode("y"));
    expect(echo.getVisiblePredictions()).toEqual([{ row: 0, col: 1, char: "y" }]);

    // User types Chinese character (codePoint > 0x7e)
    echo.handleUserInput(encode("中"));

    // Must wipe existing predictions and not produce new predictions
    expect(echo.getVisiblePredictions()).toEqual([]);
  });

  it("handles null terminal gracefully without throwing", () => {
    let terminalAvailable = false;
    const terminal = createMockTerminal();
    const echo = new PredictiveEcho({
      getTerminal: () => (terminalAvailable ? terminal : null),
      now,
    });

    // Should not throw when terminal is null
    expect(() => echo.handleUserInput(encode("a"))).not.toThrow();
    expect(() => echo.onServerOutput()).not.toThrow();
    expect(echo.getVisiblePredictions()).toEqual([]);

    terminalAvailable = true;
    expect(() => echo.handleUserInput(encode("a"))).not.toThrow();
  });
});
