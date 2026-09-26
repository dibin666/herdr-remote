import type { Terminal } from '@xterm/xterm';
import React, { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import {
  useConnection,
  useSettings,
  useTerminalIO,
  useToasts,
  useUpload,
} from '@/context/TerminalContext';
import { attentionCounts } from '@/features/agents/agentAttention';
import { applyDocumentTitle } from '@/features/agents/documentTitle';
import { isCoarsePointerDevice, MOBILE_BREAKPOINT_PX } from './terminalLayout';
import { openTerminalLink } from './terminalLinks';
import type { AttachedRenderer } from './terminalRenderer';
import { hostPaletteToTheme } from './theme';
import { PasteFallbackModal } from '@/features/paste/PasteFallbackModal';
import { TerminalSelectionMenu } from './TerminalSelectionMenu';
import {
  INITIAL_TOUCH_DEBUG,
  isTouchDebugEnabled,
  TouchDebugOverlay,
  type TouchDebugState,
  useInboundMetrics,
} from './touchDebug';
import { useLatest } from './useLatest';
import { usePasteActions } from './usePasteActions';
import { usePredictiveEcho } from '@/features/prediction/usePredictiveEcho';
import { useTerminalFit } from './useTerminalFit';
import { SelectionOverlay, useTerminalSelection } from './useTerminalSelection';
import { useXterm, type XtermLive } from './useXterm';

export { MOBILE_BREAKPOINT_PX };
export {
  PREDICTIVE_ECHO_AUTO_THRESHOLD_MS,
  shouldShowPredictiveEcho,
} from '@/features/prediction/prediction';
export { RESIZE_NOTIFY_DEBOUNCE_MS } from './useTerminalFit';

interface TerminalViewProps {
  onTerminalFocus?: () => void;
  /**
   * False while another view (e.g. Admin) is on top. The terminal stays mounted
   * and measurable — only PTY resize notifications and focus are suppressed —
   * so no xterm state, buffer or WebSocket session is torn down.
   */
  isActive?: boolean;
}

export const TerminalView: React.FC<TerminalViewProps> = ({ onTerminalFocus, isActive = true }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  /**
   * The surface is never transformed, so this stays 1. It exists because the
   * pointer layer routes every coordinate through the same inverse transform,
   * and that has to keep working if a scale is ever reintroduced.
   */
  const currentScaleRef = useRef<number>(1.0);
  const rendererRef = useRef<AttachedRenderer | null>(null);
  const initialBannerWrittenRef = useRef<boolean>(false);
  const isTouchDevice = isCoarsePointerDevice();
  const touchInputCapable =
    isTouchDevice ||
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) ||
    (typeof window !== 'undefined' && 'ontouchstart' in window);
  const touchDebugEnabled = isTouchDebugEnabled();
  const [touchDebug, setTouchDebug] = useState<TouchDebugState>(INITIAL_TOUCH_DEBUG);
  const { metrics: inboundMetrics, record: recordInbound } = useInboundMetrics(touchDebugEnabled);
  const [rendererKind, setRendererKind] = useState<string | null>(null);

  const {
    settings,
    terminalFontFamily,
    terminalFontSize,
    hostFont,
    ensureHostGlyphs,
    profiles,
    activeProfileId,
    t,
  } = useSettings();
  const {
    isController,
    connectionState,
    hostPalette,
    terminalResetVersion,
    agentStatus,
    connect,
    rttMs,
  } = useConnection();
  const { addToast } = useToasts();
  const {
    sendResize,
    sendBinary,
    observeKeyInput,
    consumeModifierLatch,
    warnViewerMode,
    subscribeToOutput,
    subscribeToPasteFileReady,
  } = useTerminalIO();
  const { uploadImage } = useUpload();

  /**
   * The host's own terminal colors, in xterm's theme shape. Not a theme this
   * client chose: it is what the workstation's emulator answered to the OSC
   * color queries. Without it xterm keeps its defaults rather than inventing
   * a palette here.
   */
  const hostTheme = React.useMemo(() => hostPaletteToTheme(hostPalette), [hostPalette]);

  // What the listeners xterm and the document hold, bound once at mount, read
  // at call time instead of from a stale render.
  const live = useLatest<XtermLive>({
    isController,
    sendBinary,
    sendResize,
    warnViewerMode,
    uploadImage,
    t,
    consumeModifierLatch,
    hostTheme,
    onTerminalFocus,
    // Characters on screen are offered to the host font's cut, when there is one.
    ensureHostGlyphs,
    glyphScan: hostFont.glyphs.status === 'ready',
  });
  const isActiveRef = useLatest(isActive);

  const prediction = usePredictiveEcho({
    termRef,
    rendererRef,
    mode: settings.predictiveEcho,
    connectionState,
    observeKeyInput,
  });

  /**
   * What this window's own Herdr client calls itself, via OSC 2. Only this
   * window's, which is what Herdr 0.9.1 guarantees; see `features/agents/documentTitle`.
   */
  const [terminalTitle, setTerminalTitle] = useState<string | null>(null);

  const selection = useTerminalSelection({
    termRef,
    surfaceRef,
    mainRef,
    currentScaleRef,
    addToast,
    t,
  });
  const selectionRef = useLatest(selection);

  const paste = usePasteActions({
    termRef,
    isController,
    warnViewerMode,
    uploadImage,
    addToast,
    t,
    onPaste: () => prediction.discard('paste'),
    subscribeToPasteFileReady,
  });

  const fit = useTerminalFit({
    termRef,
    containerRef,
    frameRef,
    surfaceRef,
    currentScaleRef,
    rendererRef,
    initialBannerWrittenRef,
    isActiveRef,
    sendResize,
    // Herdr lays every pane out again, so no field is where it was.
    onResized: () => prediction.forget('resize'),
  });

  useXterm({
    containerRef,
    surfaceRef,
    termRef,
    rendererRef,
    currentScaleRef,
    initialBannerWrittenRef,
    live,
    selection: selectionRef,
    prediction,
    fit,
    isTouchDevice,
    debug: touchDebugEnabled ? setTouchDebug : null,
    terminalFontSize,
    terminalFontFamily,
    hostTheme,
    glyphRevision: hostFont.glyphRevision,
    terminalResetVersion,
    isActive,
    subscribeToOutput,
    onOutput: touchDebugEnabled ? recordInbound : null,
    onTitle: setTerminalTitle,
    onRendererKind: setRendererKind,
  });

  const activeProfileName = React.useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId)?.displayName ?? null,
    [profiles, activeProfileId],
  );

  /**
   * A dropped session takes its title with it.
   *
   * Reconnecting starts a *fresh* Herdr client rather than rejoining the old
   * one, so the previous view's name is not something this window is still
   * looking at. The profile name is the honest thing to show until the new
   * client announces itself.
   */
  useEffect(() => {
    if (connectionState !== 'connected') setTerminalTitle(null);
  }, [connectionState]);

  /**
   * Only the visible terminal layer renames the tab. While the admin dashboard
   * is up the terminal is still mounted and still receiving output, and a tab
   * named after a session nobody is looking at would be a lie.
   */
  useEffect(() => {
    const showing = isActive && connectionState === 'connected';
    const attention = settings.agentAlertBadge ? attentionCounts(agentStatus) : null;
    applyDocumentTitle(showing ? terminalTitle : null, activeProfileName, attention);
  }, [
    isActive,
    connectionState,
    terminalTitle,
    activeProfileName,
    agentStatus,
    settings.agentAlertBadge,
  ]);

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
        <TouchDebugOverlay
          debug={touchDebug}
          rttMs={rttMs}
          metrics={inboundMetrics}
          rendererKind={rendererKind}
          predictiveEcho={settings.predictiveEcho}
          predictor={prediction.predictorRef.current}
          field={prediction.fieldProbeRef.current?.detect() ?? null}
          renderer={rendererRef.current}
        />
      )}

      {isTouchDevice && selection.selectionRect && selection.isHighlightVisible && (
        <SelectionOverlay
          term={termRef.current}
          surface={surfaceRef.current}
          main={mainRef.current}
          rect={selection.selectionRect}
          viewportY={selection.viewportY}
        />
      )}

      {isTouchDevice && selection.selectionMenu && (
        <TerminalSelectionMenu
          anchorPoint={selection.selectionMenu}
          hasSelection={Boolean(selection.selectionSnapshot)}
          isController={isController}
          vibrateOnKeyPress={settings.vibrateOnKeyPress}
          linkUrl={selection.selectionMenu.link ?? null}
          onOpenLink={(url) => {
            if (!openTerminalLink(url)) addToast('warning', t('clipboard.openLinkFailed'));
          }}
          onCopySelection={selection.handleCopySelection}
          onCopyLine={selection.handleCopyLine}
          onCopyScreen={selection.handleCopyScreen}
          onPaste={paste.handlePaste}
          onClose={selection.clearSelection}
        />
      )}

      {isTouchDevice && (
        <PasteFallbackModal
          isOpen={paste.isPasteFallbackOpen}
          onClose={paste.closePasteFallback}
          onSend={paste.handleFallbackPasteSend}
          onSendImage={paste.handleFallbackImageSend}
        />
      )}
    </main>
  );
};
