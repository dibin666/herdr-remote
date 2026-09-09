/**
 * Pure coordinate and text extraction utilities for mobile terminal selection.
 *
 * Why this is separate from DOM and gesture controllers:
 *
 * Terminal coordinate math and word boundary calculations need to be tested
 * deterministically across complex edge cases (CJK double-width characters,
 * viewport offsets, scale factors, and terminal scrollback). Isolating this logic
 * as pure functions prevents coupling to touch events, gesture timers, or React state.
 *
 * Crucial implementation rule for `wordRangeAt`:
 *   We MUST iterate across columns using `line.getCell(x)`, mapping column indices
 *   to character boundaries using `cell.getChars()` and `cell.getWidth()`.
 *   We MUST NEVER use string indices from `translateToString()`:
 *     In JavaScript strings, a CJK ideograph (e.g. '中') is 1 UTF-16 code unit,
 *     but occupies 2 columns in the terminal grid. If string indices are passed
 *     to `term.select(startCol, row, length)`, every character after a wide glyph
 *     drifts to the left by 1 column per wide character, completely corrupting
 *     the selection on non-ASCII terminal outputs.
 */

import { Terminal } from '@xterm/xterm';
import { measureCellDimensions, screenToLogicalCoords } from './terminalFit';

/**
 * Standard word separators matching xterm defaults plus whitespace.
 * Keeping path characters (`/`, `.`, `-`, `_`) OUT of the separator list ensures
 * that file paths, URLs, and compiler error IDs (e.g. `error[E0308]`) can be selected
 * in one tap on a touch screen.
 */
export const DEFAULT_WORD_SEPARATORS = ' ()[]{}\'"\\`';

export interface SelectionPoint {
  clientX: number;
  clientY: number;
}

export interface TerminalCellCoords {
  col: number;
  bufferRow: number;
}

export interface TerminalColumnRange {
  startCol: number;
  length: number;
}

/**
 * Converts a viewport touch point into terminal grid coordinates (0-based column
 * and absolute buffer row).
 *
 * Reuses `measureCellDimensions` and `screenToLogicalCoords` to stay identical with
 * `touchMouseAdapter`'s coordinate resolution.
 */
export function pointToCell(
  point: SelectionPoint,
  term: Terminal,
  screenEl?: HTMLElement | null,
  scale: number = 1.0
): TerminalCellCoords | null {
  if (!term || !term.buffer?.active || term.cols <= 0 || term.rows <= 0) {
    return null;
  }

  const screen =
    screenEl ||
    (term.element?.querySelector('.xterm-screen') as HTMLElement | null) ||
    (term.element as HTMLElement | null);

  if (!screen || typeof screen.getBoundingClientRect !== 'function') {
    return null;
  }

  const rect = screen.getBoundingClientRect();
  const logical = screenToLogicalCoords(point.clientX, point.clientY, rect, scale);
  const cell = measureCellDimensions(term);

  if (cell.cellWidth <= 0 || cell.cellHeight <= 0) {
    return null;
  }

  // Calculate cell column and row relative to visible viewport, clamped to grid dimensions.
  const width = Math.max(1, rect.width || term.cols * cell.cellWidth);
  const height = Math.max(1, rect.height || term.rows * cell.cellHeight);
  const x = Math.max(0, Math.min(width - 1, logical.clientX - rect.left));
  const y = Math.max(0, Math.min(height - 1, logical.clientY - rect.top));

  const col = Math.max(0, Math.min(term.cols - 1, Math.floor(x / cell.cellWidth)));
  const visibleRow = Math.max(0, Math.min(term.rows - 1, Math.floor(y / cell.cellHeight)));

  // Convert visible row to absolute buffer row so scrollback selections target the correct content.
  const viewportY = term.buffer.active.viewportY ?? 0;
  const bufferRow = viewportY + visibleRow;

  return { col, bufferRow };
}

/** Internal token representing a contiguous cell or wide-character cell span. */
interface CellToken {
  startCol: number;
  endCol: number; // exclusive
  isSeparator: boolean;
}

function isSeparatorChars(chars: string, separators: string): boolean {
  if (!chars || chars.length === 0 || chars === '\0') {
    return true;
  }
  for (const ch of chars) {
    if (ch === '\0' || /\s/.test(ch) || separators.includes(ch)) {
      return true;
    }
  }
  return false;
}

