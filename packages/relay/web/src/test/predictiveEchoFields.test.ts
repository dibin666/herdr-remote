import { describe, it, expect, beforeEach } from "vitest";
import { PredictiveEcho } from "../utils/predictiveEcho";
import { InputFieldTracker } from "../utils/inputField";
import { loadScreenFixture, screenFromFixture, type TestScreen } from "./helpers/screenFixture";

/**
 * The predictor wired to the real input-field detector, typing into screens
 * captured from Herdr. `echo()` plays the part of the remote program: it
 * paints what was typed and moves the caret, as Claude or fish would.
 */
let currentTime = 1000;
const now = () => currentTime;
const encoder = new TextEncoder();
const type = (echo: PredictiveEcho, text: string) => echo.handleUserInput(encoder.encode(text));

function setup(fixture: string) {
  let screen: TestScreen = screenFromFixture(loadScreenFixture(fixture));
  const tracker = new InputFieldTracker();
  const echo = new PredictiveEcho({
    getTerminal: () => screen,
    getField: () => tracker.detect(screen, screen.cursor),
    now,
  });
  return {
    echo,
    get screen() {
      return screen;
    },
    show(next: string) {
      screen = screenFromFixture(loadScreenFixture(next));
    },
    /** The remote program echoes `text` at the caret and advances it. */
    remoteEcho(text: string) {
      screen.write(screen.cursor.row, screen.cursor.col, text);
      let col = screen.cursor.col;
      for (const ch of text) col += /[　-鿿]/.test(ch) ? 2 : 1;
      screen.setCursor(col, screen.cursor.row);
      currentTime += 120;
      echo.onServerOutput();
    },
  };
}

beforeEach(() => {
  currentTime = 1000;
});

describe("PredictiveEcho in Claude Code's input box", () => {
  it("earns confidence from one echo, then predicts the next keys ahead of the server", () => {
    const t = setup("desktop-claude-empty");
    type(t.echo, "h");
    expect(t.echo.getVisiblePredictions()).toEqual([]);
    t.remoteEcho("h");
    expect(t.echo.getState()).toBe("confident");

    type(t.echo, "i");
    expect(t.echo.getVisiblePredictions()).toEqual([{ row: 34, col: 29, char: "i" }]);
    // The predicted caret sits where the next key will land.
    expect(t.echo.getOverlayItems()).toContainEqual({ row: 34, col: 30, char: " ", width: 1, kind: "caret" });
  });

  it("predicts Chinese from an IME commit two cells per character, and confirms it", () => {
    const t = setup("desktop-claude-empty");
    type(t.echo, "a");
    t.remoteEcho("a");
    type(t.echo, "你好");
    expect(t.echo.getVisiblePredictions()).toEqual([
      { row: 34, col: 29, char: "你" },
      { row: 34, col: 31, char: "好" },
    ]);
    t.remoteEcho("你好");
    expect(t.echo.getVisiblePredictions()).toEqual([]);
    expect(t.echo.getMismatchCount()).toBe(0);
    expect(t.echo.getState()).toBe("confident");
  });

  it("counts a one-cell echo of a two-cell prediction as a mismatch", () => {
    const t = setup("desktop-claude-empty");
    type(t.echo, "a");
    t.remoteEcho("a");
    type(t.echo, "你");
    t.screen.setCell(34, 29, { chars: "你", width: 1 });
    t.screen.setCursor(30, 34);
    t.echo.onServerOutput();
    expect(t.echo.getMismatchCount()).toBe(1);
    expect(t.echo.getState()).toBe("tentative");
  });

  it("demotes on a lone Escape, so vim normal-mode keys never show as text", () => {
    const t = setup("desktop-claude-typed");
    type(t.echo, "l");
    t.remoteEcho("l");
    expect(t.echo.getState()).toBe("confident");

    type(t.echo, "\x1b");
    currentTime += 2000; // past suppression
    type(t.echo, "j");
    expect(t.echo.getVisiblePredictions()).toEqual([]);
    expect(t.echo.getState()).toBe("tentative");
  });

  it("does not predict in normal mode once the box has shown -- INSERT --", () => {
    const t = setup("desktop-claude-typed");
    type(t.echo, "x");
    t.echo.reset("test", { suppress: false });
    t.show("desktop-claude-normal");
    type(t.echo, "h");
    expect(t.echo.getField()?.key).not.toBe("none");
    expect(t.echo.getOverlayItems()).toEqual([]);
    // No run was started: the key went to the server untouched.
    t.screen.setCursor(35, 34);
    t.echo.onServerOutput();
    expect(t.echo.getMismatchCount()).toBe(0);
  });

  it("holds back `?` and `!` typed into an empty box, which switch modes instead of inserting", () => {
    const t = setup("desktop-claude-empty");
    type(t.echo, "a");
    t.remoteEcho("a");
    t.show("desktop-claude-empty");
    type(t.echo, "?");
    expect(t.echo.getVisiblePredictions()).toEqual([]);
    currentTime += 2000;
    type(t.echo, "/");
    expect(t.echo.getVisiblePredictions()).toEqual([{ row: 34, col: 28, char: "/" }]);
  });

  it("predicts a backspace over the text Claude drew, and covers the old caret", () => {
    const t = setup("desktop-claude-typed"); // "❯ hello wor", caret at 37
    type(t.echo, "l");
    t.remoteEcho("l");
    type(t.echo, "\x7f");
    const items = t.echo.getOverlayItems();
    expect(items).toContainEqual({ row: 34, col: 37, char: " ", width: 1, kind: "erase" });
    expect(items).toContainEqual({ row: 34, col: 38, char: " ", width: 1, kind: "erase" });
    expect(items).toContainEqual({ row: 34, col: 37, char: " ", width: 1, kind: "caret" });

    // Claude clears the cell and steps the caret back.
    t.screen.setCell(34, 37, { chars: "" });
    t.screen.setCursor(37, 34);
    t.echo.onServerOutput();
    expect(t.echo.getVisiblePredictions()).toEqual([]);
    expect(t.echo.getMismatchCount()).toBe(0);
  });

  it("never predicts erasing the first character of the field", () => {
    const t = setup("desktop-claude-empty");
    type(t.echo, "a");
    t.remoteEcho("a");
    type(t.echo, "\x7f");
    expect(t.echo.getVisiblePredictions()).toEqual([]);
  });

  it("ends the run quietly when the box grows upwards as the text wraps", () => {
    const t = setup("mobile-claude-empty"); // rules at 23 and 25, input row 24
    type(t.echo, "a");
    t.remoteEcho("a");
    type(t.echo, "bcd");
    // Claude wraps: the box gains a row above, "a" moves up, "bcd" continues below.
    t.screen.write(22, 0, "─".repeat(48));
    t.screen.write(23, 0, "❯ a".padEnd(48));
    t.screen.write(24, 0, "  bcd".padEnd(48));
    t.screen.setCursor(5, 24);
    t.echo.onServerOutput();
    expect(t.echo.getVisiblePredictions()).toEqual([]);
    expect(t.echo.getMismatchCount()).toBe(0);
    expect(t.echo.getState()).toBe("confident");
    // The next key starts a fresh run from the server's caret.
    type(t.echo, "e");
    expect(t.echo.getVisiblePredictions()).toEqual([{ row: 24, col: 5, char: "e" }]);
  });

  it("wipes and demotes when the field vanishes while predictions are in flight", () => {
    const t = setup("desktop-claude-empty");
    type(t.echo, "a");
    t.remoteEcho("a");
    type(t.echo, "b");
    t.show("desktop-claude-model-menu");
    t.echo.onServerOutput();
    expect(t.echo.getVisiblePredictions()).toEqual([]);
    expect(t.echo.getState()).toBe("tentative");
  });
});

