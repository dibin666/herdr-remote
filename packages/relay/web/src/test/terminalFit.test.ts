import { describe, it, expect } from 'vitest';
import {
  computeContainerGridFit,
  measureCellDimensions,
  measureElementBox,
  measureScrollbarWidth,
  screenToLogicalCoords,
  logicalToScreenCoords,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  DEFAULT_BASE_FONT_SIZE,
} from '../utils/terminalFit';

describe('computeContainerGridFit', () => {
  // A 13px monospace cell, as the renderer reports it.
  const cellWidth = 7.83;
  const cellHeight = 15;

  it('fills a phone-sized box with a legible grid instead of a scaled-down one', () => {
    // Regression for the screenshot: a stable 100-column grid scaled to a
    // 390px screen renders at roughly a 6px effective font — a black sliver of
    // unreadable text. Fitting the box at the real font size gives a usable
    // terminal that covers it.
    const fit = computeContainerGridFit({
      width: 390,
      height: 680,
      cellWidth,
      cellHeight,
    });

    expect(fit.cols).toBe(Math.floor(390 / cellWidth));
    expect(fit.rows).toBe(Math.floor(680 / cellHeight));
    expect(fit.cols).toBeGreaterThanOrEqual(40);
    expect(fit.rows).toBeGreaterThanOrEqual(40);

    // The grid never overflows the box it was measured from, in either axis.
    expect(fit.cols * cellWidth).toBeLessThanOrEqual(390);
    expect(fit.rows * cellHeight).toBeLessThanOrEqual(680);

    // ...and it leaves under one cell of remainder, so there is no band of
    // page background showing through beside or below the terminal.
    expect(390 - fit.cols * cellWidth).toBeLessThan(cellWidth);
    expect(680 - fit.rows * cellHeight).toBeLessThan(cellHeight);
  });

  it('covers the whole width across common phone and desktop widths', () => {
    for (const [width, height] of [
      [320, 520],
      [360, 640],
      [390, 680],
      [430, 780],
      [768, 900],
      [1440, 900],
    ]) {
      const fit = computeContainerGridFit({ width, height, cellWidth, cellHeight });
      expect(fit.cols * cellWidth).toBeLessThanOrEqual(width);
      expect(width - fit.cols * cellWidth).toBeLessThan(cellWidth);
      expect(fit.cols).toBeGreaterThanOrEqual(MIN_TERMINAL_COLS);
      expect(fit.rows).toBeGreaterThanOrEqual(MIN_TERMINAL_ROWS);
    }
  });

  it('returns a usable grid for a box that has not been laid out', () => {
    const degenerate = [
      { width: 0, height: 0, cellWidth: 0, cellHeight: 0 },
      { width: NaN, height: NaN, cellWidth, cellHeight },
      { width: 390, height: 680, cellWidth: NaN, cellHeight: NaN },
      { width: -100, height: -100, cellWidth, cellHeight },
    ];

    for (const input of degenerate) {
      const fit = computeContainerGridFit(input);
      expect(Number.isFinite(fit.cols)).toBe(true);
      expect(Number.isFinite(fit.rows)).toBe(true);
      expect(fit.cols).toBeGreaterThanOrEqual(MIN_TERMINAL_COLS);
      expect(fit.rows).toBeGreaterThanOrEqual(MIN_TERMINAL_ROWS);
    }
  });

  it('bounds an implausibly large box so the renderer is never asked for a giant grid', () => {
    const fit = computeContainerGridFit({
      width: Infinity,
      height: 10_000_000,
      cellWidth,
      cellHeight,
    });
    expect(fit.cols).toBeLessThanOrEqual(MAX_TERMINAL_COLS);
    expect(fit.rows).toBeLessThanOrEqual(MAX_TERMINAL_ROWS);
  });
});

