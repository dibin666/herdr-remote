/**
 * Reading-order (flow) ranges inside a pane region: a drag selects the text
 * between two cells the way a document selection does — the anchor's row to
 * the band edge, whole middle rows, and the caret's row from the band start —
 * so wrapped commands and URLs copy whole rather than chopping at columns.
 */

import type { Terminal } from '@xterm/xterm';
import type { PaneColumnBand, PaneRegion } from './paneSelection';

/**
 * A linear (flow) range inside one region: from anchor cell to caret cell,
 * not normalized — direction matters for the word-snap that produced it.
 */
export interface FlowRange {
  anchor: { col: number; row: number };
  caret: { col: number; row: number };
}

/** `(col,row)` ordered so start precedes end in reading order. */
function orderedRange(
  a: { col: number; row: number },
  b: { col: number; row: number },
): [{ col: number; row: number }, { col: number; row: number }] {
  if (a.row < b.row || (a.row === b.row && a.col <= b.col)) return [a, b];
  return [b, a];
}

/**
 * Extracts text along the reading order inside `region`, rather than a
 * rectangle: the first row contributes `start → band end`, middle rows the
 * whole band, the last row `band start → end`. A wrapped command or URL comes
 * out continuous, which a rectangular slice never gives.
 */
export function flowRangeText(term: Terminal, range: FlowRange, region: PaneRegion): string {
  const active = term?.buffer?.active;
  if (!active || term.cols <= 0) return '';

  const [start, end] = orderedRange(range.anchor, range.caret);
  const out: string[] = [];
  for (let row = start.row; row <= end.row; row++) {
    const line = active.getLine(row);
    if (!line) {
      out.push('');
      continue;
    }
    const from = row === start.row ? Math.max(start.col, region.startCol) : region.startCol;
    const to = row === end.row ? Math.min(end.col, region.endCol) : region.endCol;
    if (to < from) {
      out.push('');
      continue;
    }
    out.push(line.translateToString(true, from, to + 1).trimEnd());
  }
  // Trim the blank rows a drag picked up at the edges.
  while (out.length > 1 && out[0] === '') out.shift();
  while (out.length > 1 && out[out.length - 1] === '') out.pop();
  // A row the next line marks isWrapped is one logical line split across
  // visual rows: joining it with '\n' would break the very URLs and paths
  // this extraction exists to keep whole.
  const parts: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const absoluteRow = start.row + i;
    const next = active.getLine(absoluteRow + 1);
    const continues = i < out.length - 1 && next?.isWrapped === true;
    parts.push(continues ? out[i] : `${out[i]}\n`);
  }
  return parts.join('').replace(/\n$/, '');
}

/**
 * The rectangular slices a flow range paints: for each covered row the column
 * segment inside `region`, so the highlight follows the same text the copy
 * produces — first and last rows partial, middle rows full band.
 */
export function flowRangeRows(
  range: FlowRange,
  region: PaneRegion,
): Array<{ row: number; startCol: number; endCol: number }> {
  const [start, end] = orderedRange(range.anchor, range.caret);
  const rows: Array<{ row: number; startCol: number; endCol: number }> = [];
  for (let row = start.row; row <= end.row; row++) {
    const from = row === start.row ? Math.max(start.col, region.startCol) : region.startCol;
    const to = row === end.row ? Math.min(end.col, region.endCol) : region.endCol;
    if (to >= from) rows.push({ row, startCol: from, endCol: to });
  }
  return rows;
}

/**
 * Closed bounding box of a rectangular selection in terminal buffer coordinates.
 * Both columns and rows are inclusive (e.g. startCol: 0, endCol: 3 covers 4 columns).
 */
export interface TerminalSelectionRect {
  startCol: number;
  endCol: number;
  startRow: number;
  endRow: number;
}

/**
 * Clamps a selection rectangle horizontally to stay strictly within a pane column band.
 *
 * Why this is needed:
 * During multi-line selection or touch dragging on a multi-pane terminal screen, touch
 * movements or programmatic ranges must never spill across pane divider borders into
 * neighboring terminal panes.
 */
export function clampRectToBand(
  rect: TerminalSelectionRect,
  band: PaneColumnBand,
): TerminalSelectionRect {
  const minCol = Math.min(rect.startCol, rect.endCol);
  const maxCol = Math.max(rect.startCol, rect.endCol);
  const minRow = Math.min(rect.startRow, rect.endRow);
  const maxRow = Math.max(rect.startRow, rect.endRow);

  return {
    startCol: Math.max(band.startCol, Math.min(band.endCol, minCol)),
    endCol: Math.max(band.startCol, Math.min(band.endCol, maxCol)),
    startRow: minRow,
    endRow: maxRow,
  };
}

/**
 * Extracts text from a closed rectangular region across buffer lines.
 *
 * Why we extract rectangular slices via `line.translateToString` instead of `term.getSelection()`:
 * 1. Standard xterm selections are 1D linear character streams that span from (startCol, startRow)
 *    to (endCol, endRow), inevitably capturing entire middle lines (including pane borders and
 *    neighboring pane text) on multi-pane layouts.
 * 2. `line.translateToString(trimRight, startCol, endCol)` operates strictly in column coordinates
 *    and natively accounts for CJK double-width glyphs, preserving exact visual boundaries.
 * 3. Note that xterm's `endColumn` parameter is EXCLUSIVE (per node_modules/@xterm/xterm/typings/xterm.d.ts:1590),
 *    whereas our `TerminalSelectionRect.endCol` is INCLUSIVE (closed interval). Therefore we must
 *    pass `endCol + 1` to capture the final selected column.
 *
 * Each line is stripped of trailing whitespace and lines are joined with '\n'.
 */
export function rectText(term: Terminal, rect: TerminalSelectionRect): string {
  if (!term?.buffer?.active || term.cols <= 0) {
    return '';
  }

  const active = term.buffer.active;
  const cols = term.cols;

  // Normalize coordinates so start <= end regardless of drag direction
  const minRow = Math.min(rect.startRow, rect.endRow);
  const maxRow = Math.max(rect.startRow, rect.endRow);
  const minCol = Math.max(0, Math.min(rect.startCol, rect.endCol));
  const maxCol = Math.min(cols - 1, Math.max(rect.startCol, rect.endCol));

  if (minCol > maxCol || minRow > maxRow) {
    return '';
  }

  const lines: string[] = [];

  for (let row = minRow; row <= maxRow; row++) {
    const line = active.getLine(row);
    if (!line) {
      lines.push('');
      continue;
    }

    // xterm's translateToString:
    // param 1 (trimRight): true
    // param 2 (startColumn): inclusive column index
    // param 3 (endColumn): exclusive column index -> maxCol + 1
    const raw = line.translateToString(true, minCol, maxCol + 1);
    lines.push(raw.trimEnd());
  }

  return lines.join('\n');
}
