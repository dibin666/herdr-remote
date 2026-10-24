import type { Terminal } from '@xterm/xterm';
import { decodeImage } from './decodeImage';
import { ImageLayer } from './imageLayer';
import { createKittyApcRewriter, KITTY_GRAPHICS_OSC } from './kittyApc';
import { type ImageDecoder, KittyGraphics, type Placement } from './kittyGraphics';

export interface TerminalImages {
  /** Pass every output chunk through this before `term.write`. */
  rewrite(chunk: Uint8Array): Uint8Array;
  /** What is placed on screen now, bottom layer first. */
  placements(): Placement[];
  /** A new session: forget every image. */
  reset(): void;
  dispose(): void;
}

interface Disposable {
  dispose(): void;
}

/**
 * Draws the images Herdr sends as Kitty graphics. Without a parser to hook
 * (the test double), output passes through untouched and images stay
 * undrawn, as xterm alone leaves them.
 */
export function attachTerminalImages(
  term: Terminal,
  decode: ImageDecoder<ImageBitmap> = decodeImage,
): TerminalImages {
  if (typeof term.parser?.registerOscHandler !== 'function') {
    return { rewrite: (chunk) => chunk, placements: () => [], reset: () => {}, dispose: () => {} };
  }
  let layer: ImageLayer | null = null;
  const graphics = new KittyGraphics(decode, () => layer?.schedule());
  layer = ImageLayer.create(term, graphics);

  const disposables: Disposable[] = [
    term.parser.registerOscHandler(KITTY_GRAPHICS_OSC, (data) => {
      // Runs mid-parse, so the cursor is exactly where Herdr put it.
      const active = term.buffer.active;
      graphics.handle(data, { col: active.cursorX, line: active.baseY + active.cursorY });
      return true;
    }),
    term.buffer.onBufferChange(() => graphics.clearPlacements()),
  ];
  // Scrolling, resizing and a new font all repaint rows; images follow them.
  if (layer && typeof term.onRender === 'function') {
    disposables.push(term.onRender(() => layer?.schedule()));
  }

  let rewrite = createKittyApcRewriter();
  return {
    rewrite: (chunk) => rewrite(chunk),
    placements: () => graphics.placements(),
    reset: () => {
      rewrite = createKittyApcRewriter();
      graphics.reset();
    },
    dispose: () => {
      for (const disposable of disposables) disposable.dispose();
      layer?.dispose();
      layer = null;
    },
  };
}
