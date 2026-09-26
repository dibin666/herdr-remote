import React from 'react';
import { cn } from '@/shared/lib/cn';
import { GLYPH, SPARK_BARS, STATUS_TEXT, type StatusLevel, TONE_BG } from './tokens';

/* ------------------------------------------------------------------- meter */

/**
 * A bar built from `█` and `░`, the only bar a terminal has.
 *
 * `width` is in characters, so the meter is exactly as wide as the text it sits
 * next to and lines up with everything else on the grid.
 */
export const Meter: React.FC<{
  /** 0…1. Values outside the range are clamped. */
  value: number;
  width?: number;
  tone?: StatusLevel;
  className?: string;
}> = ({ value, width = 20, tone = 'accent', className }) => {
  const ratio = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const filled = Math.round(ratio * width);
  return (
    <span
      className={cn('inline-flex select-none whitespace-pre font-mono leading-none', className)}
      role="presentation"
    >
      <span className={STATUS_TEXT[tone]}>{GLYPH.meterFull.repeat(filled)}</span>
      <span className="text-tui-border">
        {GLYPH.meterEmpty.repeat(Math.max(0, width - filled))}
      </span>
    </span>
  );
};

/* ------------------------------------------------------------------ gauge */

/**
 * ratatui's `Gauge`: a bar filled to a ratio with its label *inside* it.
 *
 * The label sits over the bar rather than beside it, and inverts where the fill
 * has reached it — which is how a terminal shows a figure and its progress in
 * one row of cells instead of two. `mix-blend-difference` is what does the
 * inverting: the same trick as printing the label in reverse video.
 */
export const Gauge: React.FC<{
  /** 0…1. Values outside the range are clamped. */
  ratio: number;
  label?: React.ReactNode;
  tone?: StatusLevel;
  className?: string;
  'aria-label'?: string;
}> = ({ ratio, label, tone = 'accent', className, ...rest }) => {
  const value = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  return (
    <div
      className={cn(
        'relative h-[var(--tui-row)] w-full overflow-hidden border border-tui-border bg-tui-mantle',
        className,
      )}
      role="progressbar"
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      {...rest}
    >
      <div
        className={cn('absolute inset-y-0 left-0', TONE_BG[tone])}
        style={{ width: `${value * 100}%` }}
        aria-hidden="true"
      />
      {label !== undefined ? (
        <span className="absolute inset-0 flex items-center justify-center whitespace-nowrap px-1 text-tui font-bold text-tui-text mix-blend-difference">
          {label}
        </span>
      ) : null}
    </div>
  );
};

/**
 * ratatui's `LineGauge`: one row of rule, filled from the left, with the label
 * in front of it and the figure at the end.
 *
 * Where `Gauge` is for the one number a panel is about, this is for the several
 * that merely need comparing: a stack of them reads as a small bar chart
 * without ever leaving the character grid.
 */
export const LineGauge: React.FC<{
  label: React.ReactNode;
  ratio: number;
  value: React.ReactNode;
  tone?: StatusLevel;
  labelWidth?: number;
  className?: string;
}> = ({ label, ratio, value, tone = 'accent', labelWidth = 10, className }) => {
  const filled = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  return (
    <div className={cn('flex items-center gap-2 text-tui', className)}>
      <span className="shrink-0 truncate text-tui-muted" style={{ width: `${labelWidth}ch` }}>
        {label}
      </span>
      <span className="relative h-[3px] min-w-0 flex-1 bg-tui-border-dim" aria-hidden="true">
        <span
          className={cn('absolute inset-y-0 left-0', TONE_BG[tone])}
          style={{ width: `${filled * 100}%` }}
        />
      </span>
      <span className={cn('shrink-0 font-bold', STATUS_TEXT[tone])}>{value}</span>
    </div>
  );
};

/**
 * ratatui's `Sparkline`: recent history as a row of block characters.
 *
 * It is text, so it costs one line, needs no measurement and survives any
 * width. An empty history draws the baseline rather than collapsing, so a panel
 * does not change height on its second sample.
 */
export const Sparkline: React.FC<{
  values: number[];
  /** How many samples to show; the newest are kept. */
  width?: number;
  /**
   * The value that means "full height".
   *
   * Without it the series is scaled to its own peak, which is right for a rate
   * nobody knows the ceiling of and wrong for a percentage: three samples of a
   * quiet CPU would each be drawn as a full block, and a flat line would look
   * like a wall. Pass the real ceiling wherever there is one.
   */
  max?: number;
  tone?: StatusLevel;
  className?: string;
  'aria-label'?: string;
}> = ({ values, width = 24, max, tone = 'accent', className, ...rest }) => {
  const recent = values.slice(-width);
  const padding = Math.max(0, width - recent.length);
  const peak = max !== undefined ? max : Math.max(...recent, 0);
  const bars = recent.map((sample) => {
    if (!Number.isFinite(sample) || peak <= 0) return SPARK_BARS[0];
    const index = Math.round((Math.min(sample, peak) / peak) * (SPARK_BARS.length - 1));
    return SPARK_BARS[Math.min(SPARK_BARS.length - 1, Math.max(0, index))];
  });
  return (
    <span
      className={cn('select-none whitespace-pre leading-none', STATUS_TEXT[tone], className)}
      role="img"
      {...rest}
    >
      <span className="text-tui-border">{SPARK_BARS[0].repeat(padding)}</span>
      {bars.join('')}
    </span>
  );
};

/* --------------------------------------------------------------- stat tile */

/**
 * One headline figure: what it is, the number, and one line of context.
 *
 * A row of these is how a status board answers "how much" before anyone reads
 * a table. The figure is the only thing on the board at the larger size, and
 * it carries the colour of what it counts, so hosts, users and traffic can be
 * told apart at a glance without reading the labels.
 */
export const StatTile: React.FC<{
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  /** Colour of the figure. Omit for plain text. */
  tone?: StatusLevel;
  title?: string;
  className?: string;
}> = ({ label, value, sub, tone, title, className }) => (
  <div
    className={cn('min-w-0 border border-tui-border bg-tui-base px-2.5 py-1.5', className)}
    title={title}
  >
    <div className="truncate text-tui-sm text-tui-muted">{label}</div>
    <div
      className={cn('truncate text-tui-lg font-bold', tone ? STATUS_TEXT[tone] : 'text-tui-text')}
    >
      {value}
    </div>
    <div className="truncate text-tui-sm text-tui-faint">{sub || '\u00a0'}</div>
  </div>
);

/* --------------------------------------------------------------- spinner */

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Braille spinner, the one every terminal program uses. */
export const Spinner: React.FC<{ className?: string; label?: string }> = ({ className, label }) => {
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    const timer = setInterval(() => setFrame((value) => (value + 1) % SPINNER_FRAMES.length), 90);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)} role="status">
      <span aria-hidden="true" className="text-tui-accent">
        {SPINNER_FRAMES[frame]}
      </span>
      {label ? <span>{label}</span> : null}
    </span>
  );
};
