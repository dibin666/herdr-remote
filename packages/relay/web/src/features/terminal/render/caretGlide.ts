// The caret slides from cell to cell along the row being typed on, instead
// of jumping. While it moves it is drawn on the decoration layer, above the
// text; once it arrives it is painted into its cell again, as it always was.

import { resolveCellColors, type ThemeColors } from './colors';
import { CursorShape, type CursorState } from './cursor';
import type { OverlayCell, PaintOverlay } from './paintOverlay';

const GLIDE_MS = 80;
/** A move further than this along the row is a jump (Home, End, a click), shown at once. */
const MAX_GLIDE_CELLS = 16;

/** Where the caret is this frame: a viewport cell. */
export interface CaretTarget {
  x: number;
  y: number;
  shape: CursorShape;
  css: string;
  /**
   * For a caret a program paints into a cell itself: that cell without it,
   * drawn in its place while the caret slides in.
   */
  plain?: OverlayCell;
}

/** A caret on its way, at a fractional cell position. */
export interface SlidingCaret {
  x: number;
  y: number;
  shape: CursorShape;
  css: string;
}

export class CaretGlide {
  private last: { x: number; y: number } | null = null;
  private fromX = 0;
  private toX = 0;
  private start = 0;
  private sliding = false;

  /**
   * Follows the caret to `target`. A move along viewport row `typingY` slides
   * from wherever the caret is drawn now; anything else is shown at once.
   * Returns the caret while it slides, and null once it rests.
   */
  update(target: CaretTarget | null, typingY: number, now: number): SlidingCaret | null {
    const last = this.last;
    this.last = target && { x: target.x, y: target.y };
    if (!target) {
      this.sliding = false;
      return null;
    }
    if (!last || last.x !== target.x || last.y !== target.y) {
      const glides =
        last !== null &&
        last.y === target.y &&
        target.y === typingY &&
        Math.abs(target.x - last.x) <= MAX_GLIDE_CELLS;
      this.fromX = !glides || !last ? target.x : this.sliding ? this.x(now) : last.x;
      this.toX = target.x;
      this.start = now;
      this.sliding = glides;
    }
    if (!this.sliding) return null;
    if (now - this.start >= GLIDE_MS) {
      this.sliding = false;
      return null;
    }
    return { x: this.x(now), y: target.y, shape: target.shape, css: target.css };
  }

  private x(now: number): number {
    const p = Math.min(1, Math.max(0, (now - this.start) / GLIDE_MS));
    return this.fromX + (this.toX - this.fromX) * (1 - (1 - p) ** 3);
  }
}

/** Where the caret is this frame: the terminal cursor, or else a caret the program paints itself. */
export function caretTarget(
  cursor: CursorState | null,
  overlay: PaintOverlay | null,
  ydisp: number,
  colors: ThemeColors,
): CaretTarget | null {
  if (cursor) return { x: cursor.x, y: cursor.y, shape: cursor.shape, css: colors.cursor.css };
  const painted = overlay?.paintedCaret;
  if (!painted) return null;
  const { bg } = resolveCellColors(painted.style.fg, painted.style.bg, colors, true);
  return {
    x: painted.col,
    y: painted.row - ydisp,
    shape: CursorShape.BLOCK,
    css: bg,
    plain: painted.plain,
  };
}
