import { describe, it, expect } from 'vitest';
import {
  getVisualZoomSnapshot,
  evaluateResizeEvent,
  VisualZoomSnapshot,
} from '../utils/visualZoom';

describe('visualZoom helper unit tests', () => {
  it('computes initial snapshot accurately with default dpr and scale', () => {
    const box = { width: 1024, height: 768 };
    const snapshot = getVisualZoomSnapshot(box);

    expect(snapshot.dpr).toBeGreaterThan(0);
    expect(snapshot.scale).toBe(1);
    expect(snapshot.cssWidth).toBe(1024);
    expect(snapshot.cssHeight).toBe(768);
    expect(snapshot.physicalWidth).toBe(1024 * snapshot.dpr);
    expect(snapshot.physicalHeight).toBe(768 * snapshot.dpr);
  });

  it('evaluates initial snapshot as non-ignored', () => {
    const current: VisualZoomSnapshot = {
      dpr: 1.0,
      scale: 1.0,
      cssWidth: 1024,
      cssHeight: 768,
      physicalWidth: 1024,
      physicalHeight: 768,
    };
    const decision = evaluateResizeEvent({ lastSnapshot: null, currentSnapshot: current });
    expect(decision.shouldIgnore).toBe(false);
    expect(decision.reason).toBe('initial');
  });

  it('detects desktop browser zoom (Ctrl +/- / DPR change) with constant physical dimensions', () => {
    const last: VisualZoomSnapshot = {
      dpr: 1.0,
      scale: 1.0,
      cssWidth: 1000,
      cssHeight: 800,
      physicalWidth: 1000,
      physicalHeight: 800,
    };
    // Zoom in 125%: DPR = 1.25, CSS px = 800 x 640, physical px = 1000 x 800
    const current: VisualZoomSnapshot = {
      dpr: 1.25,
      scale: 1.0,
      cssWidth: 800,
      cssHeight: 640,
      physicalWidth: 1000,
      physicalHeight: 800,
    };

    const decision = evaluateResizeEvent({ lastSnapshot: last, currentSnapshot: current });
    expect(decision.isVisualZoom).toBe(true);
    expect(decision.shouldIgnore).toBe(true);
    expect(decision.reason).toBe('dpr_zoom');
  });

  it('detects mobile pinch-to-zoom (visualViewport scale change)', () => {
    const last: VisualZoomSnapshot = {
      dpr: 3.0,
      scale: 1.0,
      cssWidth: 390,
      cssHeight: 780,
      physicalWidth: 1170,
      physicalHeight: 2340,
    };
    const current: VisualZoomSnapshot = {
      dpr: 3.0,
      scale: 1.5,
      cssWidth: 390,
      cssHeight: 780,
      physicalWidth: 1170,
      physicalHeight: 2340,
    };

    const decision = evaluateResizeEvent({ lastSnapshot: last, currentSnapshot: current });
    expect(decision.isVisualZoom).toBe(true);
    expect(decision.shouldIgnore).toBe(true);
    expect(decision.reason).toBe('visual_pinch_zoom');
  });

  it('identifies genuine container window resize', () => {
    const last: VisualZoomSnapshot = {
      dpr: 1.0,
      scale: 1.0,
      cssWidth: 1024,
      cssHeight: 768,
      physicalWidth: 1024,
      physicalHeight: 768,
    };
    const current: VisualZoomSnapshot = {
      dpr: 1.0,
      scale: 1.0,
      cssWidth: 1440,
      cssHeight: 768,
      physicalWidth: 1440,
      physicalHeight: 768,
    };

    const decision = evaluateResizeEvent({ lastSnapshot: last, currentSnapshot: current });
    expect(decision.isVisualZoom).toBe(false);
    expect(decision.shouldIgnore).toBe(false);
    expect(decision.reason).toBe('genuine_resize');
  });

  it('identifies mobile on-screen keyboard appearing as genuine layout height change', () => {
    const last: VisualZoomSnapshot = {
      dpr: 3.0,
      scale: 1.0,
      cssWidth: 390,
      cssHeight: 780,
      physicalWidth: 1170,
      physicalHeight: 2340,
    };
    const current: VisualZoomSnapshot = {
      dpr: 3.0,
      scale: 1.0,
      cssWidth: 390,
      cssHeight: 450,
      physicalWidth: 1170,
      physicalHeight: 1350,
    };

    const decision = evaluateResizeEvent({ lastSnapshot: last, currentSnapshot: current });
    expect(decision.isVisualZoom).toBe(false);
    expect(decision.shouldIgnore).toBe(false);
    expect(decision.reason).toBe('genuine_resize');
  });
});
