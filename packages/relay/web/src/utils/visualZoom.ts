/**
 * Visual Zoom & DPR Detection and Isolation.
 *
 * Prevents native browser zoom (Ctrl +/- / Ctrl 0 / pinch zoom / visualViewport scale / devicePixelRatio changes)
 * from triggering logical PTY resize events to Herdr backend across all windows.
 */

export interface VisualZoomSnapshot {
  dpr: number;
  scale: number;
  cssWidth: number;
  cssHeight: number;
  physicalWidth: number;
  physicalHeight: number;
}

export function getVisualZoomSnapshot(
  box: { width: number; height: number },
  customWindow?: Window
): VisualZoomSnapshot {
  const win = customWindow || (typeof window !== 'undefined' ? window : undefined);
  const dpr =
    win && typeof win.devicePixelRatio === 'number' && win.devicePixelRatio > 0
      ? win.devicePixelRatio
      : 1;
  const scale =
    win &&
    win.visualViewport &&
    typeof win.visualViewport.scale === 'number' &&
    win.visualViewport.scale > 0
      ? win.visualViewport.scale
      : 1;

  const cssWidth = Math.max(0, box.width);
  const cssHeight = Math.max(0, box.height);
  const physicalWidth = Math.round(cssWidth * dpr * 100) / 100;
  const physicalHeight = Math.round(cssHeight * dpr * 100) / 100;

  return {
    dpr,
    scale,
    cssWidth,
    cssHeight,
    physicalWidth,
    physicalHeight,
  };
}

export interface ShouldIgnoreResizeOptions {
  lastSnapshot: VisualZoomSnapshot | null;
  currentSnapshot: VisualZoomSnapshot;
  /** Tolerance in physical pixels to account for fractional sub-pixel rounding during zoom. Default: 6 */
  physicalTolerancePx?: number;
}

export interface ResizeDecision {
  shouldIgnore: boolean;
  isVisualZoom: boolean;
  reason: 'initial' | 'visual_pinch_zoom' | 'dpr_zoom' | 'no_box_change' | 'genuine_resize';
}

/**
 * Determines whether a container resize event is caused by visual browser zoom
 * (which should NOT send a PTY resize) vs a genuine layout/window dimension change.
 */
export function evaluateResizeEvent(options: ShouldIgnoreResizeOptions): ResizeDecision {
  const { lastSnapshot, currentSnapshot, physicalTolerancePx = 6 } = options;

  if (!lastSnapshot) {
    return { shouldIgnore: false, isVisualZoom: false, reason: 'initial' };
  }

  // 1. Mobile pinch-to-zoom (visualViewport.scale != 1.0 or scale changed)
  const scaleChanged = Math.abs(currentSnapshot.scale - lastSnapshot.scale) > 0.01;
  const isPinchZoomed = Math.abs(currentSnapshot.scale - 1.0) > 0.01;
  if (scaleChanged || isPinchZoomed) {
    return { shouldIgnore: true, isVisualZoom: true, reason: 'visual_pinch_zoom' };
  }

  // 2. Desktop browser zoom (devicePixelRatio changed)
  const dprChanged = Math.abs(currentSnapshot.dpr - lastSnapshot.dpr) > 0.01;
  if (dprChanged) {
    // Check if the physical pixel size stayed virtually constant (i.e. browser zoom changed CSS px inversely with DPR)
    const physicalWidthDiff = Math.abs(currentSnapshot.physicalWidth - lastSnapshot.physicalWidth);
    const physicalHeightDiff = Math.abs(currentSnapshot.physicalHeight - lastSnapshot.physicalHeight);

    if (physicalWidthDiff <= physicalTolerancePx && physicalHeightDiff <= physicalTolerancePx) {
      return { shouldIgnore: true, isVisualZoom: true, reason: 'dpr_zoom' };
    }
  }

  // 3. Check CSS dimension change
  const cssWidthDiff = Math.abs(currentSnapshot.cssWidth - lastSnapshot.cssWidth);
  const cssHeightDiff = Math.abs(currentSnapshot.cssHeight - lastSnapshot.cssHeight);
  if (cssWidthDiff < 1 && cssHeightDiff < 1) {
    return { shouldIgnore: true, isVisualZoom: false, reason: 'no_box_change' };
  }

  // 4. Genuine physical resize (e.g. dragging window edges, mobile keyboard opening/closing)
  return { shouldIgnore: false, isVisualZoom: false, reason: 'genuine_resize' };
}