/**
 * Finds the word boundary around a given column in an absolute buffer row.
 *
 * Critical: Operates strictly on column indices rather than string offsets to
 * accurately account for CJK full-width glyphs (width: 2) and their continuation
 * cells (width: 0).
 *
 * Returns `null` if the target column lands on a separator, whitespace, or empty area.
 */
export function wordRangeAt(
  term: Terminal,
  col: number,
  bufferRow: number
): TerminalColumnRange | null {
  if (!term || !term.buffer?.active || col < 0 || col >= term.cols) {
    return null;
  }

  const line = term.buffer.active.getLine(bufferRow);
  if (!line) {
    return null;
  }

  const separators = term.options?.wordSeparator ?? DEFAULT_WORD_SEPARATORS;
  const colToToken: (CellToken | null)[] = new Array(term.cols).fill(null);
  const maxCols = Math.min(term.cols, line.length);

  let x = 0;
  while (x < maxCols) {
    const cell = line.getCell(x);
    if (!cell) {
      colToToken[x] = { startCol: x, endCol: x + 1, isSeparator: true };
      x++;
      continue;
    }

    const width = cell.getWidth();
    // A continuation cell for a previous wide glyph (width === 0)
    if (width === 0) {
      if (!colToToken[x]) {
        colToToken[x] = { startCol: x, endCol: x + 1, isSeparator: true };
      }
      x++;
      continue;
    }

    const chars = cell.getChars();
    const isSep = isSeparatorChars(chars, separators);
    const endCol = Math.min(term.cols, x + width);
    const token: CellToken = {
      startCol: x,
      endCol,
      isSeparator: isSep,
    };

    for (let c = x; c < endCol; c++) {
      colToToken[c] = token;
    }

    x += Math.max(1, width);
  }

  // Any columns beyond line.length are unwritten trailing space
  for (let c = maxCols; c < term.cols; c++) {
    if (!colToToken[c]) {
      colToToken[c] = { startCol: c, endCol: c + 1, isSeparator: true };
    }
  }

  const targetToken = colToToken[col];
  if (!targetToken || targetToken.isSeparator) {
    // Tapping on whitespace or separator yields no word selection.
    return null;
  }

  // Scan left to find the start of the word
  let startCol = targetToken.startCol;
  while (startCol > 0) {
    const prevToken = colToToken[startCol - 1];
    if (prevToken && !prevToken.isSeparator) {
      startCol = prevToken.startCol;
    } else {
      break;
    }
  }

  // Scan right to find the end of the word
  let endCol = targetToken.endCol;
  while (endCol < term.cols) {
    const nextToken = colToToken[endCol];
    if (nextToken && !nextToken.isSeparator) {
      endCol = nextToken.endCol;
    } else {
      break;
    }
  }

  const length = endCol - startCol;
  if (length <= 0) {
    return null;
  }

  return { startCol, length };
}

/**
 * Returns the column range covering the entire line at `bufferRow`.
 */
export function lineRangeAt(term: Terminal, bufferRow: number): TerminalColumnRange | null {
  if (!term || !term.buffer?.active) {
    return null;
  }

  const line = term.buffer.active.getLine(bufferRow);
  if (!line) {
    return null;
  }

  return {
    startCol: 0,
    length: line.length,
  };
}

/**
 * Extracts visible text on the current terminal screen (from `viewportY` for `term.rows` lines).
 * Trims trailing empty rows to avoid copying large blocks of blank terminal space.
 */
export function screenText(term: Terminal): string {
  if (!term || !term.buffer?.active) {
    return '';
  }

  const active = term.buffer.active;
  const viewportY = active.viewportY ?? 0;
  const rowCount = term.rows;
  const lines: string[] = [];

  for (let r = 0; r < rowCount; r++) {
    const line = active.getLine(viewportY + r);
    lines.push(line ? line.translateToString(true) : '');
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.join('\n');
}

/**
 * Extracts all text across the entire scrollback history (from line 0 to `buffer.active.length`).
 * Trims trailing empty rows.
 */
export function scrollbackText(term: Terminal): string {
  if (!term || !term.buffer?.active) {
    return '';
  }

  const active = term.buffer.active;
  const total = active.length;
  const lines: string[] = [];

  for (let y = 0; y < total; y++) {
    const line = active.getLine(y);
    lines.push(line ? line.translateToString(true) : '');
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.join('\n');
}
