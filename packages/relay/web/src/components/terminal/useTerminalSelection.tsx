// Touch selection on the terminal: a long press picks the word under the
// finger, dragging extends a rectangle, and lifting the finger opens a menu
// to copy it, the line, the screen, or open the link under it.

import type { Terminal } from '@xterm/xterm';
import type React from 'react';
import { type RefObject, useCallback, useRef, useState } from 'react';
import type { Translate } from '../../i18n';
import { copyText } from '../../utils/clipboard';
import { measureCellDimensions } from '../../utils/terminalFit';
import { linkAtCell } from '../../utils/terminalLinks';
import { pointToCell, screenText, wordRangeAt } from '../../utils/terminalSelection';
import {
  clampRectToBand,
  type PaneColumnBand,
  paneColumnBand,
  rectText,
  type TerminalSelectionRect,
} from '../../utils/paneSelection';
import { useLatest } from './useLatest';

type Point = { clientX: number; clientY: number };

export interface SelectionMenuAnchor {
  x: number;
  y: number;
  link?: string | null;
}

export function useTerminalSelection({
  termRef,
  surfaceRef,
  mainRef,
  currentScaleRef,
  addToast,
  t,
}: {
  termRef: RefObject<Terminal | null>;
  surfaceRef: RefObject<HTMLDivElement | null>;
  mainRef: RefObject<HTMLElement | null>;
  currentScaleRef: RefObject<number>;
  addToast: (type: 'success' | 'error', message: string) => void;
  t: Translate;
}) {
  const addToastRef = useLatest(addToast);
  const tRef = useLatest(t);

  const [selectionMenu, setSelectionMenu] = useState<SelectionMenuAnchor | null>(null);
  const selectionMenuRef = useRef<SelectionMenuAnchor | null>(null);
  selectionMenuRef.current = selectionMenu;

  // Rectangular selection state (closed interval: startCol, endCol, startRow, endRow)
  const [selectionRect, setSelectionRect] = useState<TerminalSelectionRect | null>(null);
  const selectionRectRef = useRef<TerminalSelectionRect | null>(null);
  selectionRectRef.current = selectionRect;

  // Snapshot of extracted text at the moment of selection / extension
  const [selectionSnapshot, setSelectionSnapshot] = useState<string>('');
  const selectionSnapshotRef = useRef<string>('');
  selectionSnapshotRef.current = selectionSnapshot;

  // Visibility of the rectangular selection overlay (invalidated upon intersecting onRender)
  const [isHighlightVisible, setIsHighlightVisible] = useState(false);
  const isHighlightVisibleRef = useRef(false);
  isHighlightVisibleRef.current = isHighlightVisible;
  // Content change flag driven by xterm's onWriteParsed. Prevents internal refresh() calls
  // (e.g. resize, theme switch, visibility change) from falsely wiping out active highlights.
  const contentChangedRef = useRef(false);

  // Active terminal viewport row offset for continuous positioning across scrolls
  const [viewportY, setViewportY] = useState(0);
  const viewportYRef = useRef(0);

  // Gesture coordinate tracking for delayed menu presentation on finger release
  const longPressPointRef = useRef<Point | null>(null);
  const lastExtendPointRef = useRef<Point | null>(null);
  const selectionAnchorRef = useRef<{ col: number; bufferRow: number } | null>(null);
  const selectionBandRef = useRef<PaneColumnBand | null>(null);

  const cellAt = useCallback(
    (point: Point) => {
      const term = termRef.current;
      if (!term) return null;
      const screenEl =
        (surfaceRef.current?.querySelector('.xterm-screen') as HTMLElement | null) ||
        surfaceRef.current;
      return pointToCell(point, term, screenEl, currentScaleRef.current);
    },
    [termRef, surfaceRef, currentScaleRef],
  );

  /**
   * The URL under a touch point, for the long-press menu.
   *
   * A tap is already spoken for — it is forwarded to the pane as a mouse
   * report — so touch reaches a link through the menu instead of through
   * xterm's own link layer.
   */
  const linkAtPoint = useCallback(
    (point: Point): string | null => {
      const term = termRef.current;
      const cellPos = cellAt(point);
      if (!term || !cellPos) return null;
      return linkAtCell(term, cellPos.col, cellPos.bufferRow);
    },
    [termRef, cellAt],
  );

  const showSelection = useCallback((term: Terminal, rect: TerminalSelectionRect) => {
    setSelectionRect(rect);
    setSelectionSnapshot(rectText(term, rect));
    setIsHighlightVisible(true);
  }, []);

  const dropSelection = useCallback(() => {
    setSelectionRect(null);
    setSelectionSnapshot('');
    setIsHighlightVisible(false);
    selectionAnchorRef.current = null;
    selectionBandRef.current = null;
  }, []);

  /** Close the menu and drop the selection, at once for listeners bound earlier too. */
  const clearSelection = useCallback(() => {
    setSelectionMenu(null);
    selectionMenuRef.current = null;
    setSelectionRect(null);
    selectionRectRef.current = null;
    setSelectionSnapshot('');
    selectionSnapshotRef.current = '';
    setIsHighlightVisible(false);
    longPressPointRef.current = null;
    lastExtendPointRef.current = null;
  }, []);

  const handleLongPress = useCallback(
    (point: Point) => {
      const term = termRef.current;
      if (!term) return;
      const cellPos = cellAt(point);
      const range = cellPos ? wordRangeAt(term, cellPos.col, cellPos.bufferRow) : null;
      if (cellPos && range) {
        selectionAnchorRef.current = cellPos;
        const band = paneColumnBand(term, cellPos.col, cellPos.bufferRow);
        selectionBandRef.current = band;
        const rawRect: TerminalSelectionRect = {
          startCol: range.startCol,
          endCol: range.startCol + range.length - 1,
          startRow: cellPos.bufferRow,
          endRow: cellPos.bufferRow,
        };
        showSelection(term, clampRectToBand(rawRect, band));
      } else {
        dropSelection();
      }

      // Record point for menu anchoring on pointerup, but do NOT open menu while finger is held down!
      longPressPointRef.current = point;
      lastExtendPointRef.current = null;
    },
    [termRef, cellAt, showSelection, dropSelection],
  );

  const handleSelectionExtend = useCallback(
    (point: Point) => {
      const term = termRef.current;
      const anchor = selectionAnchorRef.current;
      if (!term || !anchor) return;

      lastExtendPointRef.current = point;
      const currentCell = cellAt(point);
      if (!currentCell) return;

      const band = selectionBandRef.current ?? paneColumnBand(term, anchor.col, anchor.bufferRow);
      const rawRect: TerminalSelectionRect = {
        startCol: Math.min(anchor.col, currentCell.col),
        endCol: Math.max(anchor.col, currentCell.col),
        startRow: Math.min(anchor.bufferRow, currentCell.bufferRow),
        endRow: Math.max(anchor.bufferRow, currentCell.bufferRow),
      };
      showSelection(term, clampRectToBand(rawRect, band));
    },
    [termRef, cellAt, showSelection],
  );

  /** A long press ended: open the menu where the finger last was. */
  const openMenuAtGesture = useCallback(() => {
    const menuPoint = lastExtendPointRef.current ?? longPressPointRef.current;
    if (!menuPoint || !mainRef.current) return;
    const mainRect = mainRef.current.getBoundingClientRect();
    const x = menuPoint.clientX - mainRect.left;
    const y = menuPoint.clientY - mainRect.top;
    const link = linkAtPoint(menuPoint);
    setSelectionMenu({ x, y, link });
    selectionMenuRef.current = { x, y, link };
  }, [mainRef, linkAtPoint]);

  const copyAndReport = useCallback(
    async (text: string) => {
      const result = await copyText(text);
      if (result === 'failed') {
        addToastRef.current('error', tRef.current('clipboard.copyFailed'));
      } else {
        addToastRef.current('success', tRef.current('clipboard.copied'));
      }
    },
    [addToastRef, tRef],
  );

  const handleCopySelection = useCallback(async () => {
    // Copy the snapshot captured at selection time, never re-reading the active buffer
    const text = selectionSnapshotRef.current;
    if (!text) return;
    await copyAndReport(text);
  }, [copyAndReport]);

  const handleCopyLine = useCallback(async () => {
    const term = termRef.current;
    const active = term?.buffer?.active;
    if (!term || !active) return;
    const bufferRow =
      selectionRectRef.current?.startRow ??
      selectionAnchorRef.current?.bufferRow ??
      active.viewportY;
    const band =
      selectionBandRef.current ??
      paneColumnBand(term, selectionAnchorRef.current?.col ?? 0, bufferRow);
    await copyAndReport(
      rectText(term, {
        startCol: band.startCol,
        endCol: band.endCol,
        startRow: bufferRow,
        endRow: bufferRow,
      }),
    );
  }, [termRef, copyAndReport]);

  const handleCopyScreen = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    await copyAndReport(screenText(term));
  }, [termRef, copyAndReport]);

  /** A redraw that changed the rows under the highlight takes the highlight away. */
  const onTerminalRender = useCallback((term: Terminal, start: number, end: number) => {
    const currentViewportY = term.buffer.active.viewportY ?? 0;
    if (currentViewportY !== viewportYRef.current) {
      viewportYRef.current = currentViewportY;
      setViewportY(currentViewportY);
    }
    const currentRect = selectionRectRef.current;
    if (currentRect && isHighlightVisibleRef.current) {
      const selStart = currentRect.startRow - currentViewportY;
      const selEnd = currentRect.endRow - currentViewportY;
      // Invalidate highlight only when incoming stream content actually changed
      // AND the redrawn rows intersect with the active selection rectangle.
      if (contentChangedRef.current && start <= selEnd && end >= selStart) {
        setIsHighlightVisible(false);
        contentChangedRef.current = false;
      }
    } else {
      contentChangedRef.current = false;
    }
  }, []);

  const onTerminalScroll = useCallback((term: Terminal) => {
    const currentViewportY = term.buffer.active.viewportY ?? 0;
    viewportYRef.current = currentViewportY;
    setViewportY(currentViewportY);
  }, []);

  /** New output was parsed: the next redraw over the highlight is a real change. */
  const onTerminalContentChanged = useCallback(() => {
    contentChangedRef.current = true;
  }, []);

  return {
    selectionMenu,
    selectionRect,
    selectionSnapshot,
    isHighlightVisible,
    viewportY,
    hasOpenMenu: () => selectionMenuRef.current !== null,
    clearSelection,
    handleLongPress,
    handleSelectionExtend,
    openMenuAtGesture,
    handleCopySelection,
    handleCopyLine,
    handleCopyScreen,
    onTerminalRender,
    onTerminalScroll,
    onTerminalContentChanged,
  };
}

