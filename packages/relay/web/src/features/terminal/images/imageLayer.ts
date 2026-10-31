import type { Terminal } from '@xterm/xterm';
import { measureCellDimensions } from '@/features/terminal/terminalFit';
import type { DecodedImage, KittyGraphics, Placement } from './kittyGraphics';

/** The on-screen box a placement draws into, in CSS pixels. */
export interface PlacementBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where a placement lands on screen — the same box `draw` paints into.
 * `cols`/`rows` are cells to fill; an unset side follows the source aspect.
 */
export function placementBox(
  placement: Placement,
  image: DecodedImage,
  cellWidth: number,
  cellHeight: number,
  viewportY: number,
): PlacementBox {
  const sx = Math.min(placement.sx, image.width);
  const sy = Math.min(placement.sy, image.height);
  const sw = Math.min(placement.sw || image.width, image.width - sx);
  const sh = Math.min(placement.sh || image.height, image.height - sy);
  let dw = placement.cols * cellWidth;
  let dh = placement.rows * cellHeight;
  if (!dw && !dh) {
    dw = sw;
    dh = sh;
  } else if (!dw) {
    dw = (sw * dh) / sh;
  } else if (!dh) {
    dh = (sh * dw) / sw;
  }
  return {
    x: placement.col * cellWidth + placement.offsetX,
    y: (placement.line - viewportY) * cellHeight + placement.offsetY,
    w: dw,
    h: dh,
  };
}

/** The topmost image drawn under (`x`, `y`) in screen CSS pixels, if any. */
export function hitImage<T extends DecodedImage>(
  placements: Placement[],
  imageOf: (imageId: number) => T | null,
  cellWidth: number,
  cellHeight: number,
  viewportY: number,
  x: number,
  y: number,
): T | null {
  // `placements` is bottom layer first, so scan from the end for the hit a
  // click actually sees.
  for (let i = placements.length - 1; i >= 0; i--) {
    const placement = placements[i];
    const image = imageOf(placement.imageId);
    if (!image) continue;
    const box = placementBox(placement, image, cellWidth, cellHeight, viewportY);
    if (x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h) return image;
  }
  return null;
}

/**
 * One canvas over the terminal's cells, holding every visible placement.
 * Herdr blanks the cells an image covers and draws it at z=0, above the text,
 * so the layer sits over the text canvas and under the selection and cursor.
 */
export class ImageLayer {
  private readonly canvas: HTMLCanvasElement;
  private frame = 0;
  private drawn = false;

  static create(term: Terminal, graphics: KittyGraphics<ImageBitmap>): ImageLayer | null {
    const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) return null;
    const canvas = screen.ownerDocument.createElement('canvas');
    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas.getContext('2d');
    } catch {
      // No 2D canvas here: images stay undrawn, as they always were.
    }
    if (!context) return null;
    return new ImageLayer(screen, canvas, context, term, graphics);
  }

  private constructor(
    private readonly screen: HTMLElement,
    canvas: HTMLCanvasElement,
    private readonly context: CanvasRenderingContext2D,
    private readonly term: Terminal,
    private readonly graphics: KittyGraphics<ImageBitmap>,
  ) {
    this.canvas = canvas;
    canvas.classList.add('xterm-image-layer');
    Object.assign(canvas.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      zIndex: '1',
      pointerEvents: 'none',
    });
    screen.appendChild(canvas);
  }

  /** Redraws on the next frame; many changes in one frame draw once. */
  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  /** The image under these client coordinates — the one a click would open. */
  hitAt(clientX: number, clientY: number): ImageBitmap | null {
    if (typeof this.screen.getBoundingClientRect !== 'function') return null;
    const rect = this.screen.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0) return null;
    const { cellWidth, cellHeight } = measureCellDimensions(this.term);
    return hitImage(
      this.graphics.placements(),
      (imageId) => this.graphics.image(imageId),
      cellWidth,
      cellHeight,
      this.term.buffer.active.viewportY,
      x,
      y,
    );
  }

  dispose(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.canvas.remove();
  }

  private draw(): void {
    const placements = this.graphics.placements();
    // Herdr redraws its screen constantly; with nothing shown, do nothing.
    if (!placements.length && !this.drawn) return;
    const { cellWidth, cellHeight } = measureCellDimensions(this.term);
    const width = cellWidth * this.term.cols;
    const height = cellHeight * this.term.rows;
    const dpr = window.devicePixelRatio || 1;
    const deviceWidth = Math.round(width * dpr);
    const deviceHeight = Math.round(height * dpr);
    const { canvas, context } = this;
    if (canvas.width !== deviceWidth || canvas.height !== deviceHeight) {
      canvas.width = deviceWidth;
      canvas.height = deviceHeight;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, deviceWidth, deviceHeight);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawn = false;

    const viewportY = this.term.buffer.active.viewportY;
    for (const placement of placements) {
      const image = this.graphics.image(placement.imageId);
      if (!image) continue;
      const sx = Math.min(placement.sx, image.width);
      const sy = Math.min(placement.sy, image.height);
      const sw = Math.min(placement.sw || image.width, image.width - sx);
      const sh = Math.min(placement.sh || image.height, image.height - sy);
      if (sw <= 0 || sh <= 0) continue;
      const box = placementBox(placement, image, cellWidth, cellHeight, viewportY);
      if (box.y >= height || box.y + box.h <= 0) continue;
      context.drawImage(image, sx, sy, sw, sh, box.x, box.y, box.w, box.h);
      this.drawn = true;
    }
  }
}
