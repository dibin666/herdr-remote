/**
 * Renderer selection and probe-based fallback for xterm 5.5.
 *
 * Mobile/coarse-pointer devices:
 *  - Prefer the CanvasAddon over WebGL. Mobile WebGL implementations carry a much
 *    higher risk of context loss and driver-specific blank surfaces, whereas
 *    2D canvas offers smooth full-screen redraws with lower overhead.
 *  - Rather than preemptively abandoning GPU rendering on mobile, we adopt a
 *    "probe and degrade" strategy: mount CanvasAddon first, then verify pixel
 *    output once initial content (the startup banner) is drawn.
 *  - Pixel verification MUST wait until content has been emitted into the terminal.
 *    An unpopulated buffer is uniformly blank by definition, which would cause a
 *    false-positive failure detection.
 *  - Distinguish three probe outcomes:
 *      * healthy: differing pixels detected -> keep canvas;
 *      * blank: sampled pixels are fully identical -> driver returned a dead/blank
 *        surface -> dispose canvas, cleanly fall back to DOM, and persist failure;
 *      * inconclusive: layer not yet mounted, context unavailable, or sampling threw
 *        an unexpected error -> retain canvas without blacklisting.
 *  - Only definitive "blank" detections fall back to DOM and write to persistent storage.
 *  - Persistent failures in localStorage carry a timestamp and schema version ({ v: 1, ua: { [ua]: { failedAt } } }).
 *    Records automatically expire after 30 days to give driver updates an opportunity to recover.
 *  - Verification is repeated after the initial resize to catch driver failures
 *    triggered when backing-store dimensions change.
 *
 * Desktop/fine-pointer devices:
 *  - Retain WebGL for maximum throughput, with canvas as the context-loss fallback
 *    and the DOM renderer as the final safeguard. Every branch degrades rather than
 *    leaving the terminal blank.
 */

import { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { WebglAddon } from '@xterm/addon-webgl';

export type TerminalRendererKind = 'dom' | 'canvas' | 'webgl';

export interface AttachRendererOptions {
  /** Finger-driven device: prefer resilience and predictable touch over speed. */
  coarsePointer: boolean;
  /** Called after a fallback swap so the caller can re-measure and repaint. */
  onRendererSwapped?: (kind: TerminalRendererKind) => void;
}

export interface AttachedRenderer {
  readonly kind: TerminalRendererKind;
  dispose: () => void;
  verify: () => Promise<void>;
}

export const RENDERER_PROBE_STORAGE_KEY = 'herdr_remote_renderer_probe_v1';
export const PROBE_STORAGE_SCHEMA_VERSION = 1;
export const PROBE_FAILURE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface ProbeFailureEntry {
  failedAt: number;
}

export interface ProbeStoreData {
  v: number;
  ua: Record<string, ProbeFailureEntry>;
}

// In-memory fallback if localStorage is disabled or throws (safe for non-secure HTTP contexts)
const memoryProbeStore: Record<string, string> = {};

export function clearProbeMemoryStore(): void {
  for (const key of Object.keys(memoryProbeStore)) {
    delete memoryProbeStore[key];
  }
}

function safeGetProbeStore(): ProbeStoreData {
  let raw: string | null = null;
  if (typeof window === 'undefined') {
    raw = memoryProbeStore[RENDERER_PROBE_STORAGE_KEY] || null;
  } else {
    try {
      raw = window.localStorage ? window.localStorage.getItem(RENDERER_PROBE_STORAGE_KEY) : null;
    } catch {
      raw = memoryProbeStore[RENDERER_PROBE_STORAGE_KEY] || null;
    }
  }
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
  const serialized = JSON.stringify(store);
  memoryProbeStore[RENDERER_PROBE_STORAGE_KEY] = serialized;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage?.setItem(RENDERER_PROBE_STORAGE_KEY, serialized);
    } catch (err) {
      console.warn('Failed to write renderer probe result to localStorage:', err);
    }
  }
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
    if (
      data[i] !== r0 ||
      data[i + 1] !== g0 ||
      data[i + 2] !== b0 ||
      data[i + 3] !== a0
    ) {
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
export function checkCanvasContent(canvas: HTMLCanvasElement | null | undefined): CanvasProbeResult {
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
  const sampleW = Math.min(canvas.width, 640);
  const sampleH = Math.min(canvas.height, 240);
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

export function attachTerminalRenderer(
  term: Terminal,
  options: AttachRendererOptions
): AttachedRenderer {
  if (options.coarsePointer) {
    if (isCanvasProbeFailed()) {
      return {
        kind: 'dom',
        dispose: () => {},
        verify: async () => {},
      };
    }

    try {
      const canvasAddon = new CanvasAddon();
      term.loadAddon(canvasAddon);
      let currentKind: TerminalRendererKind = 'canvas';
      let isDisposed = false;
      let verifyPromise: Promise<void> | null = null;

      const fallbackToDom = () => {
        if (currentKind === 'dom') return;
        recordCanvasProbeFailure();
        try {
          canvasAddon.dispose();
        } catch {
          // ignore
        }
        currentKind = 'dom';
        options.onRendererSwapped?.('dom');
      };

      const verify = async (): Promise<void> => {
        if (isDisposed || currentKind !== 'canvas') return;
        if (verifyPromise) return verifyPromise;

        verifyPromise = (async () => {
          try {
            await waitForFrames(2);
            if (isDisposed || currentKind !== 'canvas') return;

            // Strictly query the text layer. Do NOT fall back to generic "canvas"
            // to avoid mistakenly sampling blank selection/cursor layers.
            const canvas = term.element?.querySelector<HTMLCanvasElement>('canvas.xterm-text-layer');

            const probeResult = checkCanvasContent(canvas);
            if (probeResult === 'blank') {
              fallbackToDom();
            } else if (probeResult === 'inconclusive') {
              console.debug('Canvas probe inconclusive; retaining canvas renderer without blacklisting');
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
          return currentKind;
        },
        dispose: () => {
          isDisposed = true;
          try {
            canvasAddon.dispose();
          } catch {
            // ignore
          }
        },
        verify,
      };
    } catch (canvasError) {
      console.debug('Canvas renderer constructor/addon load unavailable for coarse pointer, falling back to DOM:', canvasError);
      recordCanvasProbeFailure();
      return {
        kind: 'dom',
        dispose: () => {},
        verify: async () => {},
      };
    }
  }

  try {
    const webglAddon = new WebglAddon();
    let canvasFallback: CanvasAddon | null = null;
    let currentKind: TerminalRendererKind = 'webgl';
    let isDisposed = false;

    webglAddon.onContextLoss(() => {
      if (isDisposed) return;
      try {
        webglAddon.dispose();
      } catch {
        // ignore
      }
      try {
        canvasFallback = new CanvasAddon();
        term.loadAddon(canvasFallback);
        currentKind = 'canvas';
        options.onRendererSwapped?.('canvas');
      } catch (e) {
        console.debug('Canvas fallback failed after WebGL context loss:', e);
        currentKind = 'dom';
        options.onRendererSwapped?.('dom');
      }
    });

    term.loadAddon(webglAddon);
    return {
      get kind() {
        return currentKind;
      },
      dispose: () => {
        isDisposed = true;
        for (const addon of [canvasFallback, webglAddon]) {
          try {
            addon?.dispose();
          } catch {
            // ignore
          }
        }
      },
      verify: async () => {},
    };
  } catch (webglError) {
    console.debug('WebGL renderer unavailable, falling back to canvas:', webglError);
  }

  try {
    const canvasAddon = new CanvasAddon();
    term.loadAddon(canvasAddon);
    return {
      kind: 'canvas',
      dispose: () => {
        try {
          canvasAddon.dispose();
        } catch {
          // ignore
        }
      },
      verify: async () => {},
    };
  } catch (canvasError) {
    console.debug('Canvas renderer unavailable, using the DOM renderer:', canvasError);
  }

  return {
    kind: 'dom',
    dispose: () => {},
    verify: async () => {},
  };
}