describe('measureCellDimensions', () => {
  it('flags the monospace estimate so the first PTY resize can wait for real metrics', () => {
    const estimate = measureCellDimensions(null, 13);
    expect(estimate.measured).toBe(false);
    expect(estimate.cellWidth).toBeCloseTo(13 * 0.602, 1);
    // Modelled on the font's line box rather than the configured `lineHeight`:
    // a 13px monospace cell measures 17px tall in the DOM renderer, and this
    // estimate is what seeds the PTY before any real measurement exists.
    expect(estimate.cellHeight).toBeCloseTo(17, 0);

    const fallback = measureCellDimensions(null, 0);
    expect(fallback.cellWidth).toBeCloseTo(DEFAULT_BASE_FONT_SIZE * 0.602, 1);
  });

  it('reports the render service measurement once the font has been measured', () => {
    const term = {
      _core: { _renderService: { dimensions: { css: { cell: { width: 8.5, height: 16 } } } } },
    };

    // @ts-expect-error partial xterm mock
    const dims = measureCellDimensions(term);
    expect(dims).toEqual({ cellWidth: 8.5, cellHeight: 16, measured: true });
  });

  it('treats a zeroed render service as not-yet-measured', () => {
    const term = {
      _core: { _renderService: { dimensions: { css: { cell: { width: 0, height: 0 } } } } },
    };

    // @ts-expect-error partial xterm mock
    expect(measureCellDimensions(term, 13).measured).toBe(false);
  });
});

describe('measureElementBox', () => {
  it('prefers the fractional layout rect over rounded client dimensions', () => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({ width: 390.5, height: 679.25 }) as DOMRect;
    expect(measureElementBox(el, 1024, 768)).toEqual({ width: 390.5, height: 679.25 });
  });

  it('falls back to the viewport when the element has not been laid out', () => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect;
    expect(measureElementBox(el, 390, 680)).toEqual({ width: 390, height: 680 });
    expect(measureElementBox(null, 390, 680)).toEqual({ width: 390, height: 680 });
  });
});

describe('measureScrollbarWidth', () => {
  it('reports the gutter an inline scrollbar takes from the row area', () => {
    const root = document.createElement('div');
    const viewport = document.createElement('div');
    viewport.className = 'xterm-viewport';
    root.appendChild(viewport);

    Object.defineProperty(viewport, 'offsetWidth', { value: 300, configurable: true });
    Object.defineProperty(viewport, 'clientWidth', { value: 288, configurable: true });
    expect(measureScrollbarWidth(root)).toBe(12);

    // Mobile overlay scrollbars take no width at all.
    Object.defineProperty(viewport, 'clientWidth', { value: 300, configurable: true });
    expect(measureScrollbarWidth(root)).toBe(0);
    expect(measureScrollbarWidth(null)).toBe(0);
  });
});

describe('Coordinate transforms', () => {
  const surfaceRect = { left: 10, top: 20 };

  it('is the identity for the unscaled surface the terminal actually uses', () => {
    expect(screenToLogicalCoords(100, 200, surfaceRect, 1.0)).toEqual({
      clientX: 100,
      clientY: 200,
    });
  });

  it('round-trips through a scale so any future transform inverts exactly', () => {
    const logical = screenToLogicalCoords(150, 250, surfaceRect, 0.5);
    expect(logical.clientX).toBe(10 + (150 - 10) / 0.5);

    const back = logicalToScreenCoords(logical.clientX, logical.clientY, surfaceRect, 0.5);
    expect(back.screenX).toBeCloseTo(150, 4);
    expect(back.screenY).toBeCloseTo(250, 4);
  });

  it('treats a degenerate scale as 1 rather than dividing by zero', () => {
    expect(screenToLogicalCoords(100, 200, surfaceRect, 0)).toEqual({ clientX: 100, clientY: 200 });
    expect(screenToLogicalCoords(100, 200, surfaceRect, NaN)).toEqual({
      clientX: 100,
      clientY: 200,
    });
  });
});
