// What the overlay draws for a run of predictions; see
// `PredictiveEcho.getOverlayItems`.

import type { CellStyle } from '@/features/terminal/render/cell';
import {
  normalizeBlank,
  type OverlayItem,
  type PendingPrediction,
  type PredictionBufferActive,
  type PredictionField,
} from './predictionModel';

export function overlayItems(
  visible: PendingPrediction[],
  {
    style,
    predictedCursor,
    field,
    runStartedEmpty,
    active,
  }: {
    /** How the field draws typed text, once learned. */
    style: CellStyle | undefined;
    predictedCursor: { row: number; col: number } | null;
    field: PredictionField | null;
    runStartedEmpty: boolean;
    active: PredictionBufferActive | undefined;
  },
): OverlayItem[] {
  const items: OverlayItem[] = visible.map((p) => {
    const item: OverlayItem = {
      row: p.row,
      col: p.col,
      char: p.char,
      width: p.width,
      kind: p.kind,
    };
    if (style) item.style = style;
    return item;
  });

  // Where the next character will land: the live run's cursor, or after a
  // freeze, the end of what is still shown.
  const last = visible[visible.length - 1];
  const next = predictedCursor ?? {
    row: last.row,
    col: last.kind === 'erase' ? last.col : last.col + last.width,
  };
  const covers = (row: number, col: number) =>
    items.some((p) => p.row === row && p.col <= col && col < p.col + p.width);

  // The placeholder of an empty agent box goes with the first key typed.
  if (active && field && runStartedEmpty && field.agentLike && next.row === field.row) {
    const line = active.getLine(next.row);
    for (let col = next.col; col < field.endCol; col++) {
      if (covers(next.row, col)) continue;
      if (normalizeBlank(line?.getCell(col)?.getChars() ?? '') === ' ') continue;
      const item: OverlayItem = { row: next.row, col, char: ' ', width: 1, kind: 'erase' };
      if (style) item.style = style;
      items.push(item);
    }
  }

  if (active) {
    const server = { row: active.baseY + active.cursorY, col: active.cursorX };
    if (!covers(server.row, server.col) && (server.row !== next.row || server.col !== next.col)) {
      const chars = active.getLine(server.row)?.getCell(server.col)?.getChars() ?? '';
      const item: OverlayItem = {
        row: server.row,
        col: server.col,
        char: normalizeBlank(chars),
        width: 1,
        kind: 'mask',
      };
      if (style) item.style = style;
      items.push(item);
    }
  }

  // A block caret is drawn over the character under it, so carry that
  // along: what a pending prediction puts there, else what the server drew.
  const pending = items.find((p) => p.row === next.row && p.col === next.col && p.kind !== 'mask');
  const under = pending
    ? pending.char
    : normalizeBlank(active?.getLine(next.row)?.getCell(next.col)?.getChars() ?? '');
  items.push({ row: next.row, col: next.col, char: under, width: 1, kind: 'caret' });
  return items;
}
