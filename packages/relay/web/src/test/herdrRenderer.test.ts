import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Terminal } from '@xterm/headless';

// setup.ts replaces the renderer for component tests; these test the real one.
vi.unmock('@/features/terminal/render/HerdrRenderer');

import { HerdrRenderer } from '@/features/terminal/render/HerdrRenderer';
import type { PaintOverlay } from '@/features/terminal/render/paintOverlay';
import { resolveCellColors, type ThemeColors } from '@/features/terminal/render/colors';
import { readCellStyle } from '@/features/terminal/render/cell';

/**
 * The renderer against a real xterm parser and buffer (@xterm/headless), with
 * the browser-side services it reads faked, and a 2D context that records
 * what it is asked to draw. jsdom has no canvas of its own.
 */

interface Recorder {
  calls: Array<[string, ...unknown[]]>;
}

function recordingContext(): CanvasRenderingContext2D & Recorder {
  const state: Record<string | symbol, unknown> = { calls: [] as Recorder['calls'] };
  return new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') {
        return (text: string) => ({
          width: 8 * [...text].length,
          actualBoundingBoxRight: 7 * [...text].length,
        });
      }
      return (...args: unknown[]) => {
        (target.calls as Recorder['calls']).push([String(prop), ...args]);
      };
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D & Recorder;
}

function palette(): ThemeColors {
  const color = (css: string) => ({ css, rgba: (parseInt(css.slice(1), 16) << 8) | 0xff });
  const ansi = Array.from({ length: 256 }, (_, i) =>
    color(`#${(i * 0x010101).toString(16).padStart(6, '0')}`),
  );
  return {
    foreground: color('#d0d0d0'),
    background: color('#101010'),
    cursor: color('#ffffff'),
    cursorAccent: color('#000000'),
    selectionBackgroundTransparent: color('#334455'),
    selectionInactiveBackgroundTransparent: color('#222222'),
    ansi,
  };
}

const originalGetContext = HTMLCanvasElement.prototype.getContext;
let contexts: Array<CanvasRenderingContext2D & Recorder> = [];

