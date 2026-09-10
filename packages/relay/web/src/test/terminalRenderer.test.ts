import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import {
  attachTerminalRenderer,
  isUniformColor,
  checkCanvasContent,
  RENDERER_PROBE_STORAGE_KEY,
  PROBE_STORAGE_SCHEMA_VERSION,
  PROBE_FAILURE_TTL_MS,
  isCanvasProbeFailed,
  recordCanvasProbeFailure,
  clearProbeMemoryStore,
} from '../utils/terminalRenderer';

function createMockTerminal(opts?: { omitTextLayerClass?: boolean; emptyElement?: boolean }): {
  term: Terminal;
  canvas: HTMLCanvasElement;
  element: HTMLDivElement;
} {
  const element = document.createElement('div');
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  const canvas = document.createElement('canvas');
  if (!opts?.omitTextLayerClass) {
    canvas.className = 'xterm-text-layer';
  } else {
    canvas.className = 'xterm-selection-layer';
  }
  canvas.width = 800;
  canvas.height = 400;
  if (!opts?.emptyElement) {
    screen.appendChild(canvas);
    element.appendChild(screen);
  }

  const term = {
    element: opts?.emptyElement ? undefined : element,
    cols: 80,
    rows: 24,
    loadAddon: vi.fn(),
  } as unknown as Terminal;

  return { term, canvas, element };
}

function mockCanvasContext(
  canvas: HTMLCanvasElement,
  pixelDataGenerator: (w: number, h: number) => Uint8ClampedArray
) {
  const mockCtx = {
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => {
      const data = pixelDataGenerator(w, h);
      return {
        data,
        width: w,
        height: h,
      };
    }),
  } as unknown as CanvasRenderingContext2D;

  canvas.getContext = vi.fn().mockReturnValue(mockCtx);
  return mockCtx;
}

