import type React from 'react';
import { cn } from '../../utils/cn';

/* ------------------------------------------------------------------ glyphs */

export const GLYPH = {
  /** Where the cursor is. */
  cursor: '▸',
  /** Same width as the cursor, so a list does not shift when it moves. */
  noCursor: ' ',
  /** A live thing. */
  on: '●',
  /** A thing that exists but is not running. */
  off: '○',
  /** Separates values on one line, as Herdr's sidebar does. */
  dot: '·',
  check: '✓',
  cross: '✗',
  warn: '!',
  arrowRight: '→',
  arrowLeft: '←',
  chevronDown: '▾',
  chevronRight: '▸',
  ellipsis: '…',
  /** Meter fill and track. */
  meterFull: '█',
  meterEmpty: '░',
  /** ratatui's `LineGauge` symbols: a drawn line, filled and unfilled. */
  lineFull: '━',
  lineEmpty: '─',
  /** ratatui's tab divider. */
  tabDivider: '│',
} as const;

/**
 * The eight heights a sparkline can draw, as ratatui's `Sparkline` does.
 *
 * A row of these is a chart that costs one line of the grid and needs no axes,
 * no legend and no library — which is the only kind of chart a terminal has.
 */
export const SPARK_BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

/**
 * What a colour is allowed to mean.
 *
 * `ok`/`warn`/`bad` are conditions; `idle` is "present but not running";
 * `accent` is "this is where you are". `alt` and `info` are for categories that
 * are neither good nor bad and must not be mistaken for either — a relay's mode,
 * a transport kind.
 */
export type StatusLevel = 'ok' | 'warn' | 'bad' | 'idle' | 'accent' | 'alt' | 'info';

/**
 * The one place a level becomes a class.
 *
 * Every surface that colours by level reads this table instead of writing its
 * own, so a level cannot mean green in one panel and teal in the next. The
 * strings are written out in full because Tailwind scans for literals.
 */
export const TONE = {
  ok: { text: 'text-tui-ok', edgeL: 'border-l-tui-ok', edgeB: 'border-b-tui-ok' },
  warn: { text: 'text-tui-warn', edgeL: 'border-l-tui-warn', edgeB: 'border-b-tui-warn' },
  bad: { text: 'text-tui-bad', edgeL: 'border-l-tui-bad', edgeB: 'border-b-tui-bad' },
  idle: { text: 'text-tui-faint', edgeL: 'border-l-tui-border', edgeB: 'border-b-tui-border' },
  accent: { text: 'text-tui-accent', edgeL: 'border-l-tui-accent', edgeB: 'border-b-tui-accent' },
  alt: { text: 'text-tui-alt', edgeL: 'border-l-tui-alt', edgeB: 'border-b-tui-alt' },
  info: { text: 'text-tui-info', edgeL: 'border-l-tui-info', edgeB: 'border-b-tui-info' },
} as const satisfies Record<StatusLevel, { text: string; edgeL: string; edgeB: string }>;

export const STATUS_TEXT: Record<StatusLevel, string> = {
  ok: TONE.ok.text,
  warn: TONE.warn.text,
  bad: TONE.bad.text,
  idle: TONE.idle.text,
  accent: TONE.accent.text,
  alt: TONE.alt.text,
  info: TONE.info.text,
};

/** `●` for anything live, `○` for anything merely present. */
export const StatusDot: React.FC<{ level: StatusLevel; className?: string }> = ({
  level,
  className,
}) => (
  <span
    aria-hidden="true"
    className={cn('select-none leading-none', STATUS_TEXT[level], className)}
  >
    {level === 'idle' ? GLYPH.off : GLYPH.on}
  </span>
);

/** The `·` Herdr uses between values on a single row. */
export const Sep: React.FC<{ className?: string }> = ({ className }) => (
  <span aria-hidden="true" className={cn('select-none text-tui-faint', className)}>
    {GLYPH.dot}
  </span>
);

export const TONE_BG: Record<StatusLevel, string> = {
  ok: 'bg-tui-ok',
  warn: 'bg-tui-warn',
  bad: 'bg-tui-bad',
  idle: 'bg-tui-border',
  accent: 'bg-tui-accent',
  alt: 'bg-tui-alt',
  info: 'bg-tui-info',
};
