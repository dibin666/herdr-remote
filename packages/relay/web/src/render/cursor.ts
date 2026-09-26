// The terminal cursor: its shapes, and drawing the ones that do not fill the
// cell (a filled block is painted with the cell itself).

import type { PaintOverlay } from './paintOverlay';
import type { BufferInternal, RenderDimensions, XtermCore } from './xtermInternals';

const BLINK_INTERVAL_MS = 600;

export enum CursorShape {
  NONE = 0,
  BLOCK = 1,
  BAR = 2,
  UNDERLINE = 3,
  OUTLINE = 4,
}

export interface CursorState {
  /** Viewport row. */
  y: number;
  x: number;
  shape: CursorShape;
}

export function shapeOf(style: string): CursorShape {
  switch (style) {
    case 'bar':
      return CursorShape.BAR;
    case 'underline':
      return CursorShape.UNDERLINE;
    case 'outline':
      return CursorShape.OUTLINE;
    default:
      return CursorShape.BLOCK;
  }
}

export function paintCursorShape(
  ctx: CanvasRenderingContext2D,
  dims: RenderDimensions['device'],
  px: number,
  py: number,
  width: number,
  shape: CursorShape,
  { css, dpr, cursorWidth }: { css: string; dpr: number; cursorWidth: number },
): void {
  ctx.save();
  ctx.fillStyle = css;
  ctx.strokeStyle = css;
  switch (shape) {
    case CursorShape.BAR:
      ctx.fillRect(px, py, Math.max(1, Math.round(cursorWidth * dpr)), dims.cell.height);
      break;
    case CursorShape.UNDERLINE:
      ctx.fillRect(
        px,
        py + dims.cell.height - Math.max(1, Math.round(dpr)) - 1,
        width,
        Math.max(1, Math.round(dpr)),
      );
      break;
    case CursorShape.OUTLINE: {
      const line = Math.max(1, Math.round(dpr));
      ctx.lineWidth = line;
      ctx.strokeRect(px + line / 2, py + line / 2, width - line, dims.cell.height - line);
      break;
    }
  }
  ctx.restore();
}

/** Where and how the cursor is drawn this frame, or null when it is not. */
export function resolveCursor(
  core: Pick<XtermCore, 'coreService' | 'optionsService' | '_coreBrowserService'>,
  buffer: BufferInternal,
  overlay: PaintOverlay | null,
  grid: { rows: number; cols: number },
  blinkHidden: boolean,
): CursorState | null {
  let row: number;
  let col: number;
  if (overlay && overlay.cursor !== undefined) {
    if (overlay.cursor === null) return null;
    row = overlay.cursor.row;
    col = overlay.cursor.col;
  } else {
    if (!core.coreService.isCursorInitialized || core.coreService.isCursorHidden) return null;
    row = buffer.ybase + buffer.y;
    col = buffer.x;
  }
  const y = row - buffer.ydisp;
  if (y < 0 || y >= grid.rows) return null;
  const x = Math.min(Math.max(0, col), grid.cols - 1);
  const options = core.optionsService.rawOptions;
  let shape: CursorShape;
  if (!core._coreBrowserService.isFocused) {
    const inactive = options.cursorInactiveStyle ?? 'outline';
    shape = inactive === 'none' ? CursorShape.NONE : shapeOf(inactive);
  } else if (blinkHidden) {
    shape = CursorShape.NONE;
  } else {
    shape = shapeOf(options.cursorStyle || 'block');
  }
  if (shape === CursorShape.NONE) return null;
  return { x, y, shape };
}

/** The phase of a blinking cursor; the renderer only blinks it while focused. */
export class CursorBlink {
  private timer: ReturnType<typeof setInterval> | null = null;
  private visible = true;

  constructor(private readonly onToggle: () => void) {}

  get running(): boolean {
    return this.timer !== null;
  }

  /** In the off phase of a blink. */
  get hidden(): boolean {
    return this.timer !== null && !this.visible;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => {
      this.visible = !this.visible;
      this.onToggle();
    }, BLINK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.visible = true;
  }
}
