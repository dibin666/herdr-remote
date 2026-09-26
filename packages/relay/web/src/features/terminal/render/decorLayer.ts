// The layer above the text: the selection highlight and the underline of a
// hovered link. It is redrawn whole, and only when either changes.

import type { ThemeColors } from './colors';
import type { LinkEvent, RenderDimensions } from './xtermInternals';

export interface SelectionRange {
  start: [number, number];
  end: [number, number];
  columnSelectMode: boolean;
}

export interface DecorView {
  dims: RenderDimensions['device'];
  rows: number;
  cols: number;
  ydisp: number;
  colors: ThemeColors;
  focused: boolean;
  dpr: number;
}

export class DecorLayer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private selection: SelectionRange | null = null;
  /** The hovered link, while xterm shows its underline. */
  link: LinkEvent | null = null;

  constructor(document: Document) {
    this.canvas = document.createElement('canvas');
    this.canvas.classList.add('xterm-decor-layer');
    this.canvas.style.zIndex = '2';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
  }

  /** An empty selection (start and end on one cell) draws nothing. */
  setSelection(
    start: [number, number] | undefined,
    end: [number, number] | undefined,
    columnSelectMode: boolean,
  ): void {
    this.selection =
      start && end && !(start[0] === end[0] && start[1] === end[1])
        ? { start: [start[0], start[1]], end: [end[0], end[1]], columnSelectMode }
        : null;
  }

  paint({ dims, rows, cols, ydisp, colors, focused, dpr }: DecorView): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!dims.cell.width || !rows) return;
    const { selection, link } = this;
    const fill = (x: number, y: number, w: number, h: number) =>
      ctx.fillRect(
        x * dims.cell.width,
        y * dims.cell.height,
        w * dims.cell.width,
        h * dims.cell.height,
      );

    if (selection) {
      const startRow = selection.start[1] - ydisp;
      const endRow = selection.end[1] - ydisp;
      const cappedStart = Math.max(startRow, 0);
      const cappedEnd = Math.min(endRow, rows - 1);
      if (cappedStart < rows && cappedEnd >= 0) {
        ctx.fillStyle = (
          focused
            ? colors.selectionBackgroundTransparent
            : colors.selectionInactiveBackgroundTransparent
        ).css;
        if (selection.columnSelectMode) {
          fill(
            selection.start[0],
            cappedStart,
            selection.end[0] - selection.start[0],
            cappedEnd - cappedStart + 1,
          );
        } else {
          const startCol = startRow === cappedStart ? selection.start[0] : 0;
          const firstEnd = cappedStart === endRow ? selection.end[0] : cols;
          fill(startCol, cappedStart, firstEnd - startCol, 1);
          fill(0, cappedStart + 1, cols, Math.max(cappedEnd - cappedStart - 1, 0));
          if (cappedStart !== cappedEnd) {
            fill(0, cappedEnd, endRow === cappedEnd ? selection.end[0] : cols, 1);
          }
        }
      }
    }

    if (link) {
      ctx.fillStyle =
        link.fg === 257
          ? colors.background.css
          : link.fg !== undefined && link.fg < 256
            ? (colors.ansi[link.fg]?.css ?? colors.foreground.css)
            : colors.foreground.css;
      const underline = (x: number, y: number, w: number) =>
        ctx.fillRect(
          x * dims.cell.width,
          (y + 1) * dims.cell.height - dpr - 1,
          w * dims.cell.width,
          dpr,
        );
      if (link.y1 === link.y2) {
        underline(link.x1, link.y1, link.x2 - link.x1);
      } else {
        underline(link.x1, link.y1, link.cols - link.x1);
        for (let y = link.y1 + 1; y < link.y2; y++) underline(0, y, link.cols);
        underline(0, link.y2, link.x2);
      }
    }
  }
}
