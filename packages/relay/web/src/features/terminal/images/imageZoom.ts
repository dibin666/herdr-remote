// The pan/zoom transform of the image preview overlay, kept as plain math so
// the pointer, pinch and wheel handlers all share one set of rules.

/** `scale` times the image's pixels, offset `tx`/`ty` CSS px from the viewport's top-left. */
export interface ZoomTransform {
  scale: number;
  tx: number;
  ty: number;
}

/** How far a gesture may push the scale in either direction. */
export interface ZoomBounds {
  min: number;
  max: number;
}

/** The slice of the image that must stay reachable, in CSS px. */
const EDGE_MARGIN_PX = 48;

/**
 * Centers the image at the largest size still fully visible. Small images are
 * enlarged to fit — the point of opening the preview is seeing more, not the
 * terminal's squeezed copy again.
 */
export function fitTransform(
  viewW: number,
  viewH: number,
  imgW: number,
  imgH: number,
): ZoomTransform {
  const scale = Math.min(viewW / imgW, viewH / imgH);
  return {
    scale,
    tx: (viewW - imgW * scale) / 2,
    ty: (viewH - imgH * scale) / 2,
  };
}

/**
 * Bounds around the fitted scale: half of it still shows the whole picture,
 * and past ~8x natural size nothing is left to enlarge.
 */
export function zoomBounds(fit: number): ZoomBounds {
  return { min: fit * 0.5, max: Math.max(fit * 16, 8) };
}

export function clampScale(scale: number, bounds: ZoomBounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, scale));
}

/** Zooms while keeping the image point under (`x`, `y`) stationary. */
export function zoomAtPoint(
  transform: ZoomTransform,
  x: number,
  y: number,
  scale: number,
): ZoomTransform {
  if (scale === transform.scale) return transform;
  const ratio = scale / transform.scale;
  return {
    scale,
    tx: x - (x - transform.tx) * ratio,
    ty: y - (y - transform.ty) * ratio,
  };
}

export function panBy(transform: ZoomTransform, dx: number, dy: number): ZoomTransform {
  return { scale: transform.scale, tx: transform.tx + dx, ty: transform.ty + dy };
}

/**
 * Pulls the transform back so a strip of the image stays inside the viewport;
 * without it one fast flick could fling the picture off-screen for good. An
 * image smaller than the margin clamp keeps whatever position it was given.
 */
export function clampToViewport(
  transform: ZoomTransform,
  viewW: number,
  viewH: number,
  imgW: number,
  imgH: number,
): ZoomTransform {
  const clampAxis = (pos: number, size: number, view: number): number => {
    const lo = EDGE_MARGIN_PX - size;
    const hi = view - EDGE_MARGIN_PX;
    if (lo > hi) return pos;
    return Math.min(hi, Math.max(lo, pos));
  };
  const tx = clampAxis(transform.tx, imgW * transform.scale, viewW);
  const ty = clampAxis(transform.ty, imgH * transform.scale, viewH);
  if (tx === transform.tx && ty === transform.ty) return transform;
  return { scale: transform.scale, tx, ty };
}