describe('terminalRenderer mobile canvas probe and fallback', () => {
  const originalUserAgent = navigator.userAgent;

  beforeEach(() => {
    localStorage.clear();
    clearProbeMemoryStore();
    vi.mocked(WebglAddon).mockClear();
    vi.mocked(CanvasAddon).mockClear();
  });

  afterEach(() => {
    localStorage.clear();
    clearProbeMemoryStore();
    Object.defineProperty(navigator, 'userAgent', {
      value: originalUserAgent,
      writable: true,
      configurable: true,
    });
  });

  describe('isUniformColor utility', () => {
    it('returns true when all pixels are identical (blank or black)', () => {
      const black = new Uint8ClampedArray(400); // all zeros
      expect(isUniformColor(black)).toBe(true);

      const opaqueWhite = new Uint8ClampedArray(400);
      opaqueWhite.fill(255);
      expect(isUniformColor(opaqueWhite)).toBe(true);
    });

    it('returns false when at least one pixel differs', () => {
      const buffer = new Uint8ClampedArray(400); // 100 pixels of 0,0,0,0
      buffer[40] = 255;
      buffer[41] = 255;
      buffer[42] = 255;
      buffer[43] = 255;
      expect(isUniformColor(buffer)).toBe(false);
    });
  });

  describe('checkCanvasContent utility', () => {
    it('returns inconclusive when canvas is missing or dimensions are zero', () => {
      expect(checkCanvasContent(null)).toBe('inconclusive');

      const canvas = document.createElement('canvas');
      canvas.width = 0;
      canvas.height = 0;
      expect(checkCanvasContent(canvas)).toBe('inconclusive');
    });

    it('returns healthy when canvas has non-uniform drawn content', () => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 400;
      mockCanvasContext(canvas, (w, h) => {
        const data = new Uint8ClampedArray(w * h * 4);
        data[0] = 255; // differing pixel
        return data;
      });
      expect(checkCanvasContent(canvas)).toBe('healthy');
    });

    it('returns blank when canvas has uniform content', () => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 400;
      mockCanvasContext(canvas, (w, h) => new Uint8ClampedArray(w * h * 4));
      expect(checkCanvasContent(canvas)).toBe('blank');
    });

    it('returns inconclusive when getImageData throws exception', () => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 400;
      const mockCtx = {
        getImageData: vi.fn(() => {
          throw new Error('SecurityError: tainted canvas');
        }),
      } as unknown as CanvasRenderingContext2D;
      canvas.getContext = vi.fn().mockReturnValue(mockCtx);

      expect(checkCanvasContent(canvas)).toBe('inconclusive');
    });
  });

  describe('coarse pointer (mobile/tablet)', () => {
    it('maintains canvas renderer when canvas renders content normally', async () => {
      const { term, canvas } = createMockTerminal();
      mockCanvasContext(canvas, (w, h) => {
        const data = new Uint8ClampedArray(w * h * 4);
        // Text foreground pixel
        data[20] = 255;
        data[21] = 255;
        data[22] = 255;
        data[23] = 255;
        return data;
      });

      const onRendererSwapped = vi.fn();
      const renderer = attachTerminalRenderer(term, {
        coarsePointer: true,
        onRendererSwapped,
      });

      expect(renderer.kind).toBe('canvas');
      expect(term.loadAddon).toHaveBeenCalledTimes(1);

      await renderer.verify();

      expect(renderer.kind).toBe('canvas');
      expect(onRendererSwapped).not.toHaveBeenCalled();
      expect(isCanvasProbeFailed()).toBe(false);
    });

    it('falls back to dom when canvas is definitively blank, writes timestamped schema, and notifies caller', async () => {
      const { term, canvas } = createMockTerminal();
      // Blank surface: all 0s
      mockCanvasContext(canvas, (w, h) => new Uint8ClampedArray(w * h * 4));

      const onRendererSwapped = vi.fn();
      const renderer = attachTerminalRenderer(term, {
        coarsePointer: true,
        onRendererSwapped,
      });

      expect(renderer.kind).toBe('canvas');

      await renderer.verify();

      expect(renderer.kind).toBe('dom');
      expect(onRendererSwapped).toHaveBeenCalledWith('dom');
      expect(isCanvasProbeFailed()).toBe(true);

      const raw = localStorage.getItem(RENDERER_PROBE_STORAGE_KEY);
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      expect(parsed.v).toBe(PROBE_STORAGE_SCHEMA_VERSION);
      expect(typeof parsed.ua[navigator.userAgent].failedAt).toBe('number');
    });

    it('retains canvas and does NOT record failure when probe is inconclusive (missing text layer or exception)', async () => {
      // Case 1: missing canvas.xterm-text-layer (e.g. only selection layer exists)
      const { term: termMissingTextLayer } = createMockTerminal({ omitTextLayerClass: true });
      const onRendererSwapped1 = vi.fn();

      const renderer1 = attachTerminalRenderer(termMissingTextLayer, {
        coarsePointer: true,
        onRendererSwapped: onRendererSwapped1,
      });
      expect(renderer1.kind).toBe('canvas');

      await renderer1.verify();
      // Must retain canvas, must not downgrade to dom, must not blacklist
      expect(renderer1.kind).toBe('canvas');
      expect(onRendererSwapped1).not.toHaveBeenCalled();
      expect(isCanvasProbeFailed()).toBe(false);
      expect(localStorage.getItem(RENDERER_PROBE_STORAGE_KEY)).toBeNull();

      // Case 2: getImageData throws exception
      const { term: termWithThrowingCanvas, canvas: throwingCanvas } = createMockTerminal();
      throwingCanvas.getContext = vi.fn().mockReturnValue({
        getImageData: vi.fn(() => {
          throw new Error('Canvas readback failure');
        }),
      } as unknown as CanvasRenderingContext2D);

      const onRendererSwapped2 = vi.fn();
      const renderer2 = attachTerminalRenderer(termWithThrowingCanvas, {
        coarsePointer: true,
        onRendererSwapped: onRendererSwapped2,
      });

      await renderer2.verify();
      // Inconclusive must not fallback to dom or blacklist
      expect(renderer2.kind).toBe('canvas');
      expect(onRendererSwapped2).not.toHaveBeenCalled();
      expect(isCanvasProbeFailed()).toBe(false);
      expect(localStorage.getItem(RENDERER_PROBE_STORAGE_KEY)).toBeNull();
    });

    it('ignores expired (> 30 days) probe failures and re-probes with canvas', async () => {
      const now = Date.now();
      const thirtyOneDaysAgo = now - (PROBE_FAILURE_TTL_MS + 24 * 60 * 60 * 1000);

      // Record old failure 31 days ago
      recordCanvasProbeFailure(navigator.userAgent, thirtyOneDaysAgo);

      // Must report not failed due to TTL expiry
      expect(isCanvasProbeFailed(navigator.userAgent, now)).toBe(false);

      const { term, canvas } = createMockTerminal();
      mockCanvasContext(canvas, (w, h) => {
        const data = new Uint8ClampedArray(w * h * 4);
        data[0] = 200; // text content
        return data;
      });

      const onRendererSwapped = vi.fn();
      const renderer = attachTerminalRenderer(term, {
        coarsePointer: true,
        onRendererSwapped,
      });

      // Should attempt canvas rather than jumping to dom
      expect(renderer.kind).toBe('canvas');
      expect(term.loadAddon).toHaveBeenCalledTimes(1);

      await renderer.verify();
      expect(renderer.kind).toBe('canvas');
      expect(onRendererSwapped).not.toHaveBeenCalled();
    });

    it('immediately uses dom and skips canvas when valid non-expired failure is recorded for this UA', async () => {
      recordCanvasProbeFailure();
      expect(isCanvasProbeFailed()).toBe(true);

      const { term } = createMockTerminal();
      const onRendererSwapped = vi.fn();

      const renderer = attachTerminalRenderer(term, {
        coarsePointer: true,
        onRendererSwapped,
      });

      expect(renderer.kind).toBe('dom');
      expect(term.loadAddon).not.toHaveBeenCalled();

      await renderer.verify();
      expect(renderer.kind).toBe('dom');
      expect(onRendererSwapped).not.toHaveBeenCalled();
    });

    it('catches "starts healthy then turns black" on initial resize re-verification', async () => {
      const { term, canvas } = createMockTerminal();
      let isCorrupted = false;

      mockCanvasContext(canvas, (w, h) => {
        const data = new Uint8ClampedArray(w * h * 4);
        if (!isCorrupted) {
          // Healthy content
          data[10] = 200;
          data[11] = 200;
          data[12] = 200;
          data[200] = 255;
        }
        // If corrupted, returns all zeros (blank)
        return data;
      });

      const onRendererSwapped = vi.fn();
      const renderer = attachTerminalRenderer(term, {
        coarsePointer: true,
        onRendererSwapped,
      });

      // 1st verify: passes
      await renderer.verify();
      expect(renderer.kind).toBe('canvas');
      expect(onRendererSwapped).not.toHaveBeenCalled();

      // Simulate resize corrupting backing store to all-black
      isCorrupted = true;

      // 2nd verify (post-resize check): detects blank canvas and degrades
      await renderer.verify();
      expect(renderer.kind).toBe('dom');
      expect(onRendererSwapped).toHaveBeenCalledWith('dom');
      expect(isCanvasProbeFailed()).toBe(true);
    });

    it('falls back cleanly to in-memory store when localStorage throws SecurityError', async () => {
      const originalGet = localStorage.getItem;
      const originalSet = localStorage.setItem;

      localStorage.getItem = vi.fn(() => {
        throw new Error('SecurityError: localStorage disabled');
      });
      localStorage.setItem = vi.fn(() => {
        throw new Error('SecurityError: localStorage disabled');
      });

      try {
        const { term, canvas } = createMockTerminal();
        mockCanvasContext(canvas, (w, h) => new Uint8ClampedArray(w * h * 4)); // blank

        const onRendererSwapped = vi.fn();
        const renderer = attachTerminalRenderer(term, {
          coarsePointer: true,
          onRendererSwapped,
        });

        // Verification must not throw despite storage error
        await renderer.verify();
        expect(renderer.kind).toBe('dom');
        expect(onRendererSwapped).toHaveBeenCalledWith('dom');

        // Subsequent check in same runtime remembers via in-memory fallback
        expect(isCanvasProbeFailed()).toBe(true);

        const term2 = createMockTerminal().term;
        const renderer2 = attachTerminalRenderer(term2, { coarsePointer: true });
        expect(renderer2.kind).toBe('dom');
      } finally {
        localStorage.getItem = originalGet;
        localStorage.setItem = originalSet;
      }
    });
  });

  describe('fine pointer (desktop)', () => {
    it('preserves desktop WebGL renderer and keeps verify() as a no-op', async () => {
      const { term } = createMockTerminal();
      const onRendererSwapped = vi.fn();

      const renderer = attachTerminalRenderer(term, {
        coarsePointer: false,
        onRendererSwapped,
      });

      expect(renderer.kind).toBe('webgl');
      expect(WebglAddon).toHaveBeenCalledTimes(1);

      await renderer.verify();
      expect(renderer.kind).toBe('webgl');
      expect(onRendererSwapped).not.toHaveBeenCalled();
    });

    it('falls back to canvas and then to dom on Webgl context loss', async () => {
      let contextLossHandler: (() => void) | undefined;
      vi.mocked(WebglAddon).mockImplementationOnce(() => ({
        onContextLoss: vi.fn((cb: () => void) => {
          contextLossHandler = cb;
        }),
        dispose: vi.fn(),
      } as unknown as WebglAddon));

      const { term } = createMockTerminal();
      const onRendererSwapped = vi.fn();

      const renderer = attachTerminalRenderer(term, {
        coarsePointer: false,
        onRendererSwapped,
      });

      expect(renderer.kind).toBe('webgl');
      expect(contextLossHandler).toBeDefined();

      // Trigger WebGL context loss
      contextLossHandler!();

      expect(renderer.kind).toBe('canvas');
      expect(onRendererSwapped).toHaveBeenCalledWith('canvas');
    });
  });
});
