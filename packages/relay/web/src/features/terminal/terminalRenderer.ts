/**
 * Renderer selection and probe-based fallback.
 *
 * The terminal is drawn by `render/HerdrRenderer`, a canvas renderer that
 * repaints only the cells that changed and never paints half of a Herdr
 * frame. xterm's DOM renderer is underneath it. There is no WebGL path.
 *
 * xterm's WebGL renderer draws glyphs from a texture atlas, and on at least one
 * ordinary stack — Intel Iris Xe, Mesa, ANGLE — it draws solid blocks instead of
 * text. Reproduced with @xterm/xterm 5.5.0 and @xterm/addon-webgl 0.18.0: the
 * same bytes and the same font, rendered side by side, came out as blocks under
 * WebGL and correct under both Canvas and DOM. It is not the atlas page merge
 * (it happens well below that threshold), and it is not font coverage (a glyph
 * that fails in one cell renders in another). The probe below cannot see that
 * failure — a screen full of blocks is a screen with content — so WebGL is not
 * a renderer this app chooses.
 *
 * What remains, for every device:
 *  - Install the canvas renderer, then verify pixel output once initial content
 *    (the startup banner) is drawn — "probe and degrade" rather than guessing
 *    from the user agent.
 *  - Pixel verification MUST wait until content has been emitted into the terminal,
 *    and until the renderer has painted it. An unpopulated buffer is uniformly
 *    blank by definition, and so is a canvas xterm has not yet asked to paint:
 *    either would cause a false-positive failure detection.
 *  - Distinguish three probe outcomes:
 *      * healthy: differing pixels detected -> keep canvas;
 *      * blank: sampled pixels are fully identical where the renderer painted
 *        visible characters -> driver returned a dead/blank surface -> hand
 *        drawing back to xterm's DOM renderer and persist failure;
 *      * inconclusive: layer not yet mounted, context unavailable, or sampling threw
 *        an unexpected error -> retain canvas without blacklisting.
 *  - Only definitive "blank" detections fall back to DOM and write to persistent storage.
 *    Uniform pixels alone are not one: a new session resets the screen, and
 *    Herdr can take a moment to draw it, so a probe landing in between saw a
 *    healthy canvas painted in one colour and put the device on the DOM
 *    renderer for a month.
 *  - Persistent failures in localStorage carry a timestamp and schema version ({ v: 1, ua: { [ua]: { failedAt } } }).
 *    Records automatically expire after 30 days to give driver updates an opportunity to recover.
 *    The key changed with the renderer, so a failure recorded against xterm's
 *    old canvas addon does not keep this one from being tried; and again when
 *    uniform pixels stopped counting on their own, so the failures that rule
 *    recorded against healthy canvases are forgotten.
 *  - Verification is repeated after the initial resize to catch driver failures
 *    triggered when backing-store dimensions change.
 */

import type { Terminal } from '@xterm/xterm';
import { HerdrRenderer } from './render/HerdrRenderer';
import { safeGetItem, safeSetItem, STORAGE_KEYS } from '@/shared/lib/browserStorage';

export type TerminalRendererKind = 'dom' | 'canvas';

export interface AttachRendererOptions {
  /** Called after a fallback swap so the caller can re-measure and repaint. */
  onRendererSwapped?: (kind: TerminalRendererKind) => void;
  /** True while the host is midway through a synchronized frame; see `screenState.ts`. */
  isSynchronizing?: () => boolean;
}

export interface AttachedRenderer {
  readonly kind: TerminalRendererKind;
  /** The canvas renderer while it draws the terminal; null once on the DOM renderer. */
  readonly canvas: HerdrRenderer | null;
  dispose: () => void;
  verify: () => Promise<void>;
}

