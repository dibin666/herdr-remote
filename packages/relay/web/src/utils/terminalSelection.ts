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

/**
 * Closed column interval representing the bounds of a pane, excluding dividers.
 */
export interface PaneColumnBand {
  startCol: number;
  endCol: number;
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
 * Recognized vertical border characters used by multiplexers and TUI frameworks.
 *
 * Why this specific set:
 * Herdr and terminal multiplexers (tmux, zellij, ratpoison) draw split pane borders
 * using standard box-drawing vertical strokes (U+2502, U+2503, double vertical U+2551),
 * dashed variants (U+2506, U+2507, U+250A, U+250B, U+254E, U+254F), block elements
 * (U+258F, U+2595), and the ASCII pipe ('|'). Horizontal junction corners (e.g. '├', '┼')
 * are intentionally excluded because they only appear at grid intersections; the authentic
 * continuous vertical spine of a pane divider is composed of these vertical glyphs.
 */
export const VERTICAL_BORDER_CHARS = new Set([
  '│', // U+2502 Box Drawings Light Vertical
  '┃', // U+2503 Box Drawings Heavy Vertical
  '╎', // U+254E Box Drawings Light Triple Dash Vertical
  '╏', // U+254F Box Drawings Heavy Triple Dash Vertical
  '┆', // U+2506 Box Drawings Light Quadruple Dash Vertical
  '┇', // U+2507 Box Drawings Heavy Quadruple Dash Vertical
  '┊', // U+250A Box Drawings Light Double Dash Vertical
  '┋', // U+250B Box Drawings Heavy Double Dash Vertical
  '║', // U+2551 Box Drawings Double Vertical
  '▏', // U+258F Left One Eighth Block
  '▕', // U+2595 Right One Eighth Block
  '|', // U+007C ASCII Vertical Line
]);

/**
 * Threshold ratio of sampled visible rows required to classify a column as a pane divider.
 *
 * Why 0.6 (60%):
 * A genuine pane divider runs continuously across the entire terminal viewport height,
 * usually interrupted only by an occasional title bar or corner junction (accounting for
 * 80%-95% of rows). In contrast, literal vertical lines inside command outputs (such as
 * markdown tables, `tree`, regex expressions, or code pipes) only span a few consecutive
 * rows and easily stay below 60%. Requiring a 60% presence across visible rows prevents
 * incidental pipes in terminal text from breaking the selection into unwanted bands.
 */
export const PANE_DIVIDER_THRESHOLD = 0.6;

/**
 * Horizontal border characters used in pane split lines (e.g. ─── or ━━━).
 */
export const HORIZONTAL_BORDER_CHARS = new Set([
  '─', // U+2500 Light Horizontal
  '━', // U+2501 Heavy Horizontal
  '═', // U+2550 Double Horizontal
  '┄', // U+2504 Light Triple Dash Horizontal
  '┅', // U+2505 Heavy Triple Dash Horizontal
  '┈', // U+2508 Light Quadruple Dash Horizontal
  '┉', // U+2509 Heavy Quadruple Dash Horizontal
  '-', // ASCII hyphen
]);

/**
 * Threshold ratio of rows in a bounded horizontal sub-band required to classify a column
 * as a local pane divider when global full-height dividers do not exist.
 *
 * Why 0.8 (80%):
 * In hierarchical pane layouts (e.g. Herdr's `pane split --direction down` creating a full-width
 * pane on top and two split panes on the bottom), a vertical divider only spans the height of its
 * sub-band. Within that sub-band, a genuine divider spans nearly every row (>= 80%), whereas
 * incidental vertical glyphs in text do not.
 */
export const LOCAL_PANE_DIVIDER_THRESHOLD = 0.8;

function isHorizontalRuleRow(
  line: { length: number; getCell(x: number): { getChars(): string } | undefined } | undefined,
  cols: number
): boolean {
  if (!line) return false;
  let count = 0;
  const maxC = Math.min(cols, line.length);
  for (let c = 0; c < maxC; c++) {
    const cell = line.getCell(c);
    if (cell) {
      const chars = cell.getChars();
      if (chars && HORIZONTAL_BORDER_CHARS.has(chars)) {
        count++;
      }
    }
  }
  return count >= Math.max(5, Math.min(cols * 0.25, 10));
}

/**
 * Detects the split pane column band containing the specified column coordinate.
 *
 * Why we inspect visible rows via column histogram instead of single-row scanning:
 * Herdr and terminal multiplexers partition a single xterm grid into multiple panes
 * using box-drawing characters. An incidental vertical bar character (e.g. '|' in a shell
 * pipeline or '│' in a markdown table) on a single row must NEVER be mistaken for a pane
 * boundary. A genuine pane divider spans almost all rows of the viewport.
 * By constructing a frequency histogram across visible viewport rows, only columns
 * exceeding `PANE_DIVIDER_THRESHOLD` (60%) are treated as dividers.
 *
 * Hierarchical fallback (pure increment):
 * When Herdr splits vertically within a sub-region (e.g. top full-width pane + bottom left/right panes),
 * no divider spans 60% of the entire viewport. If the primary global histogram detects 0 dividers,
 * we inspect the horizontal row-band bounded by adjacent horizontal divider rules around `bufferRow`.
 * If a column spans >= 80% of rows in that sub-band, it is recognized as a local pane divider.
 *
 * Boundary rules:
 * - If dividers exist to the left and right of `col`, the band spans `(leftDivider + 1)`
 *   to `(rightDivider - 1)` (excluding the border columns themselves).
 * - If no divider exists on a side, that side extends to the grid boundary (0 or cols - 1).
 * - If the touch point lands directly on a divider column itself, the band collapses to
 *   `{ startCol: col, endCol: col }` to prevent dragging or selecting across into either pane.
 * - If no dividers exist anywhere, the band covers the entire line width `[0, cols - 1]`.
 */
export function paneColumnBand(
  term: Terminal,
  col: number,
  bufferRow?: number
): PaneColumnBand {
  if (!term || !term.buffer?.active || term.cols <= 0) {
    return { startCol: 0, endCol: 0 };
  }

  const active = term.buffer.active;
  const cols = term.cols;
  const clampedCol = Math.max(0, Math.min(cols - 1, col));

  // Sample across visible viewport rows.
  // Visible rows represent the visual layout of panes currently presented to the user.
  const viewportY = active.viewportY ?? 0;
  const rowCount = term.rows > 0 ? term.rows : 1;

  // Build a column histogram of vertical border characters across visible rows.
  // We inspect cells using `line.getCell(c)` directly by column index to prevent CJK
  // double-width characters from shifting character offsets.
  const colHistogram = new Int32Array(cols);
  let sampledRows = 0;

  for (let r = 0; r < rowCount; r++) {
    const line = active.getLine(viewportY + r);
    // Count each viewport row towards sampledRows even if unallocated, as an empty row
    // on screen is still a valid visible row devoid of dividers.
    sampledRows++;
    if (!line) {
      continue;
    }
    const maxC = Math.min(cols, line.length);
    for (let c = 0; c < maxC; c++) {
      const cell = line.getCell(c);
      if (cell) {
        const chars = cell.getChars();
        if (chars && VERTICAL_BORDER_CHARS.has(chars)) {
          colHistogram[c]++;
        }
      }
    }
  }

  if (sampledRows === 0) {
    return { startCol: 0, endCol: cols - 1 };
  }

  const requiredCount = sampledRows * PANE_DIVIDER_THRESHOLD;
  const isDividerCol = (c: number): boolean => colHistogram[c] >= requiredCount;

  // 1. Primary path: Global divider histogram across the entire viewport.
  let hasGlobalDivider = false;
  for (let c = 0; c < cols; c++) {
    if (isDividerCol(c)) {
      hasGlobalDivider = true;
      break;
    }
  }

  if (hasGlobalDivider) {
    // Tapping directly on the divider border column itself:
    if (isDividerCol(clampedCol)) {
      return { startCol: clampedCol, endCol: clampedCol };
    }

    // Locate nearest divider to the left of clampedCol
    let leftDivider = -1;
    for (let c = clampedCol - 1; c >= 0; c--) {
      if (isDividerCol(c)) {
        leftDivider = c;
        break;
      }
    }

    // Locate nearest divider to the right of clampedCol
    let rightDivider = cols;
    for (let c = clampedCol + 1; c < cols; c++) {
      if (isDividerCol(c)) {
        rightDivider = c;
        break;
      }
    }

    return {
      startCol: leftDivider + 1,
      endCol: rightDivider - 1,
    };
  }

  // 2. Incremental fallback: Hierarchical / sub-band split pane detection.
  // When no global vertical dividers span the full viewport, the layout may contain stacked
  // splits (e.g. full-width top pane + two split bottom panes). We determine the vertical row
  // band bounded by adjacent horizontal divider rules around `bufferRow`, and check if any
  // vertical column spans >= 80% of that sub-band.
  if (bufferRow !== undefined) {
    const targetRow = Math.max(viewportY, Math.min(viewportY + rowCount - 1, bufferRow));
    const targetLine = active.getLine(targetRow);

    if (!isHorizontalRuleRow(targetLine, cols)) {
      let subRowStart = viewportY;
      for (let r = targetRow - 1; r >= viewportY; r--) {
        if (isHorizontalRuleRow(active.getLine(r), cols)) {
          subRowStart = r + 1;
          break;
        }
      }

      let subRowEnd = viewportY + rowCount - 1;
      for (let r = targetRow + 1; r <= viewportY + rowCount - 1; r++) {
        if (isHorizontalRuleRow(active.getLine(r), cols)) {
          subRowEnd = r - 1;
          break;
        }
      }

      const subBandHeight = subRowEnd - subRowStart + 1;
      if (subBandHeight >= 2) {
        const localHistogram = new Int32Array(cols);
        for (let r = subRowStart; r <= subRowEnd; r++) {
          const line = active.getLine(r);
          if (!line) continue;
          const maxC = Math.min(cols, line.length);
          for (let c = 0; c < maxC; c++) {
            const cell = line.getCell(c);
            if (cell) {
              const chars = cell.getChars();
              if (chars && VERTICAL_BORDER_CHARS.has(chars)) {
                localHistogram[c]++;
              }
            }
          }
        }

        const localRequired = subBandHeight * LOCAL_PANE_DIVIDER_THRESHOLD;
        const isLocalDividerCol = (c: number): boolean => localHistogram[c] >= localRequired;

        let hasLocalDivider = false;
        for (let c = 0; c < cols; c++) {
          if (isLocalDividerCol(c)) {
            hasLocalDivider = true;
            break;
          }
        }

        if (hasLocalDivider) {
          if (isLocalDividerCol(clampedCol)) {
            return { startCol: clampedCol, endCol: clampedCol };
          }

          let leftDivider = -1;
          for (let c = clampedCol - 1; c >= 0; c--) {
            if (isLocalDividerCol(c)) {
              leftDivider = c;
              break;
            }
          }

          let rightDivider = cols;
          for (let c = clampedCol + 1; c < cols; c++) {
            if (isLocalDividerCol(c)) {
              rightDivider = c;
              break;
            }
          }

          return {
            startCol: leftDivider + 1,
            endCol: rightDivider - 1,
          };
        }
      }
    }
  }

  // If no dividers could be determined globally or locally, return full line width
  return { startCol: 0, endCol: cols - 1 };
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
  band: PaneColumnBand
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
  if (!term || !term.buffer?.active || term.cols <= 0) {
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
