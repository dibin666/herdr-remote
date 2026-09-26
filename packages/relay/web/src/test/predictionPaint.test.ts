import { describe, it, expect } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { PredictionLayer, type OverlayTarget } from '../utils/predictionPaint';
import type { OverlayItem } from '../utils/predictionModel';
import type { PaintOverlay } from '../render/HerdrRenderer';

const RGB = 0x3000000;
const INVERSE = 0x4000000;
const WHITE_BG = RGB | 0xffffff;

interface FakeCell {
  chars: string;
  fg: number;
  bg: number;
}

/** A buffer whose cells carry xterm's raw fg/bg words, as the public API's cells do in 5.5. */
function fakeTerminal(cursor: { row: number; col: number }) {
  const cells = new Map<string, FakeCell>();
  const terminal = {
    cols: 40,
    rows: 10,
    buffer: {
      active: {
        baseY: 0,
        get cursorX() {
          return cursor.col;
        },
        get cursorY() {
          return cursor.row;
        },
        getLine: (row: number) => ({
          getCell: (col: number) => {
            const cell = cells.get(`${row}:${col}`) ?? { chars: '', fg: 0, bg: 0 };
            return { getChars: () => cell.chars, fg: cell.fg, bg: cell.bg };
          },
        }),
      },
    },
  };
  return {
    terminal: terminal as unknown as Terminal,
    set(row: number, col: number, cell: Partial<FakeCell>) {
      cells.set(`${row}:${col}`, { chars: '', fg: 0, bg: 0, ...cell });
    },
  };
}

function recordingTarget() {
  const target = {
    provider: null as (() => PaintOverlay | null) | null,
    invalidations: 0,
    setOverlayProvider(provider: (() => PaintOverlay | null) | null) {
      target.provider = provider;
    },
    invalidateOverlay() {
      target.invalidations += 1;
    },
  };
  return target satisfies OverlayTarget;
}

const typed = { fg: 0, bg: 0, ext: 0 };

describe('PredictionLayer', () => {
  it("draws a program's own caret where the next key lands, in the program's style", () => {
    // Claude: the terminal cursor is hidden and a white cell stands in for it.
    const screen = fakeTerminal({ row: 5, col: 3 });
    screen.set(5, 3, { chars: ' ', bg: WHITE_BG });
    const layer = new PredictionLayer({
      getTerminal: () => screen.terminal,
      isCursorHidden: () => true,
    });
    const items: OverlayItem[] = [
      { row: 5, col: 3, char: 'i', width: 1, kind: 'char', style: typed },
      { row: 5, col: 4, char: ' ', width: 1, kind: 'caret' },
    ];
    layer.sync(items);

    const overlay = layer.paint();
    expect(overlay).toEqual({
      cells: [
        { row: 5, col: 3, chars: 'i', width: 1, style: typed },
        { row: 5, col: 4, chars: ' ', width: 1, style: { fg: 0, bg: WHITE_BG, ext: 0 } },
      ],
    });
  });

  it("covers the program's caret a round trip behind with plain text", () => {
    const screen = fakeTerminal({ row: 5, col: 8 });
    screen.set(5, 8, { chars: ' ', fg: INVERSE, bg: 0 });
    const layer = new PredictionLayer({
      getTerminal: () => screen.terminal,
      isCursorHidden: () => true,
    });
    layer.sync([
      { row: 5, col: 7, char: ' ', width: 1, kind: 'erase', style: typed },
      { row: 5, col: 8, char: ' ', width: 1, kind: 'mask' },
      { row: 5, col: 7, char: ' ', width: 1, kind: 'caret' },
    ]);

    const cells = layer.paint()!.cells;
    expect(cells).toContainEqual({
      row: 5,
      col: 8,
      chars: ' ',
      width: 1,
      style: { fg: 0, bg: 0, ext: 0 },
    });
    expect(cells).toContainEqual({
      row: 5,
      col: 7,
      chars: ' ',
      width: 1,
      style: { fg: INVERSE, bg: 0, ext: 0 },
    });
  });

  it('moves the terminal cursor itself when the program shows it', () => {
    const screen = fakeTerminal({ row: 2, col: 10 });
    const layer = new PredictionLayer({
      getTerminal: () => screen.terminal,
      isCursorHidden: () => false,
    });
    layer.sync([
      { row: 2, col: 10, char: 'l', width: 1, kind: 'char', style: typed },
      { row: 2, col: 11, char: ' ', width: 1, kind: 'caret' },
    ]);

    expect(layer.paint()).toEqual({
      cells: [{ row: 2, col: 10, chars: 'l', width: 1, style: typed }],
      cursor: { row: 2, col: 11 },
    });
  });

  it('draws no caret when the program shows none', () => {
    const screen = fakeTerminal({ row: 2, col: 10 });
    const layer = new PredictionLayer({
      getTerminal: () => screen.terminal,
      isCursorHidden: () => true,
    });
    layer.sync([
      { row: 2, col: 10, char: 'l', width: 1, kind: 'char', style: typed },
      { row: 2, col: 11, char: ' ', width: 1, kind: 'caret' },
    ]);

    expect(layer.paint()).toEqual({
      cells: [{ row: 2, col: 10, chars: 'l', width: 1, style: typed }],
    });
  });

  it("guesses a field's text style from the text to its left before any echo", () => {
    const screen = fakeTerminal({ row: 1, col: 5 });
    screen.set(1, 4, { chars: 'x', fg: 0x1000000 | 3, bg: 0 });
    const layer = new PredictionLayer({
      getTerminal: () => screen.terminal,
      isCursorHidden: () => false,
    });
    layer.sync([{ row: 1, col: 5, char: 'y', width: 1, kind: 'char' }]);

    expect(layer.paint()!.cells[0].style).toEqual({ fg: 0x1000000 | 3, bg: 0, ext: 0 });
  });

  it('tells the renderer when the overlay changes, and only then', () => {
    const screen = fakeTerminal({ row: 0, col: 0 });
    const layer = new PredictionLayer({
      getTerminal: () => screen.terminal,
      isCursorHidden: () => false,
    });
    const target = recordingTarget();
    layer.attach(target);
    expect(target.provider).not.toBeNull();

    layer.clear();
    expect(target.invalidations).toBe(0);
    layer.sync([{ row: 0, col: 0, char: 'a', width: 1, kind: 'char' }]);
    expect(target.invalidations).toBe(1);
    layer.clear();
    expect(target.invalidations).toBe(2);
    expect(layer.paint()).toBeNull();

    layer.attach(null);
    expect(target.provider).toBeNull();
  });
});
