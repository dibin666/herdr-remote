// Predictive echo for this window's terminal: the predictor, the input-field
// probe and the layer that draws predictions, and when to throw them away.

import type { Terminal } from '@xterm/xterm';
import { type RefObject, useCallback, useEffect, useRef } from 'react';
import type { ConnectionState } from '@/connection/types';
import type { FieldProbe } from './inputField';
import type { PredictionLayer } from './predictionPaint';
import type { PredictiveEcho } from './predictiveEcho';
import type { AttachedRenderer } from '@/features/terminal/terminalRenderer';
import { attachPrediction, shouldShowPredictiveEcho } from './prediction';
import { useLatest } from '@/features/terminal/useLatest';

export function usePredictiveEcho({
  termRef,
  rendererRef,
  mode,
  connectionState,
  observeKeyInput,
  herdrPrefixKeys,
}: {
  termRef: RefObject<Terminal | null>;
  rendererRef: RefObject<AttachedRenderer | null>;
  mode: 'auto' | 'always' | 'off';
  connectionState: ConnectionState;
  observeKeyInput: (observer: (bytes: Uint8Array) => void) => () => void;
  /** The keys that put the workstation's Herdr into prefix mode; undefined until it says. */
  herdrPrefixKeys: readonly string[] | undefined;
}) {
  const predictorRef = useRef<PredictiveEcho | null>(null);
  const overlayRef = useRef<PredictionLayer | null>(null);
  const fieldProbeRef = useRef<FieldProbe | null>(null);
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modeRef = useLatest(mode);
  const herdrPrefixKeysRef = useLatest(herdrPrefixKeys);

  /** Draw the predictions still pending, when the mode and the link call for them. */
  const sync = useCallback(() => {
    if (expiryTimerRef.current !== null) clearTimeout(expiryTimerRef.current);
    expiryTimerRef.current = null;
    const predictor = predictorRef.current;
    const overlay = overlayRef.current;
    if (!predictor || !overlay) return;
    const items = predictor.getOverlayItems();
    const delayMs = predictor.getExpiryDelayMs();
    if (delayMs !== null) expiryTimerRef.current = setTimeout(sync, delayMs);
    if (!shouldShowPredictiveEcho(modeRef.current, predictor.getEchoSrttMs())) {
      overlay.clear();
      return;
    }
    overlay.sync(items);
  }, [modeRef]);

  /** Drops every prediction, and everything learned about where the fields are. */
  const forget = useCallback((reason: string) => {
    predictorRef.current?.reset(reason);
    predictorRef.current?.forgetConfidence();
    fieldProbeRef.current?.reset();
    overlayRef.current?.clear();
  }, []);

  /** Drop what is on screen but keep what was learned: a paste or a scroll. */
  const discard = useCallback((reason: string) => {
    predictorRef.current?.reset(reason);
    overlayRef.current?.clear();
  }, []);

  /** Keys the user typed, from xterm or a toolbar, before they go out. */
  const onUserInput = useCallback(
    (bytes: Uint8Array) => {
      predictorRef.current?.handleUserInput(bytes);
      sync();
      rendererRef.current?.canvas?.markInput();
    },
    [sync, rendererRef],
  );

  /** Start predicting on `term`; returns its screen state for the renderer. */
  const attach = useCallback(
    (term: Terminal) => {
      const parts = attachPrediction(
        term,
        () => termRef.current,
        () => herdrPrefixKeysRef.current,
      );
      fieldProbeRef.current = parts.fieldProbe;
      predictorRef.current = parts.predictor;
      overlayRef.current = parts.overlay;
      return parts;
    },
    [termRef, herdrPrefixKeysRef],
  );

  const detach = useCallback(() => {
    if (expiryTimerRef.current !== null) clearTimeout(expiryTimerRef.current);
    expiryTimerRef.current = null;
    overlayRef.current?.dispose();
    overlayRef.current = null;
    predictorRef.current = null;
    fieldProbeRef.current = null;
  }, []);

  useEffect(
    () => () => {
      if (expiryTimerRef.current !== null) clearTimeout(expiryTimerRef.current);
    },
    [],
  );

  // Keys from the on-screen toolbars go out through the context, not through
  // xterm, so they reach the predictor here.
  useEffect(() => observeKeyInput(onUserInput), [observeKeyInput, onUserInput]);

  // Immediately react to predictive echo preference changes (e.g. clearing active decorations on 'off')
  // biome-ignore lint/correctness/useExhaustiveDependencies: redraw when the mode changes
  useEffect(() => {
    sync();
  }, [mode, sync]);

  // Wipe speculative echo when socket connection drops or reconnects: a new
  // Herdr client draws a new screen, and nothing learned about the old one holds.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on each connection change
  useEffect(() => {
    forget('connectionState');
  }, [connectionState, forget]);

  return {
    predictorRef,
    overlayRef,
    fieldProbeRef,
    attach,
    detach,
    sync,
    forget,
    discard,
    onUserInput,
  };
}