/** The highlight over the selected rectangle, positioned over the xterm screen. */
export const SelectionOverlay: React.FC<{
  term: Terminal | null;
  surface: HTMLElement | null;
  main: HTMLElement | null;
  rect: TerminalSelectionRect;
  viewportY: number;
}> = ({ term, surface, main, rect, viewportY }) => {
  if (!term || !main) return null;
  const cell = measureCellDimensions(term);
  if (cell.cellWidth <= 0 || cell.cellHeight <= 0) return null;

  const screenEl = (surface?.querySelector('.xterm-screen') as HTMLElement | null) || surface;
  if (!screenEl) return null;
  const screenRect = screenEl.getBoundingClientRect();
  const mainRect = main.getBoundingClientRect();

  const startRowRel = rect.startRow - viewportY;
  const endRowRel = rect.endRow - viewportY;

  // Hide if completely scrolled out of the visible viewport
  if (endRowRel < 0 || startRowRel >= term.rows) return null;

  const top = screenRect.top - mainRect.top + startRowRel * cell.cellHeight;
  const left = screenRect.left - mainRect.left + rect.startCol * cell.cellWidth;
  const width = (rect.endCol - rect.startCol + 1) * cell.cellWidth;
  const height = (rect.endRow - rect.startRow + 1) * cell.cellHeight;

  return (
    <div
      data-testid="terminal-selection-overlay"
      className="pointer-events-none absolute z-20 bg-tui-accent/35"
      style={{
        top: `${top}px`,
        left: `${left}px`,
        width: `${width}px`,
        height: `${height}px`,
      }}
    />
  );
};
