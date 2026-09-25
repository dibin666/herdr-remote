// Fitting the terminal grid to its box, and telling the host the new size.
//
// Visual-only vs PTY geometry:
// - The PTY grid (cols x rows) is strictly governed by the physical container dimensions
//   (window/layout viewport) and a stable baseline geometry (DEFAULT_BASE_FONT_SIZE = 13).
// - Changing local font size / font family / theme in settings is a purely visual renderer adjustment:
//   it updates xterm options and refreshes the canvas/DOM without recalculating PTY columns/rows
//   or dispatching PTY resize frames.

import type { Terminal } from '@xterm/xterm';
import { type RefObject, useCallback, useRef } from 'react';
import {
  computeContainerGridFit,
  DEFAULT_BASE_FONT_SIZE,
  measureCellDimensions,
  measureElementBox,
  measureScrollbarWidth,
} from '../../utils/terminalFit';
import { getViewportHeight, getViewportWidth } from '../../utils/terminalLayout';
import type { AttachedRenderer } from '../../utils/terminalRenderer';
import {
  evaluateResizeEvent,
  getVisualZoomSnapshot,
  type VisualZoomSnapshot,
} from '../../utils/visualZoom';
import { useLatest } from './useLatest';

/**
 * Resize notifications to the PTY are coalesced over this window. The mobile
 * keyboard animation drives visualViewport through dozens of intermediate
 * heights; without this the host would receive a stream of throwaway grids.
 */
export const RESIZE_NOTIFY_DEBOUNCE_MS = 250;

interface Box {
  width: number;
  height: number;
}

