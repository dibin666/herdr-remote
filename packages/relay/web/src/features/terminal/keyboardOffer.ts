// Where the floating "show keyboard" button sits: next to the live cursor, on
// cells that hold nothing, so it never hides output, the prompt or the input.

import type { Terminal } from '@xterm/xterm';
import { measureCellDimensions } from './terminalFit';

/** Comfortable touch target; shrunk to one row when no blank square is near. */
const OFFER_TARGET_PX = 36;
const OFFER_COMPACT_WIDTH_PX = 32;

export interface OfferGrid {
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  cursorCol: number;
  /** Viewport row of the cursor. */
  cursorRow: number;
  /** Whether the viewport cell holds a glyph (or is the cursor). */
  occupied: (row: number, col: number) => boolean;
}

/** The cells the button covers, in viewport coordinates. */
export interface OfferBox {
  row: number;
  col: number;
  rows: number;
  cols: number;
}

/**
 * The blank box nearest the cursor that fits the button.
 *
 * A square spanning a few rows is the better target, but an input field framed
 * by a border has one blank row; a one-row pill beside the cursor then beats a
 * square further away. Only if no blank box exists anywhere does the button
 * cover something, and then as little as it can.
 */
export function placeKeyboardOffer(grid: OfferGrid): OfferBox | null {
  const { cols, rows, cellWidth, cellHeight, cursorCol, cursorRow } = grid;
  if (cols <= 0 || rows <= 0 || cellWidth <= 0 || cellHeight <= 0) return null;
  if (cursorRow < 0 || cursorRow >= rows) return null;

  // Prefix sums make every candidate's covered-glyph count O(1).
  const sums = new Int32Array((rows + 1) * (cols + 1));
  const at = (r: number, c: number) => r * (cols + 1) + c;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const filled = (r === cursorRow && c === cursorCol) || grid.occupied(r, c) ? 1 : 0;
      sums[at(r + 1, c + 1)] = filled + sums[at(r, c + 1)] + sums[at(r + 1, c)] - sums[at(r, c)];
    }
  }
  const covered = (r: number, c: number, h: number, w: number) =>
    sums[at(r + h, c + w)] - sums[at(r, c + w)] - sums[at(r + h, c)] + sums[at(r, c)];

  const shapes = [
    {
      rows: Math.ceil(OFFER_TARGET_PX / cellHeight),
      cols: Math.ceil(OFFER_TARGET_PX / cellWidth),
      penalty: 0,
    },
    // About one and a half rows of extra distance: a square right above or
    // below the input still wins, one several rows away does not.
    { rows: 1, cols: Math.ceil(OFFER_COMPACT_WIDTH_PX / cellWidth), penalty: cellHeight * 1.5 },
  ];
  const cursorX = (cursorCol + 0.5) * cellWidth;
  const cursorY = (cursorRow + 0.5) * cellHeight;

  let best: (OfferBox & { overlap: number; score: number }) | null = null;
  for (const shape of shapes) {
    if (shape.rows > rows || shape.cols > cols) continue;
    for (let r = 0; r + shape.rows <= rows; r += 1) {
      for (let c = 0; c + shape.cols <= cols; c += 1) {
        const overlap = covered(r, c, shape.rows, shape.cols);
        const dx = Math.max(0, c * cellWidth - cursorX, cursorX - (c + shape.cols) * cellWidth);
        const dy = Math.max(0, r * cellHeight - cursorY, cursorY - (r + shape.rows) * cellHeight);
        // Ties go to the right of the cursor, the side input grows toward and
        // the eye reads to; the left is usually the prompt.
        const score = Math.hypot(dx, dy) + shape.penalty + (c < cursorCol ? cellWidth / 2 : 0);
        if (!best || overlap < best.overlap || (overlap === best.overlap && score < best.score)) {
          best = { row: r, col: c, rows: shape.rows, cols: shape.cols, overlap, score };
        }
      }
    }
  }
  if (!best) return null;
  return { row: best.row, col: best.col, rows: best.rows, cols: best.cols };
}

interface CellReader {
  getChars(): string;
  getWidth(): number;
}

/** The grid of the visible viewport, or null while the cursor is scrolled away. */
export function readOfferGrid(term: Terminal): OfferGrid | null {
  const cell = measureCellDimensions(term);
  if (!cell.measured) return null;
  const active = term.buffer.active;
  const cursorRow = active.baseY + active.cursorY - active.viewportY;
  if (cursorRow < 0 || cursorRow >= term.rows) return null;
  const lines = new Map<number, ReturnType<typeof active.getLine>>();
  const nullCell = typeof active.getNullCell === 'function' ? active.getNullCell() : undefined;
  return {
    cols: term.cols,
    rows: term.rows,
    cellWidth: cell.cellWidth,
    cellHeight: cell.cellHeight,
    cursorCol: Math.min(active.cursorX, term.cols - 1),
    cursorRow,
    occupied: (row, col) => {
      if (!lines.has(row)) lines.set(row, active.getLine(active.viewportY + row));
      const found = lines.get(row)?.getCell(col, nullCell) as CellReader | undefined;
      if (!found) return false;
      // The second half of a wide glyph has no chars of its own but is drawn on.
      return found.getWidth() === 0 || found.getChars().trim() !== '';
    },
  };
}
