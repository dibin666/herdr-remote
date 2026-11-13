/**
 * The text mirror behind copy mode: the visible buffer rendered as ordinary
 * DOM text so the browser's own selection — touch handles, native menus —
 * works where xterm's canvas gives none.
 */

import type { Terminal } from '@xterm/xterm';
import type { FlowRange } from './flowSelection';
import type { PaneRegion } from './paneSelection';

/** One mirrored row: its buffer row and a char-index map per column. */
interface MirrorRow {
  bufferRow: number;
  text: string;
  isWrapped: boolean;
  /**
   * Char offset in `text` where each column begins (length = region width +
   * 1). A cell boundary at column c is `colCharStart[c - region.startCol]`.
   * Needed because a CJK cell contributes two columns but one code unit —
   * naive col == charIndex alignment silently breaks on wide glyphs.
   */
  colCharStart: number[];
}

/** A pane region rendered for the mirror, with its rows in buffer order. */
export interface MirrorRegion {
  region: PaneRegion;
  rows: MirrorRow[];
}

/**
 * Read the region's visible rows verbatim — including trailing spaces, which
 * keep every column's char offset stable for both rendering alignment and
 * selection mapping.
 */
export function mirrorRegion(term: Terminal, region: PaneRegion): MirrorRegion {
  const active = term?.buffer?.active;
  const rows: MirrorRow[] = [];
  if (!active) return { region, rows };

  const width = region.endCol - region.startCol + 1;
  for (let row = region.startRow; row <= region.endRow; row++) {
    const line = active.getLine(row);
    const colCharStart = new Array<number>(width + 1).fill(0);
    let text = '';
    if (line) {
      for (let c = region.startCol; c <= region.endCol; c++) {
        const charIndex = c - region.startCol;
        colCharStart[charIndex] = text.length;
        if (c < line.length) {
          const cell = line.getCell(c);
          if (cell) {
            // A continuation cell (width 0) carries no glyph of its own —
            // appending a space would push the wide char's DOM twin out of
            // its two-column span. Skip it so offsets stay on cells.
            if (cell.getWidth?.() === 0) continue;
            const chars = cell.getChars();
            text += chars || ' ';
            continue;
          }
        }
        text += ' ';
      }
    } else {
      text = ' '.repeat(width);
    }
    colCharStart[width] = text.length;
    rows.push({ bufferRow: row, text, colCharStart, isWrapped: line?.isWrapped === true });
  }
  return { region, rows };
}

/** Native control offsets include visual newlines; wrapped rows are one logical line. */
export function mirrorSelectionText(mirror: MirrorRegion, start: number, end: number): string {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.max(from, Math.max(start, end));
  let offset = 0;
  let text = '';
  for (let index = 0; index < mirror.rows.length; index++) {
    const row = mirror.rows[index];
    const rowEnd = offset + row.text.length;
    const sliceStart = Math.max(0, from - offset);
    const sliceEnd = Math.min(row.text.length, to - offset);
    if (sliceEnd > sliceStart) text += row.text.slice(sliceStart, sliceEnd).trimEnd();
    if (
      index < mirror.rows.length - 1 &&
      from <= rowEnd &&
      to > rowEnd &&
      !mirror.rows[index + 1].isWrapped
    )
      text += '\n';
    offset = rowEnd + 1;
  }
  return text.replace(/\u00a0/g, ' ').replace(/^\n+|\n+$/g, '');
}

/**
 * Where in a mirror region's DOM text a flow range sits: the flat offsets a
 * `Range` needs — rows joined with '\n', anchor and caret clamped into the
 * region the range belongs to.
 */
export function mirrorRangeOffsets(
  mirror: MirrorRegion,
  range: FlowRange,
): { anchor: number; caret: number } | null {
  const { region, rows } = mirror;
  if (rows.length === 0) return null;

  const rowStart = region.startRow;
  const rowOffset = new Array<number>(rows.length + 1).fill(0);
  for (let i = 0; i < rows.length; i++) {
    rowOffset[i + 1] = rowOffset[i] + rows[i].text.length + (i < rows.length - 1 ? 1 : 0);
  }

  const cellToOffset = (cell: { col: number; row: number }): number => {
    const clampedRow = Math.max(region.startRow, Math.min(region.endRow, cell.row));
    const clampedCol = Math.max(region.startCol, Math.min(region.endCol, cell.col));
    const ri = clampedRow - rowStart;
    return rowOffset[ri] + rows[ri].colCharStart[clampedCol - region.startCol];
  };

  return { anchor: cellToOffset(range.anchor), caret: cellToOffset(range.caret) };
}
