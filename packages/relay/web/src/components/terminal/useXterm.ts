// The xterm instance behind TerminalView: created once on mount and wired to
// input, output, prediction, gestures and the viewport, then kept in step with
// the font, the host's palette and session resets.

import type { Terminal } from '@xterm/xterm';
import { type RefObject, useEffect, useRef } from 'react';
import type { Translate } from '../../i18n';
import {
  encodeKeyWithModifiers,
  encodeStringToBytes,
  isSingleKey,
} from '../../protocol/keyEncoder';
import type { KeyModifiers } from '../../protocol/keyEncoder';
import { isWheelOnlyInput } from '../../protocol/scrollInput';
import { extractImageFromClipboardEvent } from '../../utils/clipboard';
import { sanitizeTerminalTitle } from '../../utils/documentTitle';
import type { PreparedImagePaste } from '../../utils/imagePaste';
import { classifyInput } from '../../utils/inputClassifier';
import {
  computeContainerGridFit,
  DEFAULT_BASE_FONT_SIZE,
  measureCellDimensions,
  measureElementBox,
} from '../../utils/terminalFit';
import {
  getEffectiveTerminalFontSize,
  getViewportHeight,
  getViewportWidth,
} from '../../utils/terminalLayout';
import { type AttachedRenderer, attachTerminalRenderer } from '../../utils/terminalRenderer';
import type { hostPaletteToTheme } from '../../utils/theme';
import { writeBanner } from './banner';
import { createTerminal } from './createTerminal';
import { attachGestureInput, type GestureSelection } from './gestureInput';
import type { TouchDebugUpdate } from './touchDebug';
import type { usePredictiveEcho } from './usePredictiveEcho';
import type { useTerminalFit } from './useTerminalFit';
import { attachViewportListeners } from './viewportListeners';

/** What the listeners bound at mount read at call time; see useLatest. */
export interface XtermLive {
  isController: boolean;
  sendBinary: (data: Uint8Array) => void;
  sendResize: (cols: number, rows: number) => void;
  warnViewerMode: () => void;
  uploadImage: (image: Blob | PreparedImagePaste) => Promise<boolean>;
  t: Translate;
  consumeModifierLatch: () => KeyModifiers | null;
  hostTheme: ReturnType<typeof hostPaletteToTheme>;
  onTerminalFocus?: () => void;
  ensureHostGlyphs: (text: string) => void;
  /** Whether characters on screen are offered to the host font's cut. */
  glyphScan: boolean;
}

/** Selection callbacks the terminal's own events drive. */
export interface XtermSelection extends GestureSelection {
  onTerminalRender(term: Terminal, start: number, end: number): void;
  onTerminalScroll(term: Terminal): void;
  onTerminalContentChanged(): void;
}

function refresh(term: Terminal | null): void {
  if (!term) return;
  try {
    term.refresh(0, Math.max(0, term.rows - 1));
  } catch {
    // Not drawable yet (or any more); the next frame repaints anyway.
  }
}

