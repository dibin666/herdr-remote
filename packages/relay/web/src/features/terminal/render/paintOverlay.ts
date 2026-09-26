// Cells drawn in place of what the buffer holds, and where the cursor goes
// meanwhile. Predicted typing reaches the renderer this way.

import type { CellStyle } from './cell';

/**
 * A cell drawn in place of what the buffer holds, for as long as it is
 * listed. Predicted typing is drawn this way: through the same glyphs and
 * colours as the echo that will replace it, so the swap paints nothing.
 */
export interface OverlayCell {
  /** Absolute buffer row. */
  row: number;
  col: number;
  chars: string;
  width: 1 | 2;
  style: CellStyle;
}

export interface PaintOverlay {
  cells: ReadonlyArray<OverlayCell>;
  /**
   * Where the terminal cursor is drawn instead of the buffer's cursor
   * (absolute row); `null` hides it. Absent, the buffer's cursor is drawn.
   */
  cursor?: { row: number; col: number } | null;
}

/** Absolute rows an overlay touches, its cursor included. */
export function overlayRows(overlay: PaintOverlay | null): number[] {
  if (!overlay) return [];
  const rows = overlay.cells.map((cell) => cell.row);
  if (overlay.cursor) rows.push(overlay.cursor.row);
  return rows;
}

/** The overlay's cells, grouped by absolute row. */
export function overlayCellsByRow(overlay: PaintOverlay | null): Map<number, OverlayCell[]> {
  const byRow = new Map<number, OverlayCell[]>();
  for (const cell of overlay?.cells ?? []) {
    const list = byRow.get(cell.row);
    if (list) list.push(cell);
    else byRow.set(cell.row, [cell]);
  }
  return byRow;
}
