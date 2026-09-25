import React from 'react';
import { cn } from '../../utils/cn';
import { GLYPH, STATUS_TEXT, StatusDot, type StatusLevel } from './tokens';

/* ------------------------------------------------------------------ button */

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'warn' | 'ghost';

const BUTTON_TONE: Record<ButtonVariant, string> = {
  default:
    'border-tui-border text-tui-text hover:border-tui-accent hover:text-tui-accent active:bg-tui-selection',
  primary:
    'border-tui-accent text-tui-accent hover:bg-tui-accent hover:text-tui-crust active:bg-tui-accent-dim',
  danger: 'border-tui-bad text-tui-bad hover:bg-tui-bad hover:text-tui-crust active:bg-tui-bad',
  warn: 'border-tui-warn text-tui-warn hover:bg-tui-warn hover:text-tui-crust active:bg-tui-warn',
  ghost:
    'border-transparent text-tui-muted hover:text-tui-accent hover:border-tui-border active:bg-tui-selection disabled:border-transparent',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Wrap the label in `[ ]`, the way a TUI marks an activatable word. */
  brackets?: boolean;
  /** A leading glyph. Decorative: it never joins the accessible name. */
  glyph?: string;
  block?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'default',
  brackets = true,
  glyph,
  block = false,
  className,
  children,
  type = 'button',
  ...rest
}) => (
  <button
    type={type}
    className={cn(
      'tui-focusable inline-flex select-none items-center justify-center gap-1.5 border bg-transparent px-2 py-0.5 text-tui font-medium transition-colors',
      'disabled:cursor-not-allowed disabled:border-tui-border-dim disabled:text-tui-faint disabled:hover:bg-transparent',
      BUTTON_TONE[variant],
      block && 'w-full',
      className,
    )}
    {...rest}
  >
    {brackets ? (
      <span aria-hidden="true" className="opacity-60">
        [
      </span>
    ) : null}
    {glyph ? (
      <span aria-hidden="true" className="leading-none">
        {glyph}
      </span>
    ) : null}
    <span className="truncate">{children}</span>
    {brackets ? (
      <span aria-hidden="true" className="opacity-60">
        ]
      </span>
    ) : null}
  </button>
);

/* ------------------------------------------------------------------- badge */

/**
 * A word carrying state. Not a pill: a TUI cannot fill a rounded shape, so this
 * is bracketed, coloured text on the same line as everything else.
 */
export const Badge: React.FC<{
  tone?: StatusLevel;
  dot?: boolean;
  className?: string;
  children: React.ReactNode;
}> = ({ tone = 'accent', dot = false, className, children }) => (
  <span
    className={cn(
      'inline-flex select-none items-center gap-1 whitespace-nowrap text-tui font-bold uppercase',
      STATUS_TEXT[tone],
      className,
    )}
  >
    {dot ? <StatusDot level={tone} /> : null}
    {children}
  </span>
);

/* -------------------------------------------------------------------- tabs */

export interface TabDescriptor {
  id: string;
  label: string;
  /** Shown before the label, as Herdr numbers its own tabs. */
  index?: number;
  /** Used verbatim as the accessible name; defaults to `label`. */
  ariaLabel?: string;
  title?: string;
}

/**
 * `1 TERMINAL  2 ADMIN` — numbered, underlined where you are.
 *
 * The numbers are not decoration: they are the keys that switch tabs in the
 * `herdr-remote` TUI, so the same mental model transfers to the browser.
 */
export const Tabs: React.FC<{
  tabs: TabDescriptor[];
  activeId: string;
  onSelect: (id: string) => void;
  ariaLabel?: string;
  className?: string;
  /**
   * Classes applied to the label text only. A narrow header can hide the word
   * and keep the number; the accessible name comes from `aria-label`, so what
   * is painted never changes what the tab is called.
   */
  labelClassName?: string;
}> = ({ tabs, activeId, onSelect, ariaLabel, className, labelClassName }) => (
  <nav className={cn('flex items-center gap-2', className)} aria-label={ariaLabel}>
    {tabs.map((tab, index) => {
      const active = tab.id === activeId;
      return (
        <React.Fragment key={tab.id}>
          {/* ratatui separates tabs with `│`, which is what stops a row of
            numbered words from reading as one sentence. */}
          {index > 0 ? (
            <span aria-hidden="true" className="select-none text-tui-border">
              {GLYPH.tabDivider}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => onSelect(tab.id)}
            aria-current={active ? 'page' : undefined}
            aria-label={tab.ariaLabel ?? tab.label}
            title={tab.title}
            className={cn(
              'tui-focusable select-none whitespace-nowrap border-b px-0.5 pb-0.5 text-tui transition-colors',
              active
                ? 'border-tui-accent font-bold text-tui-accent'
                : 'border-transparent text-tui-muted hover:border-tui-border-bright hover:text-tui-text',
            )}
          >
            {tab.index !== undefined ? (
              <span
                aria-hidden="true"
                className={cn('text-tui-faint', active && 'text-tui-accent')}
              >
                {tab.index}
              </span>
            ) : null}
            <span aria-hidden="true" className={cn('ml-1', labelClassName)}>
              {tab.label}
            </span>
          </button>
        </React.Fragment>
      );
    })}
  </nav>
);

/* -------------------------------------------------------------- key hints */

export interface KeyHint {
  /** The key cap, e.g. `esc`, `↑↓`, `enter`. */
  keys: string;
  /** What it does. */
  action: string;
}

/** The status line every TUI ends with: `esc close · enter submit`. */
export const KeyHints: React.FC<{ hints: KeyHint[]; className?: string }> = ({
  hints,
  className,
}) => (
  <div
    className={cn(
      'flex flex-wrap items-center gap-x-3 gap-y-0.5 text-tui-sm text-tui-faint',
      className,
    )}
  >
    {hints.map((hint, index) => (
      <span key={`${hint.keys}-${index}`} className="flex items-center gap-1">
        <kbd className="border border-tui-border-dim px-1 not-italic text-tui-muted">
          {hint.keys}
        </kbd>
        <span>{hint.action}</span>
      </span>
    ))}
  </div>
);

/* ------------------------------------------------------------------ keycap */

/** A key drawn as a cap: the toolbar's unit, and the help line's. */
export const KeyCap: React.FC<{
  active?: boolean;
  className?: string;
  children: React.ReactNode;
}> = ({ active = false, className, children }) => (
  <span
    className={cn(
      'inline-flex min-w-[2ch] select-none items-center justify-center border px-1 text-tui',
      active
        ? 'border-tui-accent bg-tui-accent text-tui-crust'
        : 'border-tui-border bg-tui-surface text-tui-muted',
      className,
    )}
  >
    {children}
  </span>
);