beforeEach(() => {
  contexts = [];
  HTMLCanvasElement.prototype.getContext = function getContext() {
    const ctx = recordingContext();
    contexts.push(ctx);
    return ctx;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
});

/** A ResizeObserver whose entries a test hands over by hand. */
class ManualResizeObserver {
  static last: ManualResizeObserver | null = null;
  constructor(readonly callback: (entries: unknown[]) => void) {
    ManualResizeObserver.last = this;
  }
  target: Element | null = null;
  observe(target: Element) {
    this.target = target;
  }
  disconnect() {}
  report(width: number, height: number) {
    this.callback([
      {
        target: this.target,
        devicePixelContentBoxSize: [{ inlineSize: width, blockSize: height }],
      },
    ]);
  }
}

function setup(cols = 20, rows = 6, dpr = 1) {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  const headless = (term as unknown as { _core: Record<string, unknown> })._core;
  // The browser build does this on focus, input or the alternate screen, which
  // Herdr always uses; headless never does.
  (headless.coreService as { isCursorInitialized: boolean }).isCursorInitialized = true;
  const screenElement = document.createElement('div');
  const redraws: Array<{ start: number; end: number }> = [];
  let clock = 0;
  let synchronizing = false;
  let installed: HerdrRenderer | null = null;
  const colorListeners: Array<() => void> = [];
  const core = {
    screenElement,
    coreService: headless.coreService,
    optionsService: headless.optionsService,
    _bufferService: headless._bufferService,
    _charSizeService: { width: 8, height: 16, hasValidSize: true },
    _coreBrowserService: {
      isFocused: true,
      dpr,
      window: Object.assign(Object.create(window), { ResizeObserver: ManualResizeObserver }),
      mainDocument: document,
    },
    _themeService: {
      colors: palette(),
      onChangeColors: (listener: () => void) => {
        colorListeners.push(listener);
        return { dispose: () => {} };
      },
    },
    _renderService: {
      setRenderer(renderer: HerdrRenderer) {
        installed = renderer;
        renderer.onRequestRedraw((e) => redraws.push(e));
      },
      handleResize(c: number, r: number) {
        installed?.handleResize(c, r);
      },
      refreshRows() {},
    },
  };
  const renderer = HerdrRenderer.install({ _core: core } as never, {
    isSynchronizing: () => synchronizing,
    now: () => clock,
    maxSyncHoldMs: 150,
  })!;
  const mainContext = contexts[0];
  return {
    term,
    renderer,
    screenElement,
    redraws,
    mainContext,
    changeColors: () => colorListeners.forEach((listener) => listener()),
    write: (data: string) => new Promise<void>((resolve) => term.write(data, resolve)),
    frame: () => renderer.renderRows(0, rows - 1),
    set synchronizing(value: boolean) {
      synchronizing = value;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('HerdrRenderer', () => {
  it('installs a text and a decoration canvas, sized in whole device pixels per cell', () => {
    const t = setup(20, 6);
    const canvases = t.screenElement.querySelectorAll('canvas');
    expect([...canvases].map((canvas) => canvas.className)).toEqual([
      'xterm-text-layer',
      'xterm-decor-layer',
    ]);
    expect(t.renderer.dimensions.device.cell).toEqual({ width: 8, height: 16 });
    expect(t.renderer.dimensions.css.canvas).toEqual({ width: 160, height: 96 });
    expect(t.renderer.textCanvas.width).toBe(160);
  });

  it('paints every cell once, then only what changed', async () => {
    const t = setup(20, 6);
    await t.write('hello');
    t.frame();
    expect(t.renderer.stats.lastCells).toBe(20 * 6);

    t.frame();
    expect(t.renderer.stats.lastCells).toBe(0);
  });

  it('repaints one typed character and the cursor it moved, nothing else', async () => {
    const t = setup(20, 6);
    await t.write('hello');
    t.frame();

    await t.write('!');
    t.frame();
    // The "!" where the cursor was, and the cell the cursor moved to.
    expect(t.renderer.stats.lastCells).toBe(2);
  });

  it('costs only the changed cells when the top and bottom change in one frame', async () => {
    const t = setup(20, 6);
    await t.write('pane text\r\nmore\x1b[3;5H');
    t.frame();

    // A tab highlight at the top, a spinner at the bottom, cursor back where it was.
    await t.write('\x1b[1;1H\x1b[7mA\x1b[0m\x1b[6;20H*\x1b[3;5H');
    t.frame();
    expect(t.renderer.stats.lastCells).toBe(2);
  });

  it('holds a synchronized frame until it ends, then paints it once', async () => {
    const t = setup(20, 6);
    await t.write('before');
    t.frame();
    const painted = t.renderer.stats.frames;

    t.synchronizing = true;
    await t.write('\x1b[2;1Hhalf');
    t.renderer.renderRows(1, 1);
    expect(t.renderer.stats.frames).toBe(painted);
    expect(t.renderer.stats.heldFrames).toBe(1);

    t.synchronizing = false;
    t.renderer.flushHeld();
    expect(t.redraws.at(-1)).toEqual({ start: 1, end: 1 });
    t.renderer.renderRows(0, 0);
    expect(t.renderer.stats.frames).toBe(painted + 1);
    // The held row is painted with whatever row xterm asked for.
    expect(t.renderer.stats.lastCells).toBeGreaterThanOrEqual(4);
  });

  it('paints a frame whose end never arrives once the hold runs out', async () => {
    const t = setup(20, 6);
    await t.write('x');
    t.frame();
    const painted = t.renderer.stats.frames;

    t.synchronizing = true;
    await t.write('y');
    t.frame();
    expect(t.renderer.stats.frames).toBe(painted);
    t.advance(200);
    t.frame();
    expect(t.renderer.stats.frames).toBe(painted + 1);
  });

  it('paints a predicted cell like the echo, so the echo landing repaints nothing', async () => {
    const t = setup(20, 6);
    await t.write('ab');
    t.frame();

    const style = readCellStyle(t.term.buffer.active.getLine(0)!.getCell(0))!;
    let overlay: PaintOverlay | null = {
      cells: [{ row: 0, col: 2, chars: 'c', width: 1, style }],
      cursor: { row: 0, col: 3 },
    };
    t.renderer.setOverlayProvider(() => overlay);
    t.frame();
    // "c" over the old cursor cell, and the cursor one cell on.
    expect(t.renderer.stats.lastCells).toBe(2);

    await t.write('c');
    overlay = null;
    t.renderer.invalidateOverlay();
    t.frame();
    expect(t.renderer.stats.lastCells).toBe(0);
  });

  it('asks xterm to redraw the rows an overlay leaves and enters', async () => {
    const t = setup(20, 6);
    await t.write('ab');
    t.frame();
    let overlay: PaintOverlay | null = {
      cells: [{ row: 3, col: 1, chars: 'z', width: 1, style: { fg: 0, bg: 0, ext: 0 } }],
    };
    t.renderer.setOverlayProvider(() => overlay);
    expect(t.redraws.at(-1)).toEqual({ start: 0, end: 3 });
    t.frame();
    overlay = null;
    t.redraws.length = 0;
    t.renderer.invalidateOverlay();
    expect(t.redraws.at(-1)).toEqual({ start: 0, end: 3 });
  });

  it('repaints the whole screen when the colours change', async () => {
    const t = setup(20, 6);
    await t.write('hi');
    t.frame();
    t.changeColors();
    t.frame();
    expect(t.renderer.stats.lastCells).toBe(20 * 6);
  });

  it('draws text through the glyph atlas and blank runs as single fills', async () => {
    const t = setup(20, 2);
    await t.write('ab');
    t.mainContext.calls.length = 0;
    t.frame();
    const draws = t.mainContext.calls.filter(([name]) => name === 'drawImage');
    const fills = t.mainContext.calls.filter(([name]) => name === 'fillRect');
    // "a" and "b" are glyphs copied from the atlas.
    expect(draws).toHaveLength(2);
    // The block cursor over a blank cell, then the rest of row 0 as one run
    // and row 1 as another.
    expect(fills).toHaveLength(3);
    expect(fills[0].slice(1)).toEqual([16, 0, 8, 16]);
    expect(fills[1].slice(1)).toEqual([24, 0, 17 * 8, 16]);
    expect(fills[2].slice(1)).toEqual([0, 16, 20 * 8, 16]);
  });

  it("takes the compositor's pixel size as a rounding correction, and nothing more", () => {
    const t = setup(20, 6, 1.25);
    const css = t.renderer.dimensions.css.canvas;
    const canvas = t.renderer.textCanvas;
    const exact = { width: canvas.width, height: canvas.height };

    // Emulated device scales report CSS pixels here: not a size the cells fit.
    ManualResizeObserver.last!.report(css.width, css.height);
    expect({ width: canvas.width, height: canvas.height }).toEqual(exact);

    ManualResizeObserver.last!.report(
      Math.round(css.width * 1.25) + 1,
      Math.round(css.height * 1.25),
    );
    expect(canvas.width).toBe(Math.round(css.width * 1.25) + 1);
  });

  it('hands drawing back to the DOM renderer when uninstalled', () => {
    const t = setup(20, 6);
    const created = { handleResize: vi.fn() };
    const core = (
      t.renderer as unknown as {
        core: {
          _createRenderer?: () => unknown;
          _renderService: { setRenderer: (r: unknown) => void };
        };
      }
    ).core;
    const setRenderer = vi.fn();
    core._createRenderer = () => created;
    core._renderService.setRenderer = setRenderer;
    t.renderer.uninstall();
    expect(setRenderer).toHaveBeenCalledWith(created);
    expect(t.screenElement.querySelectorAll('canvas')).toHaveLength(0);
  });

  it('knows whether characters it painted are on the canvas in a corner', async () => {
    // Cells are 8 × 16 device pixels.
    const t = setup(20, 6);
    expect(t.renderer.hasPaintedInk(640, 240)).toBe(false);

    await t.write('\x1b[8mhidden');
    t.frame();
    expect(t.renderer.hasPaintedInk(640, 240)).toBe(false);

    await t.write('\x1b[0m\x1b[2J\x1b[5;1Hhello');
    t.frame();
    // Only the first two rows are wholly inside 32 pixels.
    expect(t.renderer.hasPaintedInk(640, 32)).toBe(false);
    expect(t.renderer.hasPaintedInk(640, 80)).toBe(true);

    // A new session clears the screen; the canvas is one colour and nothing is wrong.
    await t.write('\x1b[2J');
    t.frame();
    expect(t.renderer.hasPaintedInk(640, 240)).toBe(false);

    await t.write('\x1b[1;1H中');
    t.frame();
    expect(t.renderer.hasPaintedInk(640, 240)).toBe(true);
  });
});

describe('resolveCellColors', () => {
  const colors = palette();
  const P16 = 0x1000000;
  const P256 = 0x2000000;
  const RGB = 0x3000000;
  const BOLD = 0x8000000;
  const INVERSE = 0x4000000;

  it('uses the theme defaults', () => {
    expect(resolveCellColors(0, 0, colors, true)).toEqual({
      fg: '#d0d0d0',
      bg: '#101010',
      bgIsDefault: true,
    });
  });

  it('moves bold text in the first eight colours to the bright eight, whichever way the colour was set', () => {
    expect(resolveCellColors(P16 | 1 | BOLD, 0, colors, true).fg).toBe(colors.ansi[9].css);
    expect(resolveCellColors(P256 | 1 | BOLD, 0, colors, true).fg).toBe(colors.ansi[9].css);
    expect(resolveCellColors(P256 | 9 | BOLD, 0, colors, true).fg).toBe(colors.ansi[9].css);
    expect(resolveCellColors(P16 | 1 | BOLD, 0, colors, false).fg).toBe(colors.ansi[1].css);
  });

  it('draws truecolor as it is', () => {
    expect(resolveCellColors(RGB | 0x123456, RGB | 0xabcdef, colors, true)).toEqual({
      fg: '#123456',
      bg: '#abcdef',
      bgIsDefault: false,
    });
  });

  it('swaps under inverse, a default colour becoming the other default', () => {
    expect(resolveCellColors(INVERSE, 0, colors, true)).toEqual({
      fg: '#101010',
      bg: '#d0d0d0',
      bgIsDefault: false,
    });
    expect(resolveCellColors(INVERSE | P16 | 2, RGB | 0x0000ff, colors, true)).toEqual({
      fg: '#0000ff',
      bg: colors.ansi[2].css,
      bgIsDefault: false,
    });
  });
});
