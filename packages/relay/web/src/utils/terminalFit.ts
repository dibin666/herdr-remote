/**
 * Terminal grid fitting.
 *
 * The terminal fills the box it is handed: cols and rows come from the measured
 * container and the *measured* xterm cell metrics, and no CSS transform is
 * applied to the surface.
 *
 * Keeping the rendered surface in the same coordinate space the renderer
 * measures in is what makes pointer input land on the cell the user actually
 * touched. xterm 5.5 resolves a cell as `clientX - screenRect.left` over the
 * unscaled CSS cell width (see `getCoordsRelativeToElement` in
 * browser/input/Mouse.ts) and does not compensate for `transform: scale()`, so
 * a scaled surface silently offsets every mouse report, selection and link hit
 * test. A scaled 100-column grid also collapses the effective font to ~6px on a
 * phone, which is unreadable — a smaller grid at a legible size is the better
 * trade on a small screen.
 */

import { Terminal } from '@xterm/xterm';

/** Grid bounds. Wide enough to stay usable, tight enough to stay allocatable. */
export const MIN_TERMINAL_COLS = 20;
export const MIN_TERMINAL_ROWS = 6;
export const MAX_TERMINAL_COLS = 500;
export const MAX_TERMINAL_ROWS = 300;

export const DEFAULT_BASE_FONT_SIZE = 13;
/**
 * Monospace aspect ratios used only until the renderer reports real metrics.
 *
 * The height ratio is not the configured `lineHeight`: xterm derives a cell
 * from the font's own line box (`ceil(charHeight * lineHeight)`), which for a
 * typical monospace face at `lineHeight: 1.15` lands near 1.30 of the font
 * size, not 1.15. Estimating with the bare line height produced ~13% too many
 * rows, and since this estimate is what seeds the PTY before the renderer has
 * measured anything, those extra rows pushed the agent's output straight into
 * the scrollback. Erring slightly high instead costs at most a sub-cell
 * remainder at the bottom.
 */
export const FALLBACK_CELL_WIDTH_RATIO = 0.602;
export const FALLBACK_CELL_HEIGHT_RATIO = 1.3;

export interface GridFitInput {
  /** Available content box, in CSS px. */
  width: number;
  height: number;
  /** Cell size, in CSS px — ideally the renderer's own measurement. */
  cellWidth: number;
  cellHeight: number;
  minCols?: number;
  minRows?: number;
  maxCols?: number;
  maxRows?: number;
}

export interface GridFit {
  cols: number;
  rows: number;
}

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Resolves the grid that fills the given box. Degenerate input (a container
 * that has not been laid out, metrics that are not measurable yet) yields the
 * minimum usable grid rather than a zero-sized or NaN one.
 */
export function computeContainerGridFit(input: GridFitInput): GridFit {
  const {
    width,
    height,
    cellWidth,
    cellHeight,
    minCols = MIN_TERMINAL_COLS,
    minRows = MIN_TERMINAL_ROWS,
    maxCols = MAX_TERMINAL_COLS,
    maxRows = MAX_TERMINAL_ROWS,
  } = input;

  const safeCellWidth = positiveOr(cellWidth, DEFAULT_BASE_FONT_SIZE * FALLBACK_CELL_WIDTH_RATIO);
  const safeCellHeight = positiveOr(
    cellHeight,
    DEFAULT_BASE_FONT_SIZE * FALLBACK_CELL_HEIGHT_RATIO
  );

  return {
    cols: clamp(Math.floor(positiveOr(width, 0) / safeCellWidth), minCols, maxCols),
    rows: clamp(Math.floor(positiveOr(height, 0) / safeCellHeight), minRows, maxRows),
  };
}

export interface CellMetrics {
  cellWidth: number;
  cellHeight: number;
  /**
   * False when the values are the monospace estimate rather than the
   * renderer's own measurement. The first PTY resize waits for a true
   * measurement so the host is not told about a grid derived from a guess.
   */
  measured: boolean;
}

/**
 * Reads the renderer's character cell size, falling back to a monospace
 * estimate while the font is still loading.
 */
export function measureCellDimensions(
  term: Terminal | null,
  fallbackFontSize = DEFAULT_BASE_FONT_SIZE
): CellMetrics {
  if (term) {
    try {
      const core = (term as unknown as {
        _core?: {
          _renderService?: {
            dimensions?: {
              css?: {
                cell?: { width?: number; height?: number };
              };
            };
          };
        };
      })._core;

      const cssCell = core?._renderService?.dimensions?.css?.cell;
      if (cssCell && cssCell.width && cssCell.width > 0 && cssCell.height && cssCell.height > 0) {
        return { cellWidth: cssCell.width, cellHeight: cssCell.height, measured: true };
      }
    } catch {
      // ignore
    }
  }

  const size = positiveOr(fallbackFontSize, DEFAULT_BASE_FONT_SIZE);
  return {
    cellWidth: Math.round(size * FALLBACK_CELL_WIDTH_RATIO * 100) / 100,
    cellHeight: Math.round(size * FALLBACK_CELL_HEIGHT_RATIO * 100) / 100,
    measured: false,
  };
}

/**
 * Width the scrollbar steals from the row area, measured live so overlay
 * scrollbars (mobile) correctly report zero.
 */
export function measureScrollbarWidth(root: HTMLElement | null): number {
  const viewport = root?.querySelector?.('.xterm-viewport') as HTMLElement | null;
  if (!viewport) return 0;
  const gutter = (viewport.offsetWidth || 0) - (viewport.clientWidth || 0);
  return Number.isFinite(gutter) && gutter > 0 ? gutter : 0;
}

/** Available content box of an element, resilient to a not-yet-laid-out DOM. */
export function measureElementBox(
  element: HTMLElement | null,
  fallbackWidth: number,
  fallbackHeight: number
): { width: number; height: number } {
  if (!element) return { width: fallbackWidth, height: fallbackHeight };

  let rectWidth = 0;
  let rectHeight = 0;
  if (typeof element.getBoundingClientRect === 'function') {
    const rect = element.getBoundingClientRect();
    rectWidth = rect?.width || 0;
    rectHeight = rect?.height || 0;
  }

  return {
    width: positiveOr(rectWidth, positiveOr(element.clientWidth, fallbackWidth)),
    height: positiveOr(rectHeight, positiveOr(element.clientHeight, fallbackHeight)),
  };
}

/**
 * Converts screen coordinates into the surface's own coordinate space.
 *
 * The surface is unscaled, so this is the identity today; it stays because it
 * is the single place any future transform must be inverted, and the pointer
 * layer routes every coordinate through it.
 */
export function screenToLogicalCoords(
  screenX: number,
  screenY: number,
  surfaceRect: { left: number; top: number },
  scale: number
): { clientX: number; clientY: number } {
  const safeScale = Number.isFinite(scale) && scale > 0.01 ? scale : 1.0;
  return {
    clientX: surfaceRect.left + (screenX - surfaceRect.left) / safeScale,
    clientY: surfaceRect.top + (screenY - surfaceRect.top) / safeScale,
  };
}

/** Inverse of {@link screenToLogicalCoords}. */
export function logicalToScreenCoords(
  logicalX: number,
  logicalY: number,
  surfaceRect: { left: number; top: number },
  scale: number
): { screenX: number; screenY: number } {
  const safeScale = Number.isFinite(scale) && scale > 0.01 ? scale : 1.0;
  return {
    screenX: surfaceRect.left + (logicalX - surfaceRect.left) * safeScale,
    screenY: surfaceRect.top + (logicalY - surfaceRect.top) * safeScale,
  };
}
