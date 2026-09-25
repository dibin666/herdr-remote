import type React from 'react';
import { cn } from '../../utils/cn';
import { type StatusLevel, TONE_BG } from './tokens';

/* ---------------------------------------------------------------- settings */

/**
 * The one height every settings control shares.
 *
 * A select beside a segmented control beside a button reads as three widgets
 * from three kits the moment one of them is a few pixels taller, so they all
 * take their height from here instead of from their own padding.
 */
export const CONTROL_H = 'h-8';

/**
 * A group of settings under a coloured heading.
 *
 * The heading is the only accent-coloured text in a settings screen, so the
 * eye finds the groups first; `aside` is where a group's own "restore" lives,
 * on the heading rather than floating somewhere in its body.
 */
export const SettingSection: React.FC<{
  title: React.ReactNode;
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}> = ({ title, aside, className, children }) => (
  <section className={cn('min-w-0', className)}>
    <div className="flex min-h-[var(--tui-row)] items-center gap-2 border-b border-tui-border pb-1">
      <h3 className="text-tui font-bold text-tui-accent">{title}</h3>
      {aside ? <div className="ml-auto flex shrink-0 items-center gap-1">{aside}</div> : null}
    </div>
    <div className="divide-y divide-tui-border-dim">{children}</div>
  </section>
);

/**
 * `label / hint ........ [ control ]` — one setting.
 *
 * The words stay on the left and the control on the right, in a column of one
 * fixed width, so every control in a screen lines up and is the same size no
 * matter what kind it is. A phone has no room for two columns and stacks them.
 */
export const SettingRow: React.FC<{
  label: React.ReactNode;
  /** One short line. Anything longer belongs in documentation, not here. */
  hint?: React.ReactNode;
  /** Points the label at a native control inside `control`. */
  htmlFor?: string;
  control: React.ReactNode;
  className?: string;
}> = ({ label, hint, htmlFor, control, className }) => (
  <div className={cn('flex flex-col gap-1 py-1.5 sm:flex-row sm:items-center sm:gap-4', className)}>
    <div className="min-w-0 flex-1">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="block text-tui text-tui-text">
          {label}
        </label>
      ) : (
        <span className="block text-tui text-tui-text">{label}</span>
      )}
      {hint ? <span className="block text-tui-sm leading-snug text-tui-faint">{hint}</span> : null}
    </div>
    <div className="w-full shrink-0 sm:w-[18rem]">{control}</div>
  </div>
);

export interface SegmentOption<T extends string> {
  value: T;
  label: React.ReactNode;
}

const SEGMENT_CELL =
  'flex min-w-0 cursor-pointer select-none items-center justify-center px-1 text-tui transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-1 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-tui-text';

const SEGMENT_IDLE = 'text-tui-muted hover:bg-tui-selection hover:text-tui-text';

/**
 * One of a few, drawn as cells of equal width with the chosen one filled.
 *
 * Every cell is a native radio underneath, so the group keeps arrow-key
 * navigation and each choice keeps its accessible name; only the paint is
 * custom. The cells split the control's width evenly, which is what lets a
 * two-way and a three-way choice sit in the same column at the same size.
 */
export function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
  tone = 'accent',
  className,
  'aria-label': ariaLabel,
}: {
  name: string;
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  tone?: StatusLevel;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn('grid w-full border border-tui-border bg-tui-mantle', CONTROL_H, className)}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <label
            key={option.value}
            className={cn(
              SEGMENT_CELL,
              index > 0 && 'border-l border-tui-border',
              checked ? cn(TONE_BG[tone], 'font-bold text-tui-crust') : SEGMENT_IDLE,
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              className="sr-only"
              checked={checked}
              onChange={() => onChange(option.value)}
            />
            <span className="truncate">{option.label}</span>
          </label>
        );
      })}
    </div>
  );
}

/**
 * `关 | 开` — a boolean in the same cells as every other choice.
 *
 * One native checkbox carries the state and the name, so a screen reader hears
 * a single labelled checkbox and Space flips it. The two painted cells are
 * targets for a pointer: pressing the one already lit does nothing, which is
 * what a segmented switch promises and a bare checkbox would not keep.
 */
export const Toggle: React.FC<{
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The accessible name; the row's visible label says the same thing. */
  label: string;
  offLabel: string;
  onLabel: string;
  disabled?: boolean;
  className?: string;
}> = ({ checked, onChange, label, offLabel, onLabel, disabled = false, className }) => {
  const choose = (next: boolean) => (event: React.MouseEvent) => {
    event.preventDefault();
    if (disabled || next === checked) return;
    onChange(next);
  };
  return (
    <label
      className={cn(
        'grid w-full grid-cols-2 border border-tui-border bg-tui-mantle has-[:focus-visible]:outline has-[:focus-visible]:outline-1 has-[:focus-visible]:outline-tui-accent',
        CONTROL_H,
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      <input
        type="checkbox"
        className="sr-only"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span
        aria-hidden="true"
        onClick={choose(false)}
        className={cn(
          SEGMENT_CELL,
          !checked ? 'bg-tui-selection font-bold text-tui-text' : SEGMENT_IDLE,
        )}
      >
        {offLabel}
      </span>
      <span
        aria-hidden="true"
        onClick={choose(true)}
        className={cn(
          SEGMENT_CELL,
          'border-l border-tui-border',
          checked ? 'bg-tui-ok font-bold text-tui-crust' : SEGMENT_IDLE,
        )}
      >
        {onLabel}
      </span>
    </label>
  );
};

/**
 * A one-glyph button in a square cell: ↑ ↓ ↺ ✗ down the side of a list.
 *
 * Squares of one size, so a row's actions line up with the row above's, and a
 * red `danger` so the one that deletes never looks like the ones that move.
 */
export const IconButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'neutral' | 'danger' }
> = ({ variant = 'neutral', className, type = 'button', children, ...rest }) => (
  <button
    type={type}
    className={cn(
      'tui-focusable inline-flex h-7 w-7 shrink-0 select-none items-center justify-center border border-transparent text-tui transition-colors',
      'disabled:cursor-not-allowed disabled:text-tui-border disabled:hover:border-transparent disabled:hover:bg-transparent',
      variant === 'danger'
        ? 'text-tui-bad hover:border-tui-bad'
        : 'text-tui-muted hover:border-tui-border hover:text-tui-accent',
      className,
    )}
    {...rest}
  >
    {children}
  </button>
);
