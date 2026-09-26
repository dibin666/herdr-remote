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
}: {
  termRef: RefObject<Terminal | null>;
  rendererRef: RefObject<AttachedRenderer | null>;
  mode: 'auto' | 'always' | 'off';
  connectionState: ConnectionState;
  observeKeyInput: (observer: (bytes: Uint8Array) => void) => () => void;
}) {
  const predictorRef = useRef<PredictiveEcho | null>(null);
  const overlayRef = useRef<PredictionLayer | null>(null);
  const fieldProbeRef = useRef<FieldProbe | null>(null);
  const modeRef = useLatest(mode);

  /** Draw the predictions still pending, when the mode and the link call for them. */
  const sync = useCallback(() => {
    const predictor = predictorRef.current;
    const overlay = overlayRef.current;
    if (!predictor || !overlay) return;
    if (!shouldShowPredictiveEcho(modeRef.current, predictor.getEchoSrttMs())) {
      overlay.clear();
      return;
    }
    overlay.sync(predictor.getOverlayItems());
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
      const parts = attachPrediction(term, () => termRef.current);
      fieldProbeRef.current = parts.fieldProbe;
      predictorRef.current = parts.predictor;
      overlayRef.current = parts.overlay;
      return parts;
    },
    [termRef],
  );

  const detach = useCallback(() => {
    overlayRef.current?.dispose();
    overlayRef.current = null;
    predictorRef.current = null;
    fieldProbeRef.current = null;
  }, []);

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
