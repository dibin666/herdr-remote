import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { useTerminal } from '../context/TerminalContext';
import { hostPaletteToTheme, resolveTerminalFontFamily } from '../utils/theme';
import { encodeStringToBytes } from '../protocol/keyEncoder';
import { isWheelOnlyInput } from '../protocol/scrollInput';
import { TerminalPointerController, TouchGestureState } from '../utils/touchMouseAdapter';
import { attachTerminalRenderer } from '../utils/terminalRenderer';
import {
  computeContainerGridFit,
  measureCellDimensions,
  measureElementBox,
  measureScrollbarWidth,
  DEFAULT_BASE_FONT_SIZE,
} from '../utils/terminalFit';
import {
  getVisualZoomSnapshot,
  evaluateResizeEvent,
  VisualZoomSnapshot,
} from '../utils/visualZoom';
import {
  getEffectiveTerminalFontSize,
  getViewportWidth,
  getViewportHeight,
  isCoarsePointerDevice,
  MOBILE_BREAKPOINT_PX,
} from '../utils/terminalLayout';
import {
  pointToCell,
  wordRangeAt,
  screenText,
  paneColumnBand,
  clampRectToBand,
  rectText,
  TerminalSelectionRect,
  PaneColumnBand,
} from '../utils/terminalSelection';
import { copyText, readClipboardText, readClipboardImage, extractImageFromClipboardEvent } from '../utils/clipboard';
import { compressAndPrepareImage, PreparedImagePaste } from '../utils/imagePaste';
import { TerminalSelectionMenu } from './TerminalSelectionMenu';
import { PasteFallbackModal } from './PasteFallbackModal';

export { MOBILE_BREAKPOINT_PX };

/**
 * Resize notifications to the PTY are coalesced over this window. The mobile
 * keyboard animation drives visualViewport through dozens of intermediate
 * heights; without this the host would receive a stream of throwaway grids.
 */
export const RESIZE_NOTIFY_DEBOUNCE_MS = 250;

interface TerminalViewProps {
  onTerminalFocus?: () => void;
  /**
   * False while another view (e.g. Admin) is on top. The terminal stays mounted
   * and measurable — only PTY resize notifications and focus are suppressed —
   * so no xterm state, buffer or WebSocket session is torn down.
   */
  isActive?: boolean;
}

interface TouchDebugState {
  state: TouchGestureState;
  deltaY: number;
  lines: number;
  viewportY: number | null;
  scrollTop: number | null;
  scrollHeight: number | null;
  clientHeight: number | null;
  moved: boolean;
  focused: boolean;
  bufferType: 'normal' | 'alternate' | null;
  baseY: number | null;
  cursorY: number | null;
  hasScrollback: boolean | null;
  mouseTracking: boolean;
  scrollMode: 'buffer' | 'application-mouse' | 'application-keys' | 'none';
  scrollCalls: number;
  lastScrollLines: number | null;
  lastInputEvent: string;
  pointerEvents: number;
  touchEvents: number;
}

