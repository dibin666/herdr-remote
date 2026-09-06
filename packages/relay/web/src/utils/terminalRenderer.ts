/**
 * Renderer selection for xterm 5.5.
 *
 * Coarse-pointer devices get the built-in DOM renderer. That is deliberate and
 * not a performance oversight:
 *
 *  - WebGL and canvas both hand back a blank (black) surface rather than an
 *    error on the mobile GPU/driver combinations that refuse an oversized or
 *    context-lost backing store, and there is no reliable way to detect that
 *    from script;
 *  - DOM-rendered rows remain the most resilient mobile fallback; touch input
 *    is handled by the gesture layer so the platform cannot reinterpret the
 *    terminal as a page-wide text-selection surface.
 *
 * Desktop keeps WebGL for throughput, with canvas as the context-loss fallback
 * and the DOM renderer underneath that. Every branch degrades rather than
 * leaving the terminal blank.
 */

import { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { WebglAddon } from '@xterm/addon-webgl';

export type TerminalRendererKind = 'dom' | 'canvas' | 'webgl';

export interface AttachRendererOptions {
  /** Finger-driven device: prefer resilience and predictable touch over speed. */
  coarsePointer: boolean;
  /** Called after a fallback swap so the caller can re-measure and repaint. */
  onRendererSwapped?: () => void;
}

export interface AttachedRenderer {
  kind: TerminalRendererKind;
  dispose: () => void;
}

export function attachTerminalRenderer(
  term: Terminal,
  options: AttachRendererOptions
): AttachedRenderer {
  if (options.coarsePointer) {
    return { kind: 'dom', dispose: () => {} };
  }

  try {
    const webglAddon = new WebglAddon();
    let canvasFallback: CanvasAddon | null = null;

    webglAddon.onContextLoss(() => {
      try {
        webglAddon.dispose();
      } catch {
        // ignore
      }
      try {
        canvasFallback = new CanvasAddon();
        term.loadAddon(canvasFallback);
      } catch (e) {
        console.debug('Canvas fallback failed after WebGL context loss:', e);
      }
      options.onRendererSwapped?.();
    });

    term.loadAddon(webglAddon);
    return {
      kind: 'webgl',
      dispose: () => {
        for (const addon of [canvasFallback, webglAddon]) {
          try {
            addon?.dispose();
          } catch {
            // ignore
          }
        }
      },
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
    };
  } catch (canvasError) {
    console.debug('Canvas renderer unavailable, using the DOM renderer:', canvasError);
  }

  return { kind: 'dom', dispose: () => {} };
}
