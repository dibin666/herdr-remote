import { describe, expect, it } from 'vitest';
import { hitImage, placementBox } from './imageLayer';
import type { Placement } from './kittyGraphics';

const image = { width: 200, height: 100 };

const placement = (overrides: Partial<Placement> = {}): Placement => ({
  imageId: 1,
  col: 2,
  line: 5,
  cols: 10,
  rows: 4,
  sx: 0,
  sy: 0,
  sw: 0,
  sh: 0,
  offsetX: 0,
  offsetY: 0,
  z: 0,
  ...overrides,
});

describe('placementBox', () => {
  it('fills the cells the placement spans', () => {
    const box = placementBox(placement(), image, 8, 20, 0);
    expect(box).toEqual({ x: 16, y: 100, w: 80, h: 80 });
  });

  it('scrolls with the viewport like the layer draws', () => {
    const box = placementBox(placement(), image, 8, 20, 3);
    expect(box.y).toBe(40);
  });

  it('derives the missing axis from the source aspect', () => {
    // Rows only: the width follows the image's own shape.
    const box = placementBox(placement({ cols: 0, rows: 2 }), image, 8, 20, 0);
    expect(box.h).toBe(40);
    expect(box.w).toBe(80);
  });
});

describe('hitImage', () => {
  const imageOf = (id: number) => (id === 1 ? image : null);

  it('finds the image a click lands on', () => {
    const hit = hitImage([placement()], imageOf, 8, 20, 0, 20, 110);
    expect(hit).toBe(image);
  });

  it('misses beside the box', () => {
    expect(hitImage([placement()], imageOf, 8, 20, 0, 15, 110)).toBeNull();
    expect(hitImage([placement()], imageOf, 8, 20, 0, 20, 99)).toBeNull();
    expect(hitImage([placement()], imageOf, 8, 20, 0, 20, 181)).toBeNull();
  });

  it('hits the topmost placement where two overlap', () => {
    const upper = { width: 50, height: 50 };
    const lower = { width: 60, height: 60 };
    // `placements` arrives bottom layer first, sorted by z.
    const placements = [placement(), placement({ imageId: 2, z: 1 })];
    const of = (id: number) => (id === 2 ? upper : id === 1 ? lower : null);
    expect(hitImage(placements, of, 8, 20, 0, 20, 110)).toBe(upper);
  });

  it('skips placements whose pixels are not decoded yet', () => {
    expect(hitImage([placement()], () => null, 8, 20, 0, 20, 110)).toBeNull();
  });
});