export function useTerminalFit({
  termRef,
  containerRef,
  frameRef,
  surfaceRef,
  currentScaleRef,
  rendererRef,
  initialBannerWrittenRef,
  isActiveRef,
  sendResize,
  onResized,
}: {
  termRef: RefObject<Terminal | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  frameRef: RefObject<HTMLDivElement | null>;
  surfaceRef: RefObject<HTMLDivElement | null>;
  currentScaleRef: RefObject<number>;
  rendererRef: RefObject<AttachedRenderer | null>;
  initialBannerWrittenRef: RefObject<boolean>;
  isActiveRef: RefObject<boolean>;
  /** Tell the host the new grid. */
  sendResize: (cols: number, rows: number) => void;
  /** The host was told a new grid. */
  onResized: () => void;
}) {
  const sendResizeRef = useLatest(sendResize);
  const onResizedRef = useLatest(onResized);
  const lastSentDimensionsRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeNotifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fitFrameRef = useRef<number | null>(null);
  const boundedFitRafRef = useRef<number | null>(null);
  const lastBoxRef = useRef<Box>({ width: 0, height: 0 });
  const lastZoomSnapshotRef = useRef<VisualZoomSnapshot | null>(null);
  const firstResizeVerifiedRef = useRef<boolean>(false);

  /** Debounced, change-gated PTY resize notification. */
  const notifyResize = useCallback(
    (cols: number, rows: number) => {
      if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return;
      if (
        cols === lastSentDimensionsRef.current.cols &&
        rows === lastSentDimensionsRef.current.rows
      ) {
        return;
      }

      pendingResizeRef.current = { cols, rows };
      if (resizeNotifyTimerRef.current) return;

      resizeNotifyTimerRef.current = setTimeout(() => {
        resizeNotifyTimerRef.current = null;
        const pending = pendingResizeRef.current;
        pendingResizeRef.current = null;
        if (!pending) return;
        if (
          pending.cols === lastSentDimensionsRef.current.cols &&
          pending.rows === lastSentDimensionsRef.current.rows
        ) {
          return;
        }
        lastSentDimensionsRef.current = pending;
        sendResizeRef.current(pending.cols, pending.rows);
        onResizedRef.current();
      }, RESIZE_NOTIFY_DEBOUNCE_MS);
    },
    [sendResizeRef, onResizedRef],
  );

  const handleFit = useCallback(
    (force = false) => {
      const term = termRef.current;
      const container = containerRef.current;
      const surface = surfaceRef.current;
      const frame = frameRef.current;
      if (!term || !container || !surface || !frame) return;

      const box = measureElementBox(container, getViewportWidth(), getViewportHeight());
      if (box.width <= 0 || box.height <= 0) return;

      // Full-bleed visual geometry. Nothing here paints a color: xterm owns
      // the canvas, so the host's background is the only background.
      frame.style.width = '100%';
      frame.style.height = '100%';
      surface.style.width = '100%';
      surface.style.height = '100%';
      surface.style.transform = 'none';
      surface.style.transformOrigin = 'top left';
      currentScaleRef.current = 1.0;

      const currentSnapshot = getVisualZoomSnapshot(box);
      const decision = evaluateResizeEvent({
        lastSnapshot: lastZoomSnapshotRef.current,
        currentSnapshot,
      });

      // Visual zoom (DPR change or visualViewport pinch scale): update snapshot and refresh visual renderer,
      // but do NOT recalculate/resize PTY columns/rows and do NOT dispatch resize frames to Herdr backend!
      if (decision.isVisualZoom && !force) {
        lastZoomSnapshotRef.current = currentSnapshot;
        try {
          term.refresh(0, Math.max(0, term.rows - 1));
        } catch {
          // ignore
        }
        return;
      }

      if (decision.shouldIgnore && !force) {
        return;
      }

      lastZoomSnapshotRef.current = currentSnapshot;

      // The grid comes from the cell the renderer actually draws, not from an
      // estimate: a grid sized for a different cell either overflows the frame
      // and gets clipped, or leaves a dead strip of background down the side.
      const ptyCell = measureCellDimensions(term, DEFAULT_BASE_FONT_SIZE);
      const fit = computeContainerGridFit({
        width: box.width - measureScrollbarWidth(surface),
        height: box.height,
        cellWidth: ptyCell.cellWidth,
        cellHeight: ptyCell.cellHeight,
      });

      const boxChanged =
        Math.abs(box.width - lastBoxRef.current.width) > 1 ||
        Math.abs(box.height - lastBoxRef.current.height) > 1;

      if (term.cols !== fit.cols || term.rows !== fit.rows) {
        try {
          term.resize(fit.cols, fit.rows);
        } catch (err) {
          console.debug('Error resizing terminal grid:', err);
        }
      }

      if (
        initialBannerWrittenRef.current &&
        !firstResizeVerifiedRef.current &&
        (boxChanged || term.cols !== fit.cols || term.rows !== fit.rows)
      ) {
        firstResizeVerifiedRef.current = true;
        void rendererRef.current?.verify();
      }

      // The very first fits run against the estimate, because the renderer has
      // not measured its font yet. Comparing against what was last announced —
      // rather than only against the box — is what lets the corrected grid
      // reach the host once the real metrics land.
      const gridChanged =
        fit.cols !== lastSentDimensionsRef.current.cols ||
        fit.rows !== lastSentDimensionsRef.current.rows;

      if (isActiveRef.current && (boxChanged || force || gridChanged)) {
        lastBoxRef.current = { width: box.width, height: box.height };
        notifyResize(fit.cols, fit.rows);
      }

      try {
        term.refresh(0, Math.max(0, term.rows - 1));
      } catch {
        // ignore
      }
    },
    [
      termRef,
      containerRef,
      surfaceRef,
      frameRef,
      currentScaleRef,
      rendererRef,
      initialBannerWrittenRef,
      isActiveRef,
      notifyResize,
    ],
  );

  // Listeners capture this ref, never a specific `handleFit` identity
  const handleFitRef = useRef(handleFit);
  handleFitRef.current = handleFit;

  /** Coalesce burst events (resize) into one frame. */
  const requestFit = useCallback(() => {
    if (fitFrameRef.current !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      handleFitRef.current();
      return;
    }
    fitFrameRef.current = requestAnimationFrame(() => {
      fitFrameRef.current = null;
      handleFitRef.current();
    });
  }, []);

  /**
   * Retries across animation frames and applies the fit geometry once.
   * Cancels any pending frame chain to ensure strictly a single RAF chain runs.
   */
  const scheduleBoundedFit = useCallback((maxFrames = 30) => {
    if (boundedFitRafRef.current !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(boundedFitRafRef.current);
      boundedFitRafRef.current = null;
    }

    let frame = 0;
    const step = () => {
      boundedFitRafRef.current = null;
      frame++;
      const exhausted = frame >= maxFrames;

      handleFitRef.current(true);

      if (!exhausted && frame < 2 && typeof requestAnimationFrame === 'function') {
        boundedFitRafRef.current = requestAnimationFrame(step);
      }
    };

    if (typeof requestAnimationFrame === 'function') {
      boundedFitRafRef.current = requestAnimationFrame(step);
    } else {
      step();
    }
  }, []);

  /** Start from the box the terminal was created for. */
  const seedFit = useCallback((box: Box) => {
    lastBoxRef.current = { width: box.width, height: box.height };
    lastZoomSnapshotRef.current = getVisualZoomSnapshot(box);
  }, []);

  /** Drop any resize or fit still waiting, as the terminal goes away. */
  const cancelPendingFits = useCallback(() => {
    if (resizeNotifyTimerRef.current) {
      clearTimeout(resizeNotifyTimerRef.current);
      resizeNotifyTimerRef.current = null;
    }
    if (fitFrameRef.current !== null) {
      cancelAnimationFrame(fitFrameRef.current);
      fitFrameRef.current = null;
    }
    if (boundedFitRafRef.current !== null) {
      cancelAnimationFrame(boundedFitRafRef.current);
      boundedFitRafRef.current = null;
    }
  }, []);

  return { requestFit, scheduleBoundedFit, seedFit, cancelPendingFits };
}
