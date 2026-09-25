// The `?debug=1` overlay: what the touch gesture, the output stream, the
// renderer and the predictor are doing, for diagnosing a phone in the field.

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { InputField } from '../../utils/inputField';
import type { PredictiveEcho } from '../../utils/predictiveEcho';
import type { AttachedRenderer } from '../../utils/terminalRenderer';
import type { TouchGestureState } from '../../utils/touchMouseAdapter';

export interface TouchDebugState {
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

export const INITIAL_TOUCH_DEBUG: TouchDebugState = {
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
};

/** Change the debug state from outside React, or null when the overlay is off. */
export type TouchDebugUpdate =
  | ((update: (previous: TouchDebugState) => TouchDebugState) => void)
  | null;

export function isTouchDebugEnabled(): boolean {
  return (
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('debug') === '1'
  );
}

/** Output frames and bytes per second over the last second, sampled once a second. */
export function useInboundMetrics(enabled: boolean) {
  const statsRef = useRef<{ time: number; bytes: number }[]>([]);
  const [metrics, setMetrics] = useState({ framesPerSec: 0, bytesPerSec: 0 });

  const prune = useCallback((now: number) => {
    const cutoff = now - 1000;
    const stats = statsRef.current;
    while (stats.length > 0 && stats[0].time < cutoff) {
      stats.shift();
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => {
      prune(performance.now());
      let bytes = 0;
      for (const entry of statsRef.current) bytes += entry.bytes;
      setMetrics({ framesPerSec: statsRef.current.length, bytesPerSec: bytes });
    }, 1000);
    return () => clearInterval(interval);
  }, [enabled, prune]);

  const record = useCallback(
    (bytes: number) => {
      const now = performance.now();
      statsRef.current.push({ time: now, bytes });
      prune(now);
    },
    [prune],
  );

  return { metrics, record };
}

/** One line for the debug overlay: which input field, if any, the caret is in. */
function describePredictionField(field: InputField | null): string {
  if (!field) return 'none';
  return `${field.kind} row ${field.row} cols ${field.startCol}-${field.endCol} caret ${field.caretCol}`;
}

/** One line for the debug overlay: what the last frame cost. */
function describeRenderStats(renderer: AttachedRenderer | null): string {
  const stats = renderer?.canvas?.stats;
  if (!stats) return `paint: ${renderer?.kind ?? '-'} renderer\n`;
  const keyToPaint =
    stats.lastInputToPaintMs !== null ? `${stats.lastInputToPaintMs.toFixed(1)}ms` : '-';
  return `paint: ${stats.lastPaintMs.toFixed(2)}ms  cells: ${stats.lastCells}  frames: ${stats.frames}  held: ${stats.heldFrames}  key→paint: ${keyToPaint}\n`;
}

/** The predictor's last few decisions, newest last, for finding out why nothing was predicted. */
function describePredictionTrace(predictor: PredictiveEcho | null): string {
  const trace = predictor?.getTrace() ?? [];
  if (trace.length === 0) return 'trace: -';
  return `trace:\n${trace
    .slice(-6)
    .map((entry) => `  ${entry.event}${entry.count > 1 ? ` ×${entry.count}` : ''}`)
    .join('\n')}`;
}

export const TouchDebugOverlay: React.FC<{
  debug: TouchDebugState;
  rttMs: number | null;
  metrics: { framesPerSec: number; bytesPerSec: number };
  rendererKind: string | null;
  predictiveEcho: string;
  predictor: PredictiveEcho | null;
  field: InputField | null;
  renderer: AttachedRenderer | null;
}> = ({ debug, rttMs, metrics, rendererKind, predictiveEcho, predictor, field, renderer }) => {
  const srtt = predictor?.getEchoSrttMs();
  return (
    <pre
      data-testid="terminal-touch-debug"
      className="pointer-events-none absolute left-1 top-1 z-50 border border-tui-border bg-tui-crust/90 px-2 py-1 font-mono text-tui-sm leading-relaxed text-tui-muted"
      aria-hidden="true"
    >
      {`gesture: ${debug.state}\n`}
      {`deltaY: ${debug.deltaY}  lines: ${debug.lines}\n`}
      {`viewportY: ${debug.viewportY ?? '-'}  focus: ${debug.focused}\n`}
      {`buffer: ${debug.bufferType ?? '-'} base: ${debug.baseY ?? '-'} cursor: ${debug.cursorY ?? '-'} scrollback: ${debug.hasScrollback ?? '-'}\n`}
      {`scroll: ${debug.scrollTop ?? '-'} / ${debug.scrollHeight ?? '-'} (h ${debug.clientHeight ?? '-'}) moved: ${debug.moved}\n`}
      {`mode: ${debug.scrollMode} calls: ${debug.scrollCalls} lines: ${debug.lastScrollLines ?? '-'} mouse: ${debug.mouseTracking}\n`}
      {`event: ${debug.lastInputEvent || '-'}  pointer: ${debug.pointerEvents}  touch: ${debug.touchEvents}\n`}
      {`rtt: ${rttMs !== null ? `${rttMs}ms` : '-'}  frames/s: ${metrics.framesPerSec}  bytes/s: ${metrics.bytesPerSec}  renderer: ${rendererKind ?? '-'}\n`}
      {`prediction: ${predictor?.getState() ?? '-'}  mode: ${predictiveEcho}  pending: ${predictor?.getVisiblePredictions().length ?? 0}  srtt: ${srtt !== null && srtt !== undefined ? `${Math.round(srtt)}ms` : '-'}\n`}
      {`field: ${describePredictionField(field)}  mismatches: ${predictor?.getMismatchCount() ?? 0}\n`}
      {describeRenderStats(renderer)}
      {describePredictionTrace(predictor)}
    </pre>
  );
};
