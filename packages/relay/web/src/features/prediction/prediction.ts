// Predictive echo on a live terminal: which field the caret is in, what the
// user typed that the host has not echoed yet, and drawing it.

import type { Terminal } from '@xterm/xterm';
import { FieldProbe } from './inputField';
import { PredictionLayer } from './predictionPaint';
import { PredictiveEcho } from './predictiveEcho';
import { attachScreenState } from '@/features/terminal/screenState';

/**
 * Latency threshold below which local predictive echo is suppressed in "auto" mode.
 * Human visual reaction and typing perception under ~40ms feels instantaneous,
 * making speculative characters unnecessary visual noise on local/LAN connections.
 */
export const PREDICTIVE_ECHO_AUTO_THRESHOLD_MS = 40;

/**
 * Evaluates whether predictive echo characters should be displayed on screen
 * given the user preference and smoothed round-trip time.
 */
export function shouldShowPredictiveEcho(
  mode: 'auto' | 'always' | 'off',
  srttMs: number | null,
): boolean {
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  // 'auto': only render speculative characters when smoothed RTT exceeds the imperceptible latency threshold
  return srttMs !== null && srttMs > PREDICTIVE_ECHO_AUTO_THRESHOLD_MS;
}

/**
 * The prediction machinery for `term`. `getTerminal` is read at call time, so
 * a disposed terminal stops being consulted.
 */
export function attachPrediction(term: Terminal, getTerminal: () => Terminal | null) {
  // Predictions are only made where the caret is in an input field; see
  // inputField.ts for how one is recognised on Herdr's composited screen.
  const screenState = attachScreenState(term);
  const fieldProbe = new FieldProbe({
    getScreen: () => {
      const current = getTerminal();
      if (!current) return null;
      const active = current.buffer.active;
      return {
        cols: current.cols,
        rows: current.rows,
        baseY: active.baseY,
        getLine: (row) => active.getLine(row),
        getNullCell:
          typeof active.getNullCell === 'function' ? () => active.getNullCell() : undefined,
      };
    },
    getCursor: () => {
      const active = getTerminal()?.buffer.active;
      if (!active) return null;
      return {
        row: active.baseY + active.cursorY,
        col: active.cursorX,
        hidden: screenState.isCursorHidden(),
      };
    },
    isSynchronizing: screenState.isSynchronizing,
  });

  const unicode = (
    term as unknown as {
      _core?: { unicodeService?: { wcwidth?: (codePoint: number) => number } };
    }
  )._core?.unicodeService;
  const predictor = new PredictiveEcho({
    getTerminal,
    getField: fieldProbe.detect,
    // The width xterm will draw a character at, as the guess for ones whose width may differ elsewhere.
    charWidth:
      typeof unicode?.wcwidth === 'function'
        ? (codePoint) => unicode.wcwidth!(codePoint)
        : undefined,
  });

  // Predicted typing is drawn by the renderer itself, as ordinary cells in
  // the style the field's echoes have shown; see predictionPaint.ts.
  const overlay = new PredictionLayer({
    getTerminal,
    isCursorHidden: () => screenState.isCursorHidden(),
  });

  return { screenState, fieldProbe, predictor, overlay };
}