export const TerminalView: React.FC<TerminalViewProps> = ({
  onTerminalFocus,
  isActive = true,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  /**
   * The surface is never transformed, so this stays 1. It exists because the
   * pointer layer routes every coordinate through the same inverse transform,
   * and that has to keep working if a scale is ever reintroduced.
   */
  const currentScaleRef = useRef<number>(1.0);
  const lastSentDimensionsRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeNotifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fitFrameRef = useRef<number | null>(null);
  const boundedFitRafRef = useRef<number | null>(null);
  const lastBoxRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  const lastZoomSnapshotRef = useRef<VisualZoomSnapshot | null>(null);
  const isTouchDevice = isCoarsePointerDevice();
  const touchInputCapable =
    isTouchDevice ||
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) ||
    (typeof window !== 'undefined' && 'ontouchstart' in window);
  const touchDebugEnabled =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('debug') === '1';
  const [touchDebug, setTouchDebug] = useState<TouchDebugState>({
    state: 'idle',
    deltaY: 0,
    lines: 0,
    viewportY: null,
    scrollTop: null,
    scrollHeight: null,
    clientHeight: null,
    moved: false,
    focused: false,
    bufferType: null,
    baseY: null,
    cursorY: null,
    hasScrollback: null,
    mouseTracking: false,
    scrollMode: 'none',
    scrollCalls: 0,
    lastScrollLines: null,
    lastInputEvent: '',
    pointerEvents: 0,
    touchEvents: 0,
  });

  const {
    isController,
    connectionState,
    settings,
    hostPalette,
    terminalResetVersion,
    sendResize,
    sendBinary,
    addToast,
    warnViewerMode,
    connect,
    subscribeToOutput,
    sendPasteFile,
    subscribeToPasteFileReady,
    t,
  } = useTerminal();

  /**
   * The host's own terminal colors, in xterm's theme shape. Not a theme this
   * client chose: it is what the workstation's emulator answered to the OSC
   * color queries. Without it xterm keeps its defaults rather than inventing
   * a palette here.
   */
  const hostTheme = React.useMemo(() => hostPaletteToTheme(hostPalette), [hostPalette]);
  const hostThemeRef = useRef(hostTheme);
  hostThemeRef.current = hostTheme;

  // Fresh mutable refs to avoid stale React closure bugs in event listeners
  const isControllerRef = useRef(isController);
  isControllerRef.current = isController;

  const sendBinaryRef = useRef(sendBinary);
  sendBinaryRef.current = sendBinary;

  const addToastRef = useRef(addToast);
  addToastRef.current = addToast;

  const warnViewerModeRef = useRef(warnViewerMode);
  warnViewerModeRef.current = warnViewerMode;

  const sendResizeRef = useRef(sendResize);
  sendResizeRef.current = sendResize;
  const sendPasteFileRef = useRef(sendPasteFile);
  sendPasteFileRef.current = sendPasteFile;

  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  const tRef = useRef(t);
  tRef.current = t;

  const mainRef = useRef<HTMLElement | null>(null);
  const [selectionMenu, setSelectionMenu] = useState<{ x: number; y: number } | null>(null);
  const selectionMenuRef = useRef<{ x: number; y: number } | null>(null);
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

  // Gesture coordinate tracking for delayed menu presentation on finger release
  const longPressPointRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const lastExtendPointRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const selectionAnchorRef = useRef<{ col: number; bufferRow: number } | null>(null);
  const selectionBandRef = useRef<PaneColumnBand | null>(null);

  const [isPasteFallbackOpen, setIsPasteFallbackOpen] = useState(false);

  const handleLongPress = useCallback((point: { clientX: number; clientY: number }) => {
    const term = termRef.current;
    if (!term) return;

    const screenEl = (surfaceRef.current?.querySelector('.xterm-screen') as HTMLElement | null) || surfaceRef.current;
    const cellPos = pointToCell(point, term, screenEl, currentScaleRef.current);

    if (cellPos) {
      selectionAnchorRef.current = cellPos;
      const band = paneColumnBand(term, cellPos.col, cellPos.bufferRow);
      selectionBandRef.current = band;

      const range = wordRangeAt(term, cellPos.col, cellPos.bufferRow);
      if (range) {
        const rawRect: TerminalSelectionRect = {
          startCol: range.startCol,
          endCol: range.startCol + range.length - 1,
          startRow: cellPos.bufferRow,
          endRow: cellPos.bufferRow,
        };
        const clamped = clampRectToBand(rawRect, band);
        const snapshot = rectText(term, clamped);
        setSelectionRect(clamped);
        setSelectionSnapshot(snapshot);
        setIsHighlightVisible(true);
      } else {
        setSelectionRect(null);
        setSelectionSnapshot('');
        setIsHighlightVisible(false);
        selectionAnchorRef.current = null;
        selectionBandRef.current = null;
      }
    } else {
      setSelectionRect(null);
      setSelectionSnapshot('');
      setIsHighlightVisible(false);
      selectionAnchorRef.current = null;
      selectionBandRef.current = null;
    }

    // Record point for menu anchoring on pointerup, but do NOT open menu while finger is held down!
    longPressPointRef.current = point;
    lastExtendPointRef.current = null;
  }, []);

  const handleSelectionExtend = useCallback((point: { clientX: number; clientY: number }) => {
    const term = termRef.current;
    const anchor = selectionAnchorRef.current;
    if (!term || !anchor) return;

    lastExtendPointRef.current = point;

    const screenEl = (surfaceRef.current?.querySelector('.xterm-screen') as HTMLElement | null) || surfaceRef.current;
    const currentCell = pointToCell(point, term, screenEl, currentScaleRef.current);
    if (!currentCell) return;

    const band = selectionBandRef.current ?? paneColumnBand(term, anchor.col, anchor.bufferRow);
    const rawRect: TerminalSelectionRect = {
      startCol: Math.min(anchor.col, currentCell.col),
      endCol: Math.max(anchor.col, currentCell.col),
      startRow: Math.min(anchor.bufferRow, currentCell.bufferRow),
      endRow: Math.max(anchor.bufferRow, currentCell.bufferRow),
    };
    const clamped = clampRectToBand(rawRect, band);
    const snapshot = rectText(term, clamped);
    setSelectionRect(clamped);
    setSelectionSnapshot(snapshot);
    setIsHighlightVisible(true);
  }, []);

  const handleLongPressRef = useRef(handleLongPress);
  handleLongPressRef.current = handleLongPress;
  const handleSelectionExtendRef = useRef(handleSelectionExtend);
  handleSelectionExtendRef.current = handleSelectionExtend;

  const handleCopySelection = useCallback(async () => {
    // Copy the snapshot captured at selection time, never re-reading the active buffer
    const text = selectionSnapshotRef.current;
    if (!text) return;
    const result = await copyText(text);
    if (result === 'failed') {
      addToastRef.current('error', tRef.current('clipboard.copyFailed'));
    } else {
      addToastRef.current('success', tRef.current('clipboard.copied'));
    }
  }, []);

  const handleCopyLine = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    const active = term.buffer?.active;
    if (!active) return;
    const bufferRow =
      selectionRectRef.current?.startRow ?? selectionAnchorRef.current?.bufferRow ?? active.viewportY;
    const band =
      selectionBandRef.current ??
      paneColumnBand(term, selectionAnchorRef.current?.col ?? 0, bufferRow);
    const lineRect: TerminalSelectionRect = {
      startCol: band.startCol,
      endCol: band.endCol,
      startRow: bufferRow,
      endRow: bufferRow,
    };
    const text = rectText(term, lineRect);
    const result = await copyText(text);
    if (result === 'failed') {
      addToastRef.current('error', tRef.current('clipboard.copyFailed'));
    } else {
      addToastRef.current('success', tRef.current('clipboard.copied'));
    }
  }, []);

  const handleCopyScreen = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    const text = screenText(term);
    const result = await copyText(text);
    if (result === 'failed') {
      addToastRef.current('error', tRef.current('clipboard.copyFailed'));
    } else {
      addToastRef.current('success', tRef.current('clipboard.copied'));
    }
  }, []);

  const handlePaste = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    if (!isControllerRef.current) {
      warnViewerModeRef.current();
      return;
    }
    // 1. Best-effort probe clipboard for images (HTTPS or localhost)
    try {
      const imageResult = await readClipboardImage();
      if (imageResult.ok) {
        const prepared = await compressAndPrepareImage(imageResult.blob);
        if (!prepared) {
          addToastRef.current('error', tRef.current('clipboard.imageTooLarge'));
          return;
        }
        sendPasteFileRef.current(prepared.mime, prepared.dataBase64);
        return;
      }
    } catch {
      // Best-effort image probe; do not throw or toast on denial/insecure
    }

    // 2. Best-effort probe clipboard for plain text
    try {
      const result = await readClipboardText();
      if (result.ok) {
        term.paste(result.text);
        addToastRef.current('success', tRef.current('clipboard.pasted'));
        return;
      } else if (result.reason === 'empty') {
        addToastRef.current('info', tRef.current('clipboard.pasteUnavailable'));
        return;
      }
    } catch {
      // Fall through to manual modal
    }

    // 3. Fallback modal: Reliable universal interface for text and image entry
    setIsPasteFallbackOpen(true);
  }, []);

  const handleFallbackPasteSend = useCallback((text: string) => {
    const term = termRef.current;
    if (!term) return;
    if (!isControllerRef.current) {
      warnViewerModeRef.current();
      return;
    }
    term.paste(text);
    addToastRef.current('success', tRef.current('clipboard.pasted'));
  }, []);

  const handleFallbackImageSend = useCallback((image: PreparedImagePaste) => {
    const term = termRef.current;
    if (!term) return;
    if (!isControllerRef.current) {
      warnViewerModeRef.current();
      return;
    }
    sendPasteFileRef.current(image.mime, image.dataBase64);
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeToPasteFileReady((path) => {
      const term = termRef.current;
      if (term) {
        term.paste(path);
        addToastRef.current('success', tRef.current('clipboard.pasted'));
      }
    });
    return unsubscribe;
  }, [subscribeToPasteFileReady]);


  /** Debounced, change-gated PTY resize notification. */
  const notifyResize = useCallback((cols: number, rows: number) => {
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
    }, RESIZE_NOTIFY_DEBOUNCE_MS);
  }, []);

  /**
   * visual-only vs PTY geometry:
   * - The PTY grid (cols x rows) is strictly governed by the physical container dimensions
   *   (window/layout viewport) and a stable baseline geometry (DEFAULT_BASE_FONT_SIZE = 13).
   * - Changing local font size / font family / theme in settings is a purely visual renderer adjustment:
   *   it updates xterm options and refreshes the canvas/DOM without recalculating PTY columns/rows
   *   or dispatching PTY resize frames.
   */
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
    [notifyResize]
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

  // Initialize Terminal instance
  useEffect(() => {
    if (!containerRef.current || !surfaceRef.current) return;

    const container = containerRef.current;
    const initialBox = measureElementBox(container, getViewportWidth(), getViewportHeight());

    // PTY geometry baseline is fixed and independent of client-local fontSize
    const ptyCell = measureCellDimensions(null, DEFAULT_BASE_FONT_SIZE);
    const initialGrid = computeContainerGridFit({
      width: initialBox.width,
      height: initialBox.height,
      cellWidth: ptyCell.cellWidth,
      cellHeight: ptyCell.cellHeight,
    });

    // Seed the session dimensions before the auto-connect effect below runs
    sendResizeRef.current(initialGrid.cols, initialGrid.rows);
    lastBoxRef.current = { width: initialBox.width, height: initialBox.height };
    lastZoomSnapshotRef.current = getVisualZoomSnapshot(initialBox);

    const initialVisualFontSize = getEffectiveTerminalFontSize(settings.fontSize, initialBox.width);

    // The only palette in play is the host's, when the host could report one.
    // There is no client theme and no `minimumContrastRatio`, so every SGR/OSC
    // color the Herdr host emits reaches the screen unaltered.
    const term = new Terminal({
      fontSize: initialVisualFontSize,
      fontFamily: resolveTerminalFontFamily(settings.fontFamily),
      lineHeight: 1.15,
      ...(hostThemeRef.current ? { theme: { ...hostThemeRef.current } } : {}),
      allowProposedApi: true,
      convertEol: true,
      scrollback: 5000,
      // `drawBoldTextInBrightColors` is deliberately not set: forcing it would
      // be this client recoloring the host's bold text. xterm's own default
      // stands, which is what the mainstream host emulators do as well.
      cols: initialGrid.cols,
      rows: initialGrid.rows,
      screenReaderMode: false,
    });

    try {
      const unicode11Addon = new Unicode11Addon();
      term.loadAddon(unicode11Addon);
      term.unicode.activeVersion = '11';
    } catch (e) {
      console.debug('Unicode11 addon unavailable, using default width table:', e);
    }

    // Open xterm in the surface element
    term.open(surfaceRef.current);
    termRef.current = term;

    // The xterm helper is the real terminal input on touch devices. Make its
    // mobile keyboard intent explicit; it is focused only after the gesture
    // controller has classified a terminal touch as a tap.
    if (isTouchDevice && term.textarea) {
      term.textarea.readOnly = false;
      term.textarea.tabIndex = 0;
      term.textarea.inputMode = 'text';
    }

    let removeTouchDebugFocusListeners = () => {};
    if (touchDebugEnabled && term.textarea) {
      const syncFocusState = () => {
        setTouchDebug((previous) => ({
          ...previous,
          focused: document.activeElement === term.textarea,
        }));
      };
      term.textarea.addEventListener('focus', syncFocusState);
      term.textarea.addEventListener('blur', syncFocusState);
      removeTouchDebugFocusListeners = () => {
        term.textarea?.removeEventListener('focus', syncFocusState);
        term.textarea?.removeEventListener('blur', syncFocusState);
      };
      syncFocusState();
    }
    const handleNativePaste = async (e: ClipboardEvent) => {
      const imageBlob = extractImageFromClipboardEvent(e);
      if (imageBlob) {
        e.preventDefault();
        e.stopPropagation();
        if (!isControllerRef.current) {
          warnViewerModeRef.current();
          return;
        }
        const prepared = await compressAndPrepareImage(imageBlob);
        if (!prepared) {
          addToastRef.current('error', tRef.current('clipboard.imageTooLarge'));
          return;
        }
        sendPasteFileRef.current(prepared.mime, prepared.dataBase64);
      }
    };
    term.textarea?.addEventListener('paste', handleNativePaste);
    container.addEventListener('paste', handleNativePaste);

    const renderer = attachTerminalRenderer(term, {
      coarsePointer: isTouchDevice,
      onRendererSwapped: () => {
        try {
          term.refresh(0, Math.max(0, term.rows - 1));
        } catch {
          // ignore
        }
      },
    });
    if (container) {
      container.dataset.renderer = renderer.kind;
    }

    // Initial banner text
    const bannerTitle = tRef.current('terminal.bannerTitle');
    const bannerSubtitle = tRef.current('terminal.bannerSubtitle');
    term.writeln('  ___ ___               .___      ');
    term.writeln(` /   |   \\  ____ _______| _/______   \x1b[1m${bannerTitle}\x1b[0m`);
    term.writeln(`/    ~    \\/ __ \\\\_  __ \\ __/  ___/   \x1b[2m${bannerSubtitle}\x1b[0m`);
    term.writeln('\\    Y    /  ___/ |  | \\/|_ \\___ \\ ');
    term.writeln(' \\___|_  / \\___  >|__|  /___/____  >');
    term.writeln('       \\/      \\/                \\/ ');
    term.writeln('');

    if (!isTouchDevice) {
      try {
        term.focus();
      } catch {
        // ignore
      }
    }

    // Refresh terminal once webfont is loaded so Nerd Font glyphs render immediately
    if (typeof document !== 'undefined' && 'fonts' in document && typeof (document.fonts as any)?.load === 'function') {
      (document.fonts as any).load('13px "Symbols Nerd Font Mono"').then(() => {
        if (!termRef.current) return;
        try {
          termRef.current.refresh(0, Math.max(0, termRef.current.rows - 1));
        } catch {
          // ignore
        }
        scheduleBoundedFit(5);
      }).catch(() => {
        // ignore
      });
    }
    // Handle user keyboard & mouse reporting input from xterm
    const dataDispose = term.onData((data) => {
      const bytes = encodeStringToBytes(data);
      // Scrolling a viewer's own stream is allowed; typing into the shared
      // session is not. Without this split every wheel notch raised a
      // read-only warning, which buried the terminal under toasts.
      if (!isControllerRef.current && !isWheelOnlyInput(bytes)) {
        warnViewerModeRef.current();
        return;
      }
      sendBinaryRef.current(bytes);
    });

    const binaryDispose = term.onBinary((data) => {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) {
        bytes[i] = data.charCodeAt(i) & 255;
      }
      if (!isControllerRef.current && !isWheelOnlyInput(bytes)) return;
      sendBinaryRef.current(bytes);
    });

    // Track terminal render updates and scroll events to invalidate highlight on redraw
    // while keeping viewportY in sync across buffer scrolling.
    const writeParsedDispose =
      typeof term.onWriteParsed === 'function'
        ? term.onWriteParsed(() => {
            contentChangedRef.current = true;
          })
        : { dispose: () => {} };

    const renderDispose =
      typeof term.onRender === 'function'
        ? term.onRender((e: { start: number; end: number }) => {
            const currentViewportY = term.buffer.active.viewportY ?? 0;
            setViewportY(currentViewportY);

            const currentRect = selectionRectRef.current;
            if (currentRect && isHighlightVisibleRef.current) {
              const selStart = currentRect.startRow - currentViewportY;
              const selEnd = currentRect.endRow - currentViewportY;
              // Invalidate highlight only when incoming stream content actually changed
              // AND the redrawn rows intersect with the active selection rectangle.
              if (contentChangedRef.current && e.start <= selEnd && e.end >= selStart) {
                setIsHighlightVisible(false);
                contentChangedRef.current = false;
              }
            } else {
              contentChangedRef.current = false;
            }
          })
        : { dispose: () => {} };

    const scrollDispose =
      typeof term.onScroll === 'function'
        ? term.onScroll(() => {
            const currentViewportY = term.buffer.active.viewportY ?? 0;
            setViewportY(currentViewportY);
          })
        : { dispose: () => {} };

    const pointerController = new TerminalPointerController({
      getTerminal: () => termRef.current,
      getIsController: () => isControllerRef.current,
      getScale: () => currentScaleRef.current,
      getSurfaceElement: () => surfaceRef.current,
      // Never synthesize DOM mousedown events from this controller. xterm's
      // native mousedown handler focuses its hidden textarea for every row;
      // the core mouse service reports terminal clicks without opening the
      // IME before the gesture has been classified. Keeping this disabled for
      // the lifetime of the mounted terminal also covers a desktop-to-phone
      // rotation without rebuilding the xterm instance.
      allowSyntheticMouseFallback: false,
      onFocus: () => {
        // A tap is the explicit terminal-input gesture. Vertical drags never
        // reach this callback, so scrolling history cannot summon the IME.
        try {
          term.focus();
        } catch {
          // ignore
        }
        if (touchDebugEnabled) {
          setTouchDebug((previous) => ({
            ...previous,
            focused: document.activeElement === term.textarea,
          }));
        }
        onTerminalFocus?.();
      },
      onGestureStateChange: (state) => {
        if (!touchDebugEnabled) return;
        setTouchDebug((previous) => ({ ...previous, state }));
      },
      onGestureScroll: ({
        deltaY,
        lines,
        viewportY,
        scrollTop,
        scrollHeight,
        clientHeight,
        moved,
        bufferType,
        baseY,
        cursorY,
        hasScrollback,
        mouseTracking,
        scrollMode,
      }) => {
        if (!touchDebugEnabled) return;
        setTouchDebug((previous) => ({
          ...previous,
          deltaY,
          lines,
          viewportY,
          scrollTop,
          scrollHeight,
          clientHeight,
          moved,
          focused: document.activeElement === term.textarea,
          bufferType,
          baseY,
          cursorY,
          hasScrollback,
          mouseTracking,
          scrollMode,
          scrollCalls: previous.scrollCalls + (lines !== 0 ? 1 : 0),
          lastScrollLines: lines,
        }));
      },
      longPressDelayMs: 500,
      dragThresholdPx: 8,
      scrollLineHeightPx: 18,
      onLongPress: isTouchDevice ? ((p) => handleLongPressRef.current?.(p)) : undefined,
      onSelectionExtend: isTouchDevice ? ((p) => handleSelectionExtendRef.current?.(p)) : undefined,
    });

    // The gesture is driven from PointerEvent wherever it exists. Measured on
    // Android Chrome, one drag delivers a full-rate pointermove stream but only
    // a single touchmove, so a touch-driven scroll threw most of the finger
    // movement away and crawled. TouchEvent remains the fallback for engines
    // with no PointerEvent at all.
    const usePointerEvents = typeof window !== 'undefined' && 'PointerEvent' in window;
    const hasTouchEvents = typeof TouchEvent !== 'undefined';
    const detachInput: Array<() => void> = [];
    const eventIsInTerminal = (event: Event, allowActiveOutside = false): boolean => {
      const target = event.target;
      const inside = target instanceof Node && container.contains(target);
      return inside || (allowActiveOutside && pointerController.getState() !== 'idle');
    };

    if (usePointerEvents) {
      const pointerListenerOptions = { passive: false, capture: true } as const;
      const markPointerEvent = (name: string) => {
        if (touchDebugEnabled) {
          setTouchDebug((previous) => ({
            ...previous,
            pointerEvents: previous.pointerEvents + 1,
            lastInputEvent: name,
          }));
        }
      };
      const onPointerDown = (e: PointerEvent) => {
        if (!eventIsInTerminal(e)) return;
        markPointerEvent('pointerdown');
        if (selectionMenuRef.current) {
          setSelectionMenu(null);
          selectionMenuRef.current = null;
          setSelectionRect(null);
          selectionRectRef.current = null;
          setSelectionSnapshot('');
          selectionSnapshotRef.current = '';
          setIsHighlightVisible(false);
          longPressPointRef.current = null;
          lastExtendPointRef.current = null;
          if (e.cancelable) e.preventDefault();
          e.stopPropagation();
          return;
        }
        const handled = pointerController.handlePointerDown(e, container);
        if (handled) e.stopPropagation();
      };
      const onPointerMove = (e: PointerEvent) => {
        if (!eventIsInTerminal(e, true)) return;
        markPointerEvent('pointermove');
        pointerController.handlePointerMove(e);
        if (e.pointerType !== 'mouse') e.stopPropagation();
      };
      const onPointerUp = (e: PointerEvent) => {
        if (!eventIsInTerminal(e, true)) return;
        markPointerEvent('pointerup');

        // CRITICAL: Inspect longpress state BEFORE calling handlePointerUp(e).
        // Calling handlePointerUp resets controller state to 'idle'.
        const wasLongPress = pointerController.getState() === 'longpress';
        if (wasLongPress && mainRef.current) {
          const menuPoint = lastExtendPointRef.current ?? longPressPointRef.current;
          if (menuPoint) {
            const mainRect = mainRef.current.getBoundingClientRect();
            const x = menuPoint.clientX - mainRect.left;
            const y = menuPoint.clientY - mainRect.top;
            setSelectionMenu({ x, y });
            selectionMenuRef.current = { x, y };
          }
        }

        pointerController.handlePointerUp(e);
        if (e.pointerType !== 'mouse') e.stopPropagation();
      };
      const onPointerCancel = (e: PointerEvent) => {
        if (!eventIsInTerminal(e, true)) return;
        markPointerEvent('pointercancel');

        // Interrupted gesture: clear menu, selection and highlight without opening menu
        setSelectionMenu(null);
        selectionMenuRef.current = null;
        setSelectionRect(null);
        selectionRectRef.current = null;
        setSelectionSnapshot('');
        selectionSnapshotRef.current = '';
        setIsHighlightVisible(false);
        longPressPointRef.current = null;
        lastExtendPointRef.current = null;

        pointerController.handlePointerCancel(e);
        if (e.pointerType !== 'mouse') e.stopPropagation();
      };

      document.addEventListener('pointerdown', onPointerDown, pointerListenerOptions);
      document.addEventListener('pointermove', onPointerMove, pointerListenerOptions);
      document.addEventListener('pointerup', onPointerUp, pointerListenerOptions);
      document.addEventListener('pointercancel', onPointerCancel, pointerListenerOptions);
      detachInput.push(() => {
        document.removeEventListener('pointerdown', onPointerDown, pointerListenerOptions);
        document.removeEventListener('pointermove', onPointerMove, pointerListenerOptions);
        document.removeEventListener('pointerup', onPointerUp, pointerListenerOptions);
        document.removeEventListener('pointercancel', onPointerCancel, pointerListenerOptions);
      });

      if (hasTouchEvents) {
        // The pointer stream owns the gesture, but the parallel touch stream
        // still reaches xterm, whose own touchstart/touchmove handlers scroll
        // the nested viewport and whose synthesized click focuses the hidden
        // textarea. Consume that stream here so only one thing moves the
        // terminal and a history swipe cannot summon the IME.
        const suppressNativeTouch = (e: TouchEvent) => {
          if (!eventIsInTerminal(e, true)) return;
          if (touchDebugEnabled) {
            setTouchDebug((previous) => ({
              ...previous,
              touchEvents: previous.touchEvents + 1,
            }));
          }
          if (e.cancelable) e.preventDefault();
          e.stopPropagation();
        };
        const suppressedTouchEvents = [
          'touchstart',
          'touchmove',
          'touchend',
          'touchcancel',
        ] as const;
        for (const name of suppressedTouchEvents) {
          document.addEventListener(name, suppressNativeTouch, pointerListenerOptions);
        }
        detachInput.push(() => {
          for (const name of suppressedTouchEvents) {
            document.removeEventListener(name, suppressNativeTouch, pointerListenerOptions);
          }
        });
      }
    } else {
      const touchListenerOptions = { passive: false, capture: true } as const;
      const markTouchEvent = (name: string) => {
        if (touchDebugEnabled) {
          setTouchDebug((previous) => ({
            ...previous,
            touchEvents: previous.touchEvents + 1,
            lastInputEvent: name,
          }));
        }
      };
      const onTouchStart = (e: TouchEvent) => {
        if (!eventIsInTerminal(e)) return;
        markTouchEvent('touchstart');
        if (selectionMenuRef.current) {
          setSelectionMenu(null);
          selectionMenuRef.current = null;
          setSelectionRect(null);
          selectionRectRef.current = null;
          setSelectionSnapshot('');
          selectionSnapshotRef.current = '';
          setIsHighlightVisible(false);
          longPressPointRef.current = null;
          lastExtendPointRef.current = null;
          if (e.cancelable) e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (e.touches.length === 1) e.stopPropagation();
        pointerController.handleTouchStart(e, container);
      };
      const onTouchMove = (e: TouchEvent) => {
        if (!eventIsInTerminal(e, true)) return;
        markTouchEvent('touchmove');
        if (e.touches.length === 1) e.stopPropagation();
        pointerController.handleTouchMove(e);
      };
      const onTouchEnd = (e: TouchEvent) => {
        if (!eventIsInTerminal(e, true)) return;
        markTouchEvent('touchend');

        // CRITICAL: Determine whether this gesture was a longpress BEFORE pointerController.handleTouchEnd(e).
        const wasLongPress = pointerController.getState() === 'longpress';
        if (wasLongPress && mainRef.current) {
          const menuPoint = lastExtendPointRef.current ?? longPressPointRef.current;
          if (menuPoint) {
            const mainRect = mainRef.current.getBoundingClientRect();
            const x = menuPoint.clientX - mainRect.left;
            const y = menuPoint.clientY - mainRect.top;
            setSelectionMenu({ x, y });
            selectionMenuRef.current = { x, y };
          }
        }

        e.stopPropagation();
        pointerController.handleTouchEnd(e);
      };
      const onTouchCancel = (e: TouchEvent) => {
        if (!eventIsInTerminal(e, true)) return;
        markTouchEvent('touchcancel');

        // Cancellation: clear menu, selection and highlight without opening menu
        setSelectionMenu(null);
        selectionMenuRef.current = null;
        setSelectionRect(null);
        selectionRectRef.current = null;
        setSelectionSnapshot('');
        selectionSnapshotRef.current = '';
        setIsHighlightVisible(false);
        longPressPointRef.current = null;
        lastExtendPointRef.current = null;

        e.stopPropagation();
        pointerController.handleTouchCancel();
      };

      document.addEventListener('touchstart', onTouchStart, touchListenerOptions);
      document.addEventListener('touchmove', onTouchMove, touchListenerOptions);
      document.addEventListener('touchend', onTouchEnd, touchListenerOptions);
      document.addEventListener('touchcancel', onTouchCancel, touchListenerOptions);
      detachInput.push(() => {
        document.removeEventListener('touchstart', onTouchStart, touchListenerOptions);
        document.removeEventListener('touchmove', onTouchMove, touchListenerOptions);
        document.removeEventListener('touchend', onTouchEnd, touchListenerOptions);
        document.removeEventListener('touchcancel', onTouchCancel, touchListenerOptions);
      });
    }

    // Right-click belongs to whatever is running in the terminal: Herdr draws
    // its own menu when it receives the button-2 report, so xterm's mouse
    // tracking is left to forward it. Only the browser's own menu is
    // suppressed, and preventDefault on `contextmenu` alone does that without
    // touching the button press xterm reports from.
    const onContextMenuNative = (e: MouseEvent) => {
      e.preventDefault();
    };

    container.addEventListener('contextmenu', onContextMenuNative);
    detachInput.push(() => {
      container.removeEventListener('contextmenu', onContextMenuNative);
    });

    // Resize observer on terminal container — this is the valid source of container physical size changes
    const resizeObserver = new ResizeObserver(() => {
      requestFit();
    });
    resizeObserver.observe(container);

    const handleWindowResize = () => {
      requestFit();
    };

    // Page visibility change recovery: re-measure and repaint after backgrounding
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        scheduleBoundedFit(10);
        try {
          termRef.current?.refresh(0, Math.max(0, (termRef.current?.rows || 1) - 1));
        } catch {
          // ignore
        }
      }
    };

    window.addEventListener('resize', handleWindowResize);
    window.addEventListener('orientationchange', handleWindowResize);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pageshow', handleVisibilityChange);

    // Visual viewport pinch scale / zoom listener for renderer refresh
    const handleVisualViewport = () => {
      requestFit();
    };
    if (typeof window !== 'undefined' && window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleVisualViewport);
      window.visualViewport.addEventListener('scroll', handleVisualViewport);
    }

    return () => {
      dataDispose.dispose();
      binaryDispose.dispose();
      renderDispose.dispose();
      scrollDispose.dispose();
      writeParsedDispose.dispose();
      pointerController.handlePointerCancel();
      for (const detach of detachInput) detach();
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleWindowResize);
      window.removeEventListener('orientationchange', handleWindowResize);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handleVisibilityChange);
      if (typeof window !== 'undefined' && window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleVisualViewport);
        window.visualViewport.removeEventListener('scroll', handleVisualViewport);
      }
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
      removeTouchDebugFocusListeners();
      term.textarea?.removeEventListener('paste', handleNativePaste);
      container.removeEventListener('paste', handleNativePaste);
      renderer.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, []); // Run once on mount

  // Sync visual-only settings changes (fontSize, fontFamily) with the live terminal
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const box = measureElementBox(containerRef.current, getViewportWidth(), getViewportHeight());
    term.options.fontSize = getEffectiveTerminalFontSize(settings.fontSize, box.width);
    term.options.fontFamily = resolveTerminalFontFamily(settings.fontFamily);

    try {
      term.refresh(0, Math.max(0, term.rows - 1));
    } catch {
      // ignore
    }

    // A different font means a different cell, and the grid is measured from
    // the cell. Refitting keeps the terminal full-bleed after a zoom instead of
    // leaving the frame half-painted; the renderer needs a frame to re-measure,
    // which is what the bounded chain waits for.
    scheduleBoundedFit(10);
  }, [settings.fontSize, settings.fontFamily]);

  // Switching profiles or rebuilding a PTY must never append new output to the
  // previous host's screen. Keep the xterm instance mounted for layout
  // stability, but explicitly reset its buffer at the generation boundary.
  const appliedResetVersionRef = useRef(terminalResetVersion);
  useEffect(() => {
    if (appliedResetVersionRef.current === terminalResetVersion) return;
    appliedResetVersionRef.current = terminalResetVersion;
    const term = termRef.current as (Terminal & { reset?: () => void }) | null;
    if (!term) return;
    try {
      term.reset?.();
      term.clear();
      term.refresh(0, Math.max(0, term.rows - 1));
    } catch {
      // ignore
    }
  }, [terminalResetVersion]);

  // The palette arrives with `ready`, which can land after xterm is open.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !hostTheme) return;
    term.options.theme = { ...hostTheme };
    try {
      term.refresh(0, Math.max(0, term.rows - 1));
    } catch {
      // ignore
    }
  }, [hostTheme]);

  /**
   * Attach the live terminal as the raw output sink.
   */
  useEffect(() => {
    const unsubscribe = subscribeToOutput((data: Uint8Array) => {
      const term = termRef.current;
      if (!term) {
        throw new Error('terminal not ready');
      }
      term.write(data);
    });

    return unsubscribe;
  }, [subscribeToOutput]);

  /**
   * Restore path when the view becomes active again (e.g. back from Admin).
   */
  useEffect(() => {
    if (!isActive) return;

    scheduleBoundedFit(10);

    const term = termRef.current;
    if (term) {
      try {
        term.refresh(0, Math.max(0, term.rows - 1));
      } catch {
        // ignore
      }

      if (!isTouchDevice) {
        try {
          term.focus();
        } catch {
          // ignore
        }
      }
    }
  }, [isActive, isTouchDevice, scheduleBoundedFit]);

  // Auto-connect on mount if disconnected
  useEffect(() => {
    if (connectionState === 'disconnected') {
      connect();
    }
  }, []);

  /**
   * The browser's own menu is all that is suppressed here. The right-click
   * itself stays with xterm, which reports it to Herdr — that report is what
   * makes Herdr's own menu appear, at the cell the user actually clicked.
   */
  const suppressBrowserMenu = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  return (
    <main
      ref={mainRef}
      className="flex-1 w-full min-w-0 min-h-0 overflow-hidden relative flex flex-col"
      onContextMenu={suppressBrowserMenu}
      aria-label={t('terminal.windowAriaLabel')}
    >
      <div
        id="terminal-container"
        ref={containerRef}
        className="absolute inset-0 overflow-hidden cursor-text"
        style={{
          // The controller owns mobile scrolling so Android cannot leave the
          // nested absolute xterm viewport at a fixed scroll position.
          touchAction: touchInputCapable ? 'none' : 'auto',
        }}
        tabIndex={0}
        onContextMenu={suppressBrowserMenu}
        aria-label={t('terminal.bufferAriaLabel')}
        role="region"
      >
        <div
          id="terminal-frame"
          ref={frameRef}
          className="relative overflow-hidden"
          style={{
            width: '100%',
            height: '100%',
          }}
        >
          <div
            id="terminal-surface"
            ref={surfaceRef}
            className="absolute top-0 left-0"
            style={{
              transformOrigin: 'top left',
              width: '100%',
              height: '100%',
            }}
          />
        </div>
      </div>

      {touchDebugEnabled && (
        <pre
          data-testid="terminal-touch-debug"
          className="pointer-events-none absolute left-1 top-1 z-50 border border-tui-border bg-tui-crust/90 px-2 py-1 font-mono text-tui-sm leading-relaxed text-tui-muted"
          aria-hidden="true"
        >
          {`gesture: ${touchDebug.state}\n`}
          {`deltaY: ${touchDebug.deltaY}  lines: ${touchDebug.lines}\n`}
          {`viewportY: ${touchDebug.viewportY ?? '-'}  focus: ${touchDebug.focused}\n`}
          {`buffer: ${touchDebug.bufferType ?? '-'} base: ${touchDebug.baseY ?? '-'} cursor: ${touchDebug.cursorY ?? '-'} scrollback: ${touchDebug.hasScrollback ?? '-'}\n`}
          {`scroll: ${touchDebug.scrollTop ?? '-'} / ${touchDebug.scrollHeight ?? '-'} (h ${touchDebug.clientHeight ?? '-'}) moved: ${touchDebug.moved}\n`}
          {`mode: ${touchDebug.scrollMode} calls: ${touchDebug.scrollCalls} lines: ${touchDebug.lastScrollLines ?? '-'} mouse: ${touchDebug.mouseTracking}\n`}
          {`event: ${touchDebug.lastInputEvent || '-'}  pointer: ${touchDebug.pointerEvents}  touch: ${touchDebug.touchEvents}`}
        </pre>
      )}

      {/* Rectangular selection overlay div */}
      {isTouchDevice && selectionRect && isHighlightVisible && (() => {
        const term = termRef.current;
        if (!term || !mainRef.current) return null;
        const cell = measureCellDimensions(term);
        if (cell.cellWidth <= 0 || cell.cellHeight <= 0) return null;

        const screenEl = (surfaceRef.current?.querySelector('.xterm-screen') as HTMLElement | null) || surfaceRef.current;
        if (!screenEl) return null;
        const screenRect = screenEl.getBoundingClientRect();
        const mainRect = mainRef.current.getBoundingClientRect();

        const startRowRel = selectionRect.startRow - viewportY;
        const endRowRel = selectionRect.endRow - viewportY;

        // Hide if completely scrolled out of the visible viewport
        if (endRowRel < 0 || startRowRel >= term.rows) return null;

        const top = (screenRect.top - mainRect.top) + startRowRel * cell.cellHeight;
        const left = (screenRect.left - mainRect.left) + selectionRect.startCol * cell.cellWidth;
        const width = (selectionRect.endCol - selectionRect.startCol + 1) * cell.cellWidth;
        const height = (selectionRect.endRow - selectionRect.startRow + 1) * cell.cellHeight;

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
      })()}

      {isTouchDevice && selectionMenu && (
        <TerminalSelectionMenu
          anchorPoint={selectionMenu}
          hasSelection={Boolean(selectionSnapshot)}
          isController={isController}
          vibrateOnKeyPress={settings.vibrateOnKeyPress}
          onCopySelection={handleCopySelection}
          onCopyLine={handleCopyLine}
          onCopyScreen={handleCopyScreen}
          onPaste={handlePaste}
          onClose={() => {
            setSelectionMenu(null);
            selectionMenuRef.current = null;
            setSelectionRect(null);
            selectionRectRef.current = null;
            setSelectionSnapshot('');
            selectionSnapshotRef.current = '';
            setIsHighlightVisible(false);
          }}
        />
      )}

      {isTouchDevice && (
        <PasteFallbackModal
          isOpen={isPasteFallbackOpen}
          onClose={() => setIsPasteFallbackOpen(false)}
          onSend={handleFallbackPasteSend}
          onSendImage={handleFallbackImageSend}
        />
      )}
    </main>
  );
};
