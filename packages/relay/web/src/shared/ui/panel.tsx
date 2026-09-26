import type React from 'react';
import { cn } from '@/shared/lib/cn';
import { GLYPH, STATUS_TEXT, type StatusLevel, TONE } from './tokens';

/* ------------------------------------------------------------------- panel */

export interface PanelProps {
  /** Rendered into the top rule, `┌─ LIKE THIS ─┐`. Omit for a plain frame. */
  title?: React.ReactNode;
  /** Right-aligned on the title line: a count, a state, a small action. */
  aside?: React.ReactNode;
  /** Colour of the legend text; the frame itself never changes colour. */
  tone?: StatusLevel;
  className?: string;
  bodyClassName?: string;
  'aria-label'?: string;
  children: React.ReactNode;
}

/**
 * A framed region with its title cut into the top border.
 *
 * `fieldset` + `legend` is not a stylistic choice: it is the only construct a
 * browser natively opens a gap in a border for, which is exactly the notch a
 * TUI draws. The frame therefore stays a single continuous rule at every width
 * and zoom level, instead of four lines that have to be kept in register.
 */
export const Panel: React.FC<PanelProps> = ({
  title,
  aside,
  tone = 'accent',
  className,
  bodyClassName,
  children,
  ...rest
}) => (
  <fieldset
    className={cn(
      'tui-panel tui-block relative min-w-0 border border-tui-border bg-tui-base',
      title ? 'px-3 pb-3 pt-1' : 'p-3',
      className,
    )}
    {...rest}
  >
    {title ? (
      /* Not uppercased: a title may carry a path or a URL, and `GET /API/STATUS`
         is not a thing anyone can type. Weight and colour carry the heading. */
      <legend className={cn('flex items-center gap-2 text-tui font-bold', STATUS_TEXT[tone])}>
        <span>{title}</span>
      </legend>
    ) : null}
    {/*
     * ratatui lets a Block carry a second title, right-aligned on the same
     * rule. That is where a count, a rate or a timestamp belongs: it is about
     * the frame, not about the content, and putting it inside the body would
     * make it compete with the numbers it is describing.
     */}
    {aside ? (
      <span className="pointer-events-none absolute -top-[10px] right-2 max-w-[60%] truncate bg-tui-base px-1 text-tui-sm text-tui-faint">
        {aside}
      </span>
    ) : null}
    <div className={cn('min-w-0', bodyClassName)}>{children}</div>
  </fieldset>
);

/* --------------------------------------------------------------------- row */

/**
 * A `label   value` line with the labels held in one column.
 *
 * The column is what makes a stack of these scannable; without it every value
 * starts at a different place and the eye has to search for each one.
 */
export const Row: React.FC<{
  label: React.ReactNode;
  /** Column width in characters. */
  labelWidth?: number;
  className?: string;
  children: React.ReactNode;
}> = ({ label, labelWidth = 16, className, children }) => (
  <div className={cn('flex items-baseline gap-2 text-tui', className)}>
    <span
      className="shrink-0 truncate text-tui-muted"
      style={{ width: `${labelWidth}ch` }}
      title={typeof label === 'string' ? label : undefined}
    >
      {label}
    </span>
    <span className="min-w-0 flex-1 text-tui-text">{children}</span>
  </div>
);

/** A horizontal rule drawn the way a TUI draws one. */
export const Rule: React.FC<{ className?: string; label?: React.ReactNode }> = ({
  className,
  label,
}) =>
  label ? (
    <div className={cn('flex items-center gap-2', className)}>
      <span className="h-px w-3 bg-tui-border-dim" aria-hidden="true" />
      <span className="text-tui-sm text-tui-faint">{label}</span>
      <span className="h-px flex-1 bg-tui-border-dim" aria-hidden="true" />
    </div>
  ) : (
    <div className={cn('h-px w-full bg-tui-border-dim', className)} aria-hidden="true" />
  );

/* ------------------------------------------------------------------ notice */

/**
 * An inline message. Colour and a one-character prefix carry the level; there
 * is no icon and no filled banner.
 */
export const Notice: React.FC<{
  tone?: StatusLevel;
  className?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}> = ({ tone = 'accent', className, children, action }) => {
  const prefix =
    tone === 'ok' ? GLYPH.check : tone === 'bad' ? GLYPH.cross : tone === 'warn' ? GLYPH.warn : '›';
  const border = TONE[tone].edgeL;

  return (
    <div
      className={cn(
        'flex items-start gap-2 border border-tui-border-dim border-l-2 bg-tui-mantle px-2 py-1.5 text-tui',
        border,
        className,
      )}
    >
      <span aria-hidden="true" className={cn('shrink-0 font-bold', STATUS_TEXT[tone])}>
        {prefix}
      </span>
      <div className="min-w-0 flex-1 leading-snug text-tui-text">{children}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
};
