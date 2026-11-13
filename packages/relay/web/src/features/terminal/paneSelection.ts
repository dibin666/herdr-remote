/**
 * Pane-aware selection geometry on a split Herdr screen: locating the region a
 * touch landed in — column band and row band — keeping a drag inside it, and
 * reading the text it holds.
 */

import type { Terminal } from '@xterm/xterm';

/**
 * Closed column interval representing the bounds of a pane, excluding dividers.
 */
export interface PaneColumnBand {
  startCol: number;
  endCol: number;
}

/**
 * A pane rectangle on the visible grid: the column band a vertical divider
 * pair leaves, intersected with the row band the horizontal rules leave.
 * All four bounds are inclusive terminal buffer rows/columns.
 */
export interface PaneRegion extends PaneColumnBand {
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
 *
 * ASCII '-' is deliberately absent: a horizontal rule must be drawn with
 * box-drawing glyphs, otherwise every `----` comment line or `====` banner in
 * command output would cut the screen into fake panes.
 */
const HORIZONTAL_BORDER_CHARS = new Set([
  '─', // U+2500 Light Horizontal
  '━', // U+2501 Heavy Horizontal
  '═', // U+2550 Double Horizontal
  '┄', // U+2504 Light Triple Dash Horizontal
  '┅', // U+2505 Heavy Triple Dash Horizontal
  '┈', // U+2508 Light Quadruple Dash Horizontal
  '┉', // U+2509 Heavy Quadruple Dash Horizontal
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
const LOCAL_PANE_DIVIDER_THRESHOLD = 0.8;

/** Fraction of a column band a rule row must cover to split the rows in it. */
const ROW_DIVIDER_COVERAGE = 0.85;

type LineReader =
  | { length: number; getCell(x: number): { getChars(): string } | undefined }
  | undefined;

/**
 * A row is a horizontal rule inside `band` when border glyphs cover nearly all
 * of the band's width. Checking coverage inside the band rather than the whole
 * line is what makes a rule that spans one pane count without demanding the
 * neighbouring panes draw it too.
 */
function isHorizontalRuleRow(line: LineReader, cols: number, band?: PaneColumnBand): boolean {
  if (!line) return false;
  const start = band ? band.startCol : 0;
  const end = band ? band.endCol : cols - 1;
  const width = end - start + 1;
  if (width < 3) return false;
  let count = 0;
  for (let c = start; c <= Math.min(end, line.length - 1); c++) {
    const cell = line.getCell(c);
    if (cell) {
      const chars = cell.getChars();
      if (chars && HORIZONTAL_BORDER_CHARS.has(chars)) {
        count++;
      }
    }
  }
  return count >= Math.max(3, Math.ceil(width * ROW_DIVIDER_COVERAGE));
}

/** Columns whose border glyphs cover `requiredCount` of the rows sampled. */
function dividerColumns(histogram: Int32Array, requiredCount: number): number[] {
  const out: number[] = [];
  for (let c = 0; c < histogram.length; c++) {
    if (histogram[c] >= requiredCount) out.push(c);
  }
  return out;
}

/** Count border glyphs per column across the given buffer rows. */
function columnHistogram(
  term: Terminal,
  rows: number[],
  viewportY: number,
  colStart = 0,
  colEnd = term.cols - 1,
): Int32Array {
  const active = term.buffer.active;
  const cols = term.cols;
  const histogram = new Int32Array(cols);
  for (const r of rows) {
    const line = active.getLine(viewportY + r);
    if (!line) continue;
    const maxC = Math.min(cols, line.length, colEnd + 1);
    for (let c = colStart; c < maxC; c++) {
      const cell = line.getCell(c);
      if (cell) {
        const chars = cell.getChars();
        if (chars && VERTICAL_BORDER_CHARS.has(chars)) {
          histogram[c]++;
        }
      }
    }
  }
  return histogram;
}

/**
 * Rows inside `band` that read as horizontal rules: the row indices (viewport-
 * relative) where the selection must not cross.
 */
function ruleRowsInBand(
  term: Terminal,
  rows: number[],
  viewportY: number,
  band: PaneColumnBand,
): number[] {
  const active = term.buffer.active;
  const rules: number[] = [];
  for (const r of rows) {
    if (isHorizontalRuleRow(active.getLine(viewportY + r), term.cols, band)) {
      rules.push(r);
    }
  }
  return rules;
}

/** The row interval containing `rowRel`, bounded by `rules`. */
function rowBandAround(rowRel: number, rows: number[], rules: number[]): [number, number] {
  const lo = Math.min(...rows);
  const hi = Math.max(...rows);
  let start = lo;
  for (const r of rules) if (r < rowRel && r + 1 > start) start = r + 1;
  let end = hi;
  for (const r of rules) if (r > rowRel && r - 1 < end) end = r - 1;
  return [start, end];
}

/** The column band containing `col`, given divider columns. */
function colBandAround(col: number, cols: number, dividers: number[]): PaneColumnBand {
  // Pressed dead-on a divider: the finger means the pane, not the hairline.
  // Take the pane opening to the right, or the one ending to the left when
  // the right side is another divider or the screen edge.
  if (dividers.includes(col)) {
    const right = dividers.filter((d) => d > col).sort((a, b) => a - b)[0];
    const rightEnd = (right ?? cols) - 1;
    if (col + 1 <= rightEnd && !dividers.includes(col + 1)) {
      return { startCol: col + 1, endCol: rightEnd };
    }
    const left = dividers.filter((d) => d < col).sort((a, b) => b - a)[0];
    return { startCol: (left ?? -1) + 1, endCol: col - 1 };
  }
  let start = 0;
  for (const d of dividers) if (d < col && d + 1 > start) start = d + 1;
  let end = cols - 1;
  for (const d of dividers) if (d > col && d - 1 < end) end = d - 1;
  if (start > end) return { startCol: col, endCol: col };
  return { startCol: start, endCol: end };
}

/** The row band containing `rowRel`, given rule rows; rules snap down. */
function rowBandSnap(rowRel: number, rows: number[], rules: number[]): [number, number] {
  const lo = Math.min(...rows);
  const next = rules.filter((r) => r > rowRel).sort((a, b) => a - b)[0];
  const start = rowRel + 1;
  const end = next !== undefined ? next - 1 : Math.max(...rows);
  if (start <= end) return [start, end];
  // The rule is the last line: the pane it borders lives above it.
  const prev = rules.filter((r) => r < rowRel).sort((a, b) => b - a)[0];
  return [prev !== undefined ? prev + 1 : lo, rowRel - 1];
}

/**
 * The pane region containing `(col, bufferRow)` on the visible screen.
 *
 * Layouts covered, in detection order:
 * 1. Vertical splits spanning the viewport → column bands, then each band's
 *    own horizontal rules bound the row band (per-pane horizontal splits).
 * 2. No full-height divider → Herdr's stacked layouts: the horizontal rules
 *    around the row bound a sub-band, and a vertical divider spanning ≥80% of
 *    that sub-band splits it (bottom half split left/right under a full-width
 *    top pane).
 * 3. Neither → the whole visible grid.
 *
 * Landing on a divider snaps to the adjacent pane instead of collapsing to
 * a one-cell band: a finger cannot aim at a hairline and never means to.
 */
export function paneRegionAt(term: Terminal, col: number, bufferRow: number): PaneRegion {
  const active = term?.buffer?.active;
  const cols = term?.cols ?? 0;
  if (!active || cols <= 0) {
    return { startCol: 0, endCol: 0, startRow: 0, endRow: 0 };
  }

  const clampedCol = Math.max(0, Math.min(cols - 1, col));
  const viewportY = active.viewportY ?? 0;
  const rowCount = term.rows > 0 ? term.rows : 1;
  const clampedRow = Math.max(viewportY, Math.min(viewportY + rowCount - 1, bufferRow));
  const rowRel = clampedRow - viewportY;
  const allRows = Array.from({ length: rowCount }, (_, r) => r);

  // 1. Global vertical dividers: a column spine that runs the viewport.
  const globalHistogram = columnHistogram(term, allRows, viewportY);
  const globalDividers = dividerColumns(globalHistogram, rowCount * PANE_DIVIDER_THRESHOLD);

  if (globalDividers.length > 0) {
    const vBand = colBandAround(clampedCol, cols, globalDividers);
    const rules = ruleRowsInBand(term, allRows, viewportY, vBand);
    const onRule = rules.includes(rowRel);
    const [startRel, endRel] = onRule
      ? rowBandSnap(rowRel, allRows, rules)
      : rowBandAround(rowRel, allRows, rules);
    return {
      startCol: vBand.startCol,
      endCol: vBand.endCol,
      startRow: viewportY + startRel,
      endRow: viewportY + endRel,
    };
  }

  // 2. Stacked layouts: the horizontal rules around the touched row bound a
  //    sub-band; a vertical spine inside it splits it. Coverage is measured
  //    against the full line width here — a stacked split always draws its
  //    rule across every column of the screen.
  const targetLine = active.getLine(clampedRow);
  if (!isHorizontalRuleRow(targetLine, cols)) {
    let subRowStart = viewportY;
    for (let r = clampedRow - 1; r >= viewportY; r--) {
      if (isHorizontalRuleRow(active.getLine(r), cols)) {
        subRowStart = r + 1;
        break;
      }
    }
    let subRowEnd = viewportY + rowCount - 1;
    for (let r = clampedRow + 1; r <= viewportY + rowCount - 1; r++) {
      if (isHorizontalRuleRow(active.getLine(r), cols)) {
        subRowEnd = r - 1;
        break;
      }
    }

    const subBandHeight = subRowEnd - subRowStart + 1;
    if (subBandHeight >= 2) {
      const subRows = Array.from({ length: subBandHeight }, (_, r) => subRowStart - viewportY + r);
      const localHistogram = columnHistogram(term, subRows, viewportY);
      const localDividers = dividerColumns(
        localHistogram,
        subBandHeight * LOCAL_PANE_DIVIDER_THRESHOLD,
      );

      if (localDividers.length > 0) {
        const vBand = colBandAround(clampedCol, cols, localDividers);
        // The local band can itself carry horizontal rules inside its own
        // column band (a stacked split under a side-by-side split).
        const innerRules = ruleRowsInBand(term, subRows, viewportY, vBand);
        const [startRel, endRel] = innerRules.includes(rowRel)
          ? rowBandSnap(rowRel, subRows, innerRules)
          : rowBandAround(rowRel, subRows, innerRules);
        return {
          startCol: vBand.startCol,
          endCol: vBand.endCol,
          startRow: viewportY + startRel,
          endRow: viewportY + endRel,
        };
      }

      // The sub-band has no vertical split of its own: it is a pane.
      return {
        startCol: 0,
        endCol: cols - 1,
        startRow: subRowStart,
        endRow: subRowEnd,
      };
    }
  }

  // 3. Landing on a horizontal rule: snap to the pane below it.
  if (isHorizontalRuleRow(targetLine, cols)) {
    const rules: number[] = [];
    for (let r = 0; r < rowCount; r++) {
      if (isHorizontalRuleRow(active.getLine(viewportY + r), cols)) rules.push(r);
    }
    const [startRel, endRel] = rowBandSnap(rowRel, allRows, rules);
    return {
      startCol: 0,
      endCol: cols - 1,
      startRow: viewportY + startRel,
      endRow: viewportY + endRel,
    };
  }

  // 4. No structure at all: the whole grid is the pane.
  return {
    startCol: 0,
    endCol: cols - 1,
    startRow: viewportY,
    endRow: viewportY + rowCount - 1,
  };
}

/** The column band of the region at `(col, bufferRow)`; divider hits snap right. */
export function paneColumnBand(term: Terminal, col: number, bufferRow?: number): PaneColumnBand {
  const region = paneRegionAt(term, col, bufferRow ?? term?.buffer?.active?.viewportY ?? 0);
  return { startCol: region.startCol, endCol: region.endCol };
}

/**
 * The region rectangles that tile the visible screen: every pane the user
 * could want to select inside, derived once for the copy-mode mirror.
 * Enumerates column bands between global dividers; a column band that no
 * divider bounds is one band wide, and each band is cut by its horizontal rules.
 */
export function paneRegions(term: Terminal): PaneRegion[] {
  const active = term?.buffer?.active;
  const cols = term?.cols ?? 0;
  const rows = term?.rows ?? 0;
  if (!active || cols <= 0 || rows <= 0) return [];

  const viewportY = active.viewportY ?? 0;
  const allRows = Array.from({ length: rows }, (_, r) => r);
  const globalHistogram = columnHistogram(term, allRows, viewportY);
  const globalDividers = dividerColumns(globalHistogram, rows * PANE_DIVIDER_THRESHOLD);

  // Column bands between the global spines (or one full-width band).
  const bounds = [-1, ...globalDividers, cols];
  const bands: PaneColumnBand[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    bands.push({ startCol: bounds[i] + 1, endCol: bounds[i + 1] - 1 });
  }

  const regions: PaneRegion[] = [];
  for (const band of bands) {
    if (band.startCol > band.endCol) continue;
    const rules = ruleRowsInBand(term, allRows, viewportY, band);
    const cuts = [Math.min(...allRows) - 1, ...rules, Math.max(...allRows) + 1];
    for (let i = 0; i < cuts.length - 1; i++) {
      const startRel = cuts[i] + 1;
      const endRel = cuts[i + 1] - 1;
      if (startRel > endRel) continue;
      regions.push(
        ...splitRegionLeaf(
          term,
          {
            startCol: band.startCol,
            endCol: band.endCol,
            startRow: viewportY + startRel,
            endRow: viewportY + endRel,
          },
          viewportY,
          0,
        ),
      );
    }
  }
  return regions;
}

/**
 * Split one leaf rectangle by any local split drawn inside it: a vertical
 * spine covering ≥80% of its rows (Herdr's stacked splits) or a horizontal
 * rule covering its columns. Two passes cover Herdr's layouts; deeper
 * nesting collapses into the enclosing leaf, which is the right trade for
 * a selection mirror.
 */
function splitRegionLeaf(
  term: Terminal,
  leaf: PaneRegion,
  viewportY: number,
  depth: number,
): PaneRegion[] {
  if (depth >= 2) return [leaf];
  const rowStart = leaf.startRow - viewportY;
  const height = leaf.endRow - leaf.startRow + 1;
  if (height < 2) return [leaf];
  const leafRows = Array.from({ length: height }, (_, r) => rowStart + r);

  const histogram = columnHistogram(term, leafRows, viewportY, leaf.startCol, leaf.endCol);
  const dividers = dividerColumns(histogram, height * LOCAL_PANE_DIVIDER_THRESHOLD);

  if (dividers.length > 0) {
    const bounds = [leaf.startCol - 1, ...dividers, leaf.endCol + 1];
    const out: PaneRegion[] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const startCol = bounds[i] + 1;
      const endCol = bounds[i + 1] - 1;
      if (startCol > endCol) continue;
      out.push(
        ...splitRegionLeaf(
          term,
          { startCol, endCol, startRow: leaf.startRow, endRow: leaf.endRow },
          viewportY,
          depth + 1,
        ),
      );
    }
    return out;
  }

  const rules = leafRows.filter((r) =>
    isHorizontalRuleRow(term.buffer.active.getLine(viewportY + r), term.cols, leaf),
  );
  if (rules.length === 0) return [leaf];
  const cuts = [rowStart - 1, ...rules, rowStart + height];
  const out: PaneRegion[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const startRel = cuts[i] + 1;
    const endRel = cuts[i + 1] - 1;
    if (startRel > endRel) continue;
    out.push(
      ...splitRegionLeaf(
        term,
        {
          startCol: leaf.startCol,
          endCol: leaf.endCol,
          startRow: viewportY + startRel,
          endRow: viewportY + endRel,
        },
        viewportY,
        depth + 1,
      ),
    );
  }
  return out;
}
