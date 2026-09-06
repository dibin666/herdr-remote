/**
 * Visual viewport plumbing for the mobile app shell.
 *
 * `100dvh` and `window.innerHeight` both keep reporting the full screen when
 * the iOS soft keyboard opens — only `visualViewport.height` shrinks. The app
 * shell therefore sizes itself from a CSS variable driven by that value, which
 * is what keeps the key toolbar reachable above the keyboard instead of being
 * pushed underneath it.
 */

export const APP_HEIGHT_VAR = '--app-height';
export const KEYBOARD_INSET_VAR = '--keyboard-inset';

export interface ViewportMetrics {
  /** Height actually visible to the user, in CSS px. */
  height: number;
  /** How much of the layout viewport the soft keyboard is covering, in CSS px. */
  keyboardInset: number;
}

/**
 * Treat anything smaller than this as measurement noise (browser chrome
 * collapsing, rubber-band scroll) rather than a keyboard.
 */
export const KEYBOARD_INSET_THRESHOLD_PX = 80;

export function readViewportMetrics(): ViewportMetrics {
  if (typeof window === 'undefined') return { height: 768, keyboardInset: 0 };

  const layoutHeight = window.innerHeight || 768;
  const vv = window.visualViewport;

  if (vv && typeof vv.height === 'number' && vv.height > 0) {
    const covered = layoutHeight - vv.height - (vv.offsetTop || 0);
    const keyboardInset = covered >= KEYBOARD_INSET_THRESHOLD_PX ? Math.round(covered) : 0;
    return { height: Math.round(vv.height), keyboardInset };
  }

  return { height: layoutHeight, keyboardInset: 0 };
}

export function applyViewportMetrics(
  target: HTMLElement,
  metrics: ViewportMetrics = readViewportMetrics()
): ViewportMetrics {
  target.style.setProperty(APP_HEIGHT_VAR, `${metrics.height}px`);
  target.style.setProperty(KEYBOARD_INSET_VAR, `${metrics.keyboardInset}px`);
  return metrics;
}

/**
 * Mirrors the visual viewport onto CSS variables until the returned disposer is
 * called. Updates are coalesced into an animation frame because iOS fires
 * `resize` and `scroll` in a burst for the whole keyboard animation.
 */
export function observeViewportMetrics(
  target: HTMLElement | null = typeof document !== 'undefined' ? document.documentElement : null
): () => void {
  if (!target || typeof window === 'undefined') return () => {};

  let frame: number | null = null;
  const flush = (): void => {
    frame = null;
    applyViewportMetrics(target);
  };

  const schedule = (): void => {
    if (frame !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      flush();
      return;
    }
    frame = requestAnimationFrame(flush);
  };

  applyViewportMetrics(target);

  const vv = window.visualViewport;
  vv?.addEventListener('resize', schedule);
  vv?.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);

  return () => {
    if (frame !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(frame);
      frame = null;
    }
    vv?.removeEventListener('resize', schedule);
    vv?.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
    target.style.removeProperty(APP_HEIGHT_VAR);
    target.style.removeProperty(KEYBOARD_INSET_VAR);
  };
}
