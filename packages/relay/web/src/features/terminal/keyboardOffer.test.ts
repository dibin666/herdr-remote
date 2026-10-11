import { describe, expect, it } from 'vitest';
import { type OfferBox, type OfferGrid, placeKeyboardOffer } from './keyboardOffer';

/** A grid drawn as text: any non-space character is a glyph. */
function gridFrom(lines: string[], cursor: { row: number; col: number }): OfferGrid {
  return {
    cols: lines[0].length,
    rows: lines.length,
    cellWidth: 9,
    cellHeight: 18,
    cursorRow: cursor.row,
    cursorCol: cursor.col,
    occupied: (row, col) => (lines[row]?.[col] ?? ' ') !== ' ',
  };
}

function coveredGlyphs(lines: string[], box: OfferBox, cursor: { row: number; col: number }) {
  let count = 0;
  for (let r = box.row; r < box.row + box.rows; r += 1) {
    for (let c = box.col; c < box.col + box.cols; c += 1) {
      if (lines[r][c] !== ' ' || (r === cursor.row && c === cursor.col)) count += 1;
    }
  }
  return count;
}

describe('placeKeyboardOffer', () => {
  it('puts a one-row pill beside the cursor inside a framed input line', () => {
    const lines = [
      'output line one                         ',
      'output line two                         ',
      '┌──────────────────────────────────────┐',
      '│ > hello                              │',
      '└──────────────────────────────────────┘',
      'status bar text here                    ',
    ];
    const cursor = { row: 3, col: 10 };
    const box = placeKeyboardOffer(gridFrom(lines, cursor));

    expect(box).not.toBeNull();
    expect(box?.row).toBe(3);
    expect(box?.rows).toBe(1);
    expect(box?.col).toBe(11);
    expect(coveredGlyphs(lines, box as OfferBox, cursor)).toBe(0);
  });

  it('prefers a full square right next to the cursor when the rows around it are blank', () => {
    const lines = [
      'output                                  ',
      '                                        ',
      '                                        ',
      '$ ls                                    ',
      '                                        ',
      '                                        ',
    ];
    const cursor = { row: 3, col: 4 };
    const box = placeKeyboardOffer(gridFrom(lines, cursor)) as OfferBox;

    expect(box.rows).toBeGreaterThan(1);
    expect(coveredGlyphs(lines, box, cursor)).toBe(0);
    // Touching the cursor's row band, not somewhere far off.
    expect(box.row).toBeLessThanOrEqual(cursor.row);
    expect(box.row + box.rows).toBeGreaterThan(cursor.row);
    expect(box.col).toBe(cursor.col + 1);
  });

  it('never covers the cursor or text when a blank box exists elsewhere', () => {
    const lines = [
      'xxxxxxxxxxxxxxxxxxxx',
      'xxxxxxxxxxxxxxxxxxxx',
      'xxxx                ',
      'xxxxxxxxxxxxxxxxxxxx',
    ];
    const cursor = { row: 2, col: 4 };
    const box = placeKeyboardOffer(gridFrom(lines, cursor)) as OfferBox;

    expect(coveredGlyphs(lines, box, cursor)).toBe(0);
    expect(box.row).toBe(2);
  });

  it('offers nothing while the cursor row is scrolled out of view', () => {
    const lines = ['     ', '     '];
    expect(placeKeyboardOffer(gridFrom(lines, { row: 5, col: 0 }))).toBeNull();
  });
});
