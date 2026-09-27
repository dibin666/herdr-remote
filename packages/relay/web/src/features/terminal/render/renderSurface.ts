// The canvases the renderer draws on, text below and selection above, kept
// at exactly the size the cells were laid out for.

import { DecorLayer } from './decorLayer';
import { watchDevicePixelSize } from './geometry';
import type { Disposable, RenderDimensions } from './xtermInternals';

export class RenderSurface {
  readonly text: HTMLCanvasElement;
  readonly textContext: CanvasRenderingContext2D;
  readonly decor: DecorLayer;

  constructor(
    document: Document,
    private readonly screen: HTMLElement,
  ) {
    this.text = document.createElement('canvas');
    this.text.classList.add('xterm-text-layer');
    this.text.style.zIndex = '0';
    const ctx = this.text.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas unavailable');
    this.textContext = ctx;
    this.decor = new DecorLayer(document);
    screen.appendChild(this.text);
    screen.appendChild(this.decor.canvas);
  }

  /** Sizes both canvases, and the screen element holding them, to `dims`. */
  size(dims: RenderDimensions): void {
    for (const canvas of [this.text, this.decor.canvas]) {
      canvas.width = dims.device.canvas.width;
      canvas.height = dims.device.canvas.height;
      canvas.style.width = `${dims.css.canvas.width}px`;
      canvas.style.height = `${dims.css.canvas.height}px`;
    }
    this.screen.style.width = `${dims.css.canvas.width}px`;
    this.screen.style.height = `${dims.css.canvas.height}px`;
  }

  /**
   * Adopts the canvases' exact size in device pixels, as the compositor
   * rounds it (see watchDevicePixelSize), then calls `onAdopted`: whatever
   * was on them is gone.
   */
  watchDevicePixels(
    view: (Window & typeof globalThis) | undefined,
    dims: RenderDimensions,
    dpr: () => number,
    onAdopted: () => void,
  ): Disposable | null {
    return watchDevicePixelSize(view, this.text, (width, height) => {
      // A rounding correction is a pixel or two. Anything else is a size the
      // cells were not laid out for (emulated device scales report CSS pixels
      // here), and drawing into it would scale the whole grid.
      const css = dims.css.canvas;
      if (Math.abs(width - css.width * dpr()) > 2 || Math.abs(height - css.height * dpr()) > 2)
        return;
      dims.device.canvas.width = width;
      dims.device.canvas.height = height;
      for (const canvas of [this.text, this.decor.canvas]) {
        canvas.width = width;
        canvas.height = height;
      }
      onAdopted();
    });
  }

  remove(): void {
    this.text.remove();
    this.decor.canvas.remove();
  }
}

/** A web font that finishes loading changes glyphs already cached with its fallback. */
export function watchFontLoads(document: Document, onLoaded: () => void): Disposable | null {
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts || typeof fonts.addEventListener !== 'function') return null;
  fonts.addEventListener('loadingdone', onLoaded);
  return { dispose: () => fonts.removeEventListener('loadingdone', onLoaded) };
}