export function useXterm({
  containerRef,
  surfaceRef,
  termRef,
  rendererRef,
  currentScaleRef,
  initialBannerWrittenRef,
  live,
  selection,
  prediction,
  fit,
  isTouchDevice,
  debug,
  terminalFontSize,
  terminalFontFamily,
  hostTheme,
  glyphRevision,
  terminalResetVersion,
  isActive,
  subscribeToOutput,
  onOutput,
  onTitle,
  onRendererKind,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  surfaceRef: RefObject<HTMLDivElement | null>;
  termRef: RefObject<Terminal | null>;
  rendererRef: RefObject<AttachedRenderer | null>;
  currentScaleRef: RefObject<number>;
  initialBannerWrittenRef: RefObject<boolean>;
  live: RefObject<XtermLive>;
  selection: RefObject<XtermSelection>;
  prediction: ReturnType<typeof usePredictiveEcho>;
  fit: ReturnType<typeof useTerminalFit>;
  isTouchDevice: boolean;
  debug: TouchDebugUpdate;
  terminalFontSize: number;
  terminalFontFamily: string;
  hostTheme: XtermLive['hostTheme'];
  glyphRevision: number;
  terminalResetVersion: number;
  isActive: boolean;
  subscribeToOutput: (sink: (data: Uint8Array) => void) => () => void;
  /** Output reached the terminal, for the debug overlay's counters. */
  onOutput: ((bytes: number) => void) | null;
  onTitle: (title: string | null) => void;
  onRendererKind: (kind: string) => void;
}): void {
  const { requestFit, scheduleBoundedFit, seedFit, cancelPendingFits } = fit;

  // Initialize Terminal instance
  // biome-ignore lint/correctness/useExhaustiveDependencies: the terminal is created once; later changes reach it through the effects below
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

    // Seed the session dimensions before the auto-connect effect runs
    live.current.sendResize(initialGrid.cols, initialGrid.rows);
    seedFit(initialBox);

    const term = createTerminal({
      fontSize: getEffectiveTerminalFontSize(terminalFontSize, initialBox.width),
      fontFamily: terminalFontFamily,
      theme: live.current.hostTheme,
      cols: initialGrid.cols,
      rows: initialGrid.rows,
    });

    // Open xterm in the surface element
    term.open(surfaceRef.current);
    termRef.current = term;

    const titleDispose = term.onTitleChange((raw) => {
      onTitle(sanitizeTerminalTitle(raw) || null);
    });

    const { screenState, fieldProbe, overlay } = prediction.attach(term);

    // The xterm helper is the real terminal input on touch devices. Make its
    // mobile keyboard intent explicit; it is focused only after the gesture
    // controller has classified a terminal touch as a tap.
    if (isTouchDevice && term.textarea) {
      term.textarea.readOnly = false;
      term.textarea.tabIndex = 0;
      term.textarea.inputMode = 'text';
    }

    let removeTouchDebugFocusListeners = () => {};
    if (debug && term.textarea) {
      const syncFocusState = () => {
        debug((previous) => ({
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
      prediction.discard('paste');
      const imageBlob = extractImageFromClipboardEvent(e);
      if (imageBlob) {
        e.preventDefault();
        e.stopPropagation();
        if (!live.current.isController) {
          live.current.warnViewerMode();
          return;
        }
        await live.current.uploadImage(imageBlob);
      }
    };
    term.textarea?.addEventListener('paste', handleNativePaste);
    container.addEventListener('paste', handleNativePaste);

    const renderer = attachTerminalRenderer(term, {
      isSynchronizing: screenState.isSynchronizing,
      onRendererSwapped: (kind) => {
        container.dataset.renderer = kind;
        onRendererKind(kind);
        // The DOM renderer cannot draw predicted cells; nothing is predicted on screen there.
        prediction.overlayRef.current?.attach(null);
        refresh(term);
      },
    });
    overlay.attach(renderer.canvas);
    // Herdr closed a frame whose pieces the renderer held back: draw it whole, now.
    const syncEndDispose = screenState.onSyncEnd(() => rendererRef.current?.canvas?.flushHeld());
    rendererRef.current = renderer;
    container.dataset.renderer = renderer.kind;
    onRendererKind(renderer.kind);

    writeBanner(
      term,
      live.current.t('terminal.bannerTitle'),
      live.current.t('terminal.bannerSubtitle'),
    );
    initialBannerWrittenRef.current = true;
    // Probe once the banner has been parsed, so there is something to have drawn.
    term.write('', () => void renderer.verify());

    if (!isTouchDevice) {
      try {
        term.focus();
      } catch {
        // ignore
      }
    }

    // Refresh terminal once webfont is loaded so Nerd Font glyphs render immediately
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (typeof fonts?.load === 'function') {
      fonts
        .load('13px "Symbols Nerd Font Mono"')
        .then(() => {
          if (!termRef.current) return;
          refresh(termRef.current);
          scheduleBoundedFit(5);
        })
        .catch(() => {
          // The terminal keeps drawing with whatever fonts it has.
        });
    }
    // Handle user keyboard & mouse reporting input from xterm
    const dataDispose = term.onData((typed) => {
      const { isController } = live.current;
      // A modifier latched on the key bar applies to the next key from any
      // keyboard, the phone's own included. Pastes, IME commits and mouse
      // reports leave it for a real key.
      let data = typed;
      if (isController && classifyInput(typed) === 'keys' && isSingleKey(typed)) {
        const modifiers = live.current.consumeModifierLatch();
        if (modifiers) data = encodeKeyWithModifiers(typed, modifiers);
      }
      const bytes = encodeStringToBytes(data);
      // Scrolling a viewer's own stream is allowed; typing into the shared
      // session is not. Without this split every wheel notch raised a
      // read-only warning, which buried the terminal under toasts.
      if (!isController && !isWheelOnlyInput(bytes)) {
        live.current.warnViewerMode();
        return;
      }
      prediction.onUserInput(bytes);
      live.current.sendBinary(bytes);
    });

    const binaryDispose = term.onBinary((data) => {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) {
        bytes[i] = data.charCodeAt(i) & 255;
      }
      if (!live.current.isController && !isWheelOnlyInput(bytes)) return;
      live.current.sendBinary(bytes);
    });

    // Track terminal render updates and scroll events to invalidate highlight on redraw
    // while keeping viewportY in sync across buffer scrolling.
    const writeParsedDispose =
      typeof term.onWriteParsed === 'function'
        ? term.onWriteParsed(() => {
            selection.current.onTerminalContentChanged();
            fieldProbe.invalidate();
            // Herdr fences every frame in ?2026, which xterm 5.5 ignores, and a
            // parse can end mid-frame. Judged against a half-drawn frame, good
            // predictions look wrong; wait for the frame to finish.
            if (screenState.isSynchronizing()) return;
            prediction.predictorRef.current?.onServerOutput();
            prediction.sync();
          })
        : { dispose: () => {} };

    const renderDispose =
      typeof term.onRender === 'function'
        ? term.onRender((e: { start: number; end: number }) => {
            // Every content frame lands here; React only hears of an actual scroll.
            if (live.current.glyphScan) {
              const viewportY = term.buffer.active.viewportY ?? 0;
              let drawn = '';
              for (let row = e.start; row <= e.end; row += 1) {
                drawn += term.buffer.active.getLine(viewportY + row)?.translateToString(true) ?? '';
              }
              // ASCII never needs a cut; skip the common case cheaply.
              if (/[^\x00-\x7f]/.test(drawn)) live.current.ensureHostGlyphs(drawn);
            }
            selection.current.onTerminalRender(term, e.start, e.end);
          })
        : { dispose: () => {} };

    const scrollDispose =
      typeof term.onScroll === 'function'
        ? term.onScroll(() => {
            selection.current.onTerminalScroll(term);
            prediction.discard('scroll');
          })
        : { dispose: () => {} };

    const detachGestures = attachGestureInput({
      container,
      term,
      isTouchDevice,
      debug,
      getTerminal: () => termRef.current,
      getIsController: () => live.current.isController,
      getScale: () => currentScaleRef.current,
      getSurfaceElement: () => surfaceRef.current,
      getSelection: () => selection.current,
      onFocus: () => live.current.onTerminalFocus?.(),
    });

    const detachViewport = attachViewportListeners(container, {
      requestFit,
      onPageVisible: () => {
        scheduleBoundedFit(10);
        refresh(termRef.current);
      },
    });

    return () => {
      dataDispose.dispose();
      binaryDispose.dispose();
      renderDispose.dispose();
      scrollDispose.dispose();
      writeParsedDispose.dispose();
      titleDispose.dispose();
      syncEndDispose.dispose();
      prediction.detach();
      screenState.dispose();
      detachGestures();
      detachViewport();
      cancelPendingFits();
      removeTouchDebugFocusListeners();
      term.textarea?.removeEventListener('paste', handleNativePaste);
      container.removeEventListener('paste', handleNativePaste);
      renderer.dispose();
      rendererRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, []); // Run once on mount

  // Sync visual-only changes (size, face — including the host's font arriving)
  // with the live terminal
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs and the fit scheduler are stable
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const box = measureElementBox(containerRef.current, getViewportWidth(), getViewportHeight());
    term.options.fontSize = getEffectiveTerminalFontSize(terminalFontSize, box.width);
    term.options.fontFamily = terminalFontFamily;
    refresh(term);

    // A different font means a different cell, and the grid is measured from
    // the cell. Refitting keeps the terminal full-bleed after a zoom instead of
    // leaving the frame half-painted; the renderer needs a frame to re-measure,
    // which is what the bounded chain waits for.
    scheduleBoundedFit(10);
  }, [terminalFontSize, terminalFontFamily]);

  // New characters from the host's cut font arrived under a family already in
  // the stack: nothing about the font options changed, so repaint explicitly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs are stable
  useEffect(() => {
    const term = termRef.current;
    if (!term || !glyphRevision) return;
    rendererRef.current?.canvas?.clearTextureAtlas();
    refresh(term);
  }, [glyphRevision]);

  // Switching profiles or rebuilding a PTY must never append new output to the
  // previous host's screen. Keep the xterm instance mounted for layout
  // stability, but explicitly reset its buffer at the generation boundary.
  const appliedResetVersionRef = useRef(terminalResetVersion);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs and prediction.forget are stable
  useEffect(() => {
    if (appliedResetVersionRef.current === terminalResetVersion) return;
    appliedResetVersionRef.current = terminalResetVersion;
    prediction.forget('resetVersion');
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs are stable
  useEffect(() => {
    const term = termRef.current;
    if (!term || !hostTheme) return;
    term.options.theme = { ...hostTheme };
    refresh(term);
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
      onOutput?.(data.byteLength);
    });

    return unsubscribe;
  }, [subscribeToOutput, termRef, onOutput]);

  /**
   * Restore path when the view becomes active again (e.g. back from Admin).
   */
  useEffect(() => {
    if (!isActive) return;

    scheduleBoundedFit(10);

    const term = termRef.current;
    if (term) {
      refresh(term);
      if (!isTouchDevice) {
        try {
          term.focus();
        } catch {
          // ignore
        }
      }
    }
  }, [isActive, isTouchDevice, scheduleBoundedFit, termRef]);
}
