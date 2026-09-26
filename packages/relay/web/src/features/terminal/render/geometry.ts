// Cell and canvas sizes, in CSS and device pixels.

import type { Disposable, RenderDimensions, XtermCore } from './xtermInternals';

export function createDimensions(): RenderDimensions {
  return {
    css: { canvas: { width: 0, height: 0 }, cell: { width: 0, height: 0 } },
    device: {
      canvas: { width: 0, height: 0 },
      cell: { width: 0, height: 0 },
      char: { width: 0, height: 0, left: 0, top: 0 },
    },
  };
}

/**
 * Lays out `cols` × `rows` cells for the measured character size, in place.
 * Returns false, changing nothing, while the font has not been measured yet.
 */
export function layoutCells(
  dims: RenderDimensions,
  core: Pick<XtermCore, '_charSizeService' | '_coreBrowserService' | 'optionsService'>,
  cols: number,
  rows: number,
): boolean {
  const charSize = core._charSizeService;
  if (!charSize.hasValidSize) return false;
  const dpr = core._coreBrowserService.dpr;
  const options = core.optionsService.rawOptions;
  // Same arithmetic as xterm's canvas and WebGL renderers, so cells land on
  // whole device pixels and mouse reports map to the same cells.
  dims.device.char.width = Math.floor(charSize.width * dpr);
  dims.device.char.height = Math.ceil(charSize.height * dpr);
  dims.device.cell.height = Math.floor(dims.device.char.height * options.lineHeight);
  dims.device.char.top =
    options.lineHeight === 1
      ? 0
      : Math.round((dims.device.cell.height - dims.device.char.height) / 2);
  dims.device.cell.width = dims.device.char.width + Math.round(options.letterSpacing);
  dims.device.char.left = Math.floor(options.letterSpacing / 2);
  dims.device.canvas.height = rows * dims.device.cell.height;
  dims.device.canvas.width = cols * dims.device.cell.width;
  dims.css.canvas.height = Math.round(dims.device.canvas.height / dpr);
  dims.css.canvas.width = Math.round(dims.device.canvas.width / dpr);
  dims.css.cell.height = dims.css.canvas.height / rows;
  dims.css.cell.width = dims.css.canvas.width / cols;
  return true;
}

/**
 * Tracks the canvas's exact size in device pixels. At fractional ratios
 * (125%, 150%) rounding CSS pixels drifts by a pixel and blurs everything;
 * `devicePixelContentBoxSize` is the size the compositor really uses.
 * `onSize` hears of it whenever it differs from the canvas's own size.
 */
export function watchDevicePixelSize(
  view: (Window & typeof globalThis) | undefined,
  canvas: HTMLCanvasElement,
  onSize: (width: number, height: number) => void,
): Disposable | null {
  if (!view || typeof view.ResizeObserver !== 'function') return null;
  let observer: ResizeObserver | null = new view.ResizeObserver((entries) => {
    const entry = entries.find((candidate) => candidate.target === canvas);
    if (!entry) return;
    if (!('devicePixelContentBoxSize' in entry) || !entry.devicePixelContentBoxSize?.[0]) {
      observer?.disconnect();
      observer = null;
      return;
    }
    const width = entry.devicePixelContentBoxSize[0].inlineSize;
    const height = entry.devicePixelContentBoxSize[0].blockSize;
    if (width <= 0 || height <= 0) return;
    if (width === canvas.width && height === canvas.height) return;
    onSize(width, height);
  });
  try {
    observer.observe(canvas, { box: 'device-pixel-content-box' });
  } catch {
    observer.disconnect();
    observer = null;
  }
  return { dispose: () => observer?.disconnect() };
}