describe("PredictiveEcho outside input fields", () => {
  it.each(["desktop-claude-model-menu", "desktop-claude-trust", "desktop-herdr-help", "desktop-less", "desktop-vim-normal", "desktop-pi-settings"])(
    "predicts nothing on %s",
    (fixture) => {
      const t = setup(fixture);
      type(t.echo, "j");
      t.remoteEcho("j");
      type(t.echo, "k");
      expect(t.echo.getVisiblePredictions()).toEqual([]);
      expect(t.echo.getOverlayItems()).toEqual([]);
      expect(t.echo.getState()).toBe("tentative");
    },
  );

  it("does not lend one field's confidence to another", () => {
    const t = setup("desktop-claude-empty");
    type(t.echo, "a");
    t.remoteEcho("a");
    expect(t.echo.getState()).toBe("confident");
    t.show("desktop-fish-empty");
    type(t.echo, "l");
    expect(t.echo.getVisiblePredictions()).toEqual([]);
    expect(t.echo.getState()).toBe("tentative");
  });

  it("gives up on the key after Herdr's prefix, and demotes", () => {
    const t = setup("desktop-fish-empty");
    type(t.echo, "e");
    t.remoteEcho("e");
    type(t.echo, "\x02");
    type(t.echo, "c");
    expect(t.echo.getVisiblePredictions()).toEqual([]);
    expect(t.echo.getState()).toBe("tentative");
  });
});

describe("PredictiveEcho and pointer traffic", () => {
  it("keeps predictions through hover and focus reports, and drops them on a click", () => {
    const t = setup("desktop-fish-empty");
    type(t.echo, "e");
    t.remoteEcho("e");
    type(t.echo, "c");
    expect(t.echo.getVisiblePredictions()).toHaveLength(1);

    type(t.echo, "\x1b[<35;40;10M\x1b[<35;41;10M");
    type(t.echo, "\x1b[O\x1b[I");
    expect(t.echo.getVisiblePredictions()).toHaveLength(1);

    type(t.echo, "\x1b[<0;40;10M");
    expect(t.echo.getVisiblePredictions()).toEqual([]);
  });

  it("predicts right up to the last cell of the field, never into it", () => {
    const t = setup("mobile-claude-empty");
    type(t.echo, "a");
    t.remoteEcho("a");
    type(t.echo, "b".repeat(44));
    expect(t.echo.getVisiblePredictions()).toHaveLength(44);
    expect(t.echo.getVisiblePredictions().at(-1)?.col).toBe(46);
    type(t.echo, "c");
    expect(t.echo.getVisiblePredictions()).toEqual([]);
  });
});