/** How long the probe waits for the renderer to paint before sampling anyway. */
const MAX_PAINT_WAIT_FRAMES = 30;
/** The top-left corner the probe samples, in device pixels. */
const PROBE_SAMPLE_WIDTH = 640;
const PROBE_SAMPLE_HEIGHT = 240;
export const PROBE_STORAGE_SCHEMA_VERSION = 1;
export const PROBE_FAILURE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface ProbeFailureEntry {
  failedAt: number;
}

export interface ProbeStoreData {
  v: number;
  ua: Record<string, ProbeFailureEntry>;
}

function safeGetProbeStore(): ProbeStoreData {
  const raw = safeGetItem('local', STORAGE_KEYS.rendererProbe);
  if (!raw) return { v: PROBE_STORAGE_SCHEMA_VERSION, ua: {} };
  try {
    const data = JSON.parse(raw);
    if (
      typeof data === 'object' &&
      data !== null &&
      data.v === PROBE_STORAGE_SCHEMA_VERSION &&
      typeof data.ua === 'object' &&
      data.ua !== null
    ) {
      return data as ProbeStoreData;
    }
    return { v: PROBE_STORAGE_SCHEMA_VERSION, ua: {} };
  } catch {
    return { v: PROBE_STORAGE_SCHEMA_VERSION, ua: {} };
  }
}

function safeSetProbeFailed(ua: string, failedAt = Date.now()): void {
  const store = safeGetProbeStore();
  store.ua[ua] = { failedAt };
  safeSetItem('local', STORAGE_KEYS.rendererProbe, JSON.stringify(store));
}

export function isCanvasProbeFailed(ua?: string, now = Date.now()): boolean {
  const targetUa = ua ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  if (!targetUa) return false;
  const store = safeGetProbeStore();
  const entry = store.ua[targetUa];
  if (!entry || typeof entry.failedAt !== 'number') return false;
  if (now - entry.failedAt > PROBE_FAILURE_TTL_MS) {
    return false; // Expired after 30 days -> retry probe
  }
  return true;
}

export function recordCanvasProbeFailure(ua?: string, failedAt = Date.now()): void {
  const targetUa = ua ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  if (!targetUa) return;
  safeSetProbeFailed(targetUa, failedAt);
}

/**
 * Checks if the pixel data in the ImageData buffer has uniform color across all sampled pixels.
 * If all pixels are identical, the canvas is blank/black/empty.
 */
export function isUniformColor(data: Uint8ClampedArray | number[]): boolean {
  if (data.length < 4) return true;
  const r0 = data[0];
  const g0 = data[1];
  const b0 = data[2];
  const a0 = data[3];

  for (let i = 4; i < data.length; i += 4) {
    if (data[i] !== r0 || data[i + 1] !== g0 || data[i + 2] !== b0 || data[i + 3] !== a0) {
      return false; // Found differing pixel -> canvas has drawn content
    }
  }
  return true; // All pixels are completely identical (blank/empty)
}

export type CanvasProbeResult = 'healthy' | 'blank' | 'inconclusive';

/**
 * Checks whether the canvas has rendered actual content by sampling the top region
 * where the startup banner is located.
 *
 * Result states:
 *  - 'healthy': pixels with differences detected; canvas works properly.
 *  - 'blank': all sampled pixels are completely identical (blank/black screen).
 *  - 'inconclusive': text layer not found, context unavailable, 0 dimensions, or exception.
 */
