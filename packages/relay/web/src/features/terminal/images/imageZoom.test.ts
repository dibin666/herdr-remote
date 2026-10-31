import { describe, expect, it } from 'vitest';
import {
  clampScale,
  clampToViewport,
  fitTransform,
  panBy,
  zoomAtPoint,
  zoomBounds,
} from './imageZoom';

describe('imageZoom', () => {
  it('fits a large image inside the viewport, centered', () => {
    const fit = fitTransform(800, 600, 1600, 1200);
    expect(fit.scale).toBe(0.5);
    expect(fit.tx).toBe(0);
    expect(fit.ty).toBe(0);
  });

  it('enlarges a small image to fill the viewport it opened in', () => {
    // A portrait screenshot fills the height first; the width follows.
    const fit = fitTransform(800, 600, 300, 900);
    expect(fit.scale).toBeCloseTo(600 / 900);
    expect(fit.tx).toBeCloseTo((800 - 300 * fit.scale) / 2);
    expect(fit.ty).toBe(0);
  });

  it('keeps the zoomed point stationary under the cursor', () => {
    const t = { scale: 1, tx: 20, ty: 10 };
    const zoomed = zoomAtPoint(t, 100, 80, 2);
    // The image point under (100, 80) stays under (100, 80).
    expect(100 - ((100 - t.tx) / t.scale) * zoomed.scale).toBeCloseTo(zoomed.tx);
    expect(80 - ((80 - t.ty) / t.scale) * zoomed.scale).toBeCloseTo(zoomed.ty);
  });

  it('clamps scale inside the fitted bounds', () => {
    const bounds = zoomBounds(0.5);
    expect(clampScale(0.01, bounds)).toBe(bounds.min);
    expect(clampScale(100, bounds)).toBe(bounds.max);
    expect(clampScale(1, bounds)).toBe(1);
  });

  it('pans by the pointer delta', () => {
    expect(panBy({ scale: 2, tx: 10, ty: 20 }, 5, -7)).toEqual({ scale: 2, tx: 15, ty: 13 });
  });

  it('pulls the image back when panned off-screen', () => {
    const t = clampToViewport({ scale: 1, tx: -500, ty: 900 }, 800, 600, 200, 200);
    expect(t.tx).toBeGreaterThanOrEqual(48 - 200);
    expect(t.ty).toBeLessThanOrEqual(600 - 48);
  });

  it('leaves a centered image alone', () => {
    const fit = fitTransform(800, 600, 800, 600);
    expect(clampToViewport(fit, 800, 600, 800, 600)).toEqual(fit);
  });
});