export function checkCanvasContent(
  canvas: HTMLCanvasElement | null | undefined,
): CanvasProbeResult {
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
    console.debug('Canvas probe inconclusive: text layer canvas missing or zero dimensions');
    return 'inconclusive';
  }
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx =
      canvas.getContext('2d', { willReadFrequently: true }) ||
      (canvas.getContext('2d') as CanvasRenderingContext2D | null);
  } catch (err) {
    console.debug('Canvas probe inconclusive: failed to acquire 2D context:', err);
    return 'inconclusive';
  }
  if (!ctx) {
    console.debug('Canvas probe inconclusive: 2D context is null');
    return 'inconclusive';
  }

  // Sample top banner area expanded to min(width, 640) x min(height, 240) device pixels
  const sampleW = Math.min(canvas.width, PROBE_SAMPLE_WIDTH);
  const sampleH = Math.min(canvas.height, PROBE_SAMPLE_HEIGHT);
  if (sampleW <= 0 || sampleH <= 0) {
    console.debug('Canvas probe inconclusive: calculated sample dimensions are zero');
    return 'inconclusive';
  }

  try {
    const imageData = ctx.getImageData(0, 0, sampleW, sampleH);
    const uniform = isUniformColor(imageData.data);
    return uniform ? 'blank' : 'healthy';
  } catch (err) {
    console.debug('Canvas probe inconclusive: getImageData threw exception:', err);
    return 'inconclusive';
  }
}

export function waitForFrames(count = 2): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 32);
      return;
    }
    let remaining = count;
    const step = () => {
      remaining--;
      if (remaining <= 0) {
        resolve();
      } else {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  });
}

const DOM_RENDERER: AttachedRenderer = {
  kind: 'dom',
  canvas: null,
  dispose: () => {},
  verify: async () => {},
};

export function attachTerminalRenderer(
  term: Terminal,
  options: AttachRendererOptions = {},
): AttachedRenderer {
  if (isCanvasProbeFailed()) {
    return DOM_RENDERER;
  }

  let renderer: HerdrRenderer | null;
  try {
    renderer = HerdrRenderer.install(term, { isSynchronizing: options.isSynchronizing });
  } catch (canvasError) {
    console.debug('Canvas renderer unavailable, using the DOM renderer:', canvasError);
    recordCanvasProbeFailure();
    return DOM_RENDERER;
  }
  if (!renderer) {
    // This xterm does not expose what the renderer is built from; its own
    // renderer stays. Nothing is wrong with the device, so nothing is recorded.
    return DOM_RENDERER;
  }

  let current: HerdrRenderer | null = renderer;
  let verifyPromise: Promise<void> | null = null;

  const fallbackToDom = () => {
    if (!current) return;
    recordCanvasProbeFailure();
    const failed = current;
    current = null;
    try {
      failed.uninstall();
    } catch {
      // ignore
    }
    options.onRendererSwapped?.('dom');
  };

  const verify = async (): Promise<void> => {
    if (!current) return;
    if (verifyPromise) return verifyPromise;

    verifyPromise = (async () => {
      try {
        // xterm paints in its own animation-frame callback, which in a given
        // frame can run after this one: sampling before the renderer has
        // painted what was asked for finds a blank canvas that is not broken.
        const paintedBefore = current.stats.frames;
        await waitForFrames(2);
        for (
          let wait = 0;
          wait < MAX_PAINT_WAIT_FRAMES && current && current.stats.frames === paintedBefore;
          wait++
        ) {
          await waitForFrames(1);
        }
        if (!current) return;

        const probeResult = checkCanvasContent(current.textCanvas);
        if (
          probeResult === 'blank' &&
          current.hasPaintedInk(PROBE_SAMPLE_WIDTH, PROBE_SAMPLE_HEIGHT)
        ) {
          fallbackToDom();
        } else if (probeResult === 'blank') {
          console.debug('Canvas probe inconclusive: uniform, but no character was painted there');
        } else if (probeResult === 'inconclusive') {
          console.debug(
            'Canvas probe inconclusive; retaining canvas renderer without blacklisting',
          );
        }
      } catch (err) {
        console.debug('Canvas probe inconclusive: unexpected error during verify():', err);
      } finally {
        verifyPromise = null;
      }
    })();

    return verifyPromise;
  };

  return {
    get kind() {
      return current ? 'canvas' : 'dom';
    },
    get canvas() {
      return current;
    },
    dispose: () => {
      const installed = current;
      current = null;
      try {
        installed?.dispose();
      } catch {
        // ignore
      }
    },
    verify,
  };
}
