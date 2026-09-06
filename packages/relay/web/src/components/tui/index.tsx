/**
 * The TUI kit.
 *
 * Every screen in this client is built from these pieces, so the browser UI and
 * the `herdr-remote` configuration TUI look like two views of one program
 * rather than two products. The rules they encode are the ones a terminal
 * interface has no choice about:
 *
 *   - one monospace family, one type size, everything on the character grid,
 *     and never any letter-spacing: a cell is a fixed box, and tracking a CJK
 *     run out is the fastest way to stop looking like a terminal;
 *   - hierarchy is weight and colour, not size;
 *   - frames are box-drawing rules, never cards — no radius, no shadow, no fill
 *     gradient;
 *   - state is a glyph plus a colour (`●` up, `○` idle, `▸` here), never a pill;
 *   - a control is text in brackets: `[ save ]`, `[x] enabled`, `(•) chosen`;
 *   - colour appears only where it means something, on Herdr's own palette.
 *
 * Decorative glyphs are `aria-hidden`, so `[ ]` brackets and status dots never
 * reach an accessible name: a button called "Save" is still called "Save".
 */

import React from 'react';
import { createPortal } from 'react-dom';
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
} as const;

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

const STATUS_TEXT: Record<StatusLevel, string> = {
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
  <span aria-hidden="true" className={cn('select-none leading-none', STATUS_TEXT[level], className)}>
    {level === 'idle' ? GLYPH.off : GLYPH.on}
  </span>
);

/** The `·` Herdr uses between values on a single row. */
export const Sep: React.FC<{ className?: string }> = ({ className }) => (
  <span aria-hidden="true" className={cn('select-none text-tui-faint', className)}>
    {GLYPH.dot}
  </span>
);

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
      'tui-panel min-w-0 border border-tui-border bg-tui-base',
      title ? 'px-3 pb-3 pt-1' : 'p-3',
      className
    )}
    {...rest}
  >
    {title ? (
      <legend className={cn('flex items-center gap-2 text-tui font-bold', STATUS_TEXT[tone])}>
        <span>{title}</span>
        {aside ? <span className="font-normal text-tui-faint">{aside}</span> : null}
      </legend>
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

/* ------------------------------------------------------------------ button */

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'warn' | 'ghost';

const BUTTON_TONE: Record<ButtonVariant, string> = {
  default:
    'border-tui-border text-tui-text hover:border-tui-accent hover:text-tui-accent active:bg-tui-selection',
  primary:
    'border-tui-accent text-tui-accent hover:bg-tui-accent hover:text-tui-crust active:bg-tui-accent-dim',
  danger:
    'border-tui-bad text-tui-bad hover:bg-tui-bad hover:text-tui-crust active:bg-tui-bad',
  warn: 'border-tui-warn text-tui-warn hover:bg-tui-warn hover:text-tui-crust active:bg-tui-warn',
  ghost:
    'border-transparent text-tui-muted hover:text-tui-accent hover:border-tui-border active:bg-tui-selection',
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
      className
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
      className
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
  <nav className={cn('flex items-center gap-3', className)} aria-label={ariaLabel}>
    {tabs.map((tab) => {
      const active = tab.id === activeId;
      return (
        <button
          key={tab.id}
          type="button"
          onClick={() => onSelect(tab.id)}
          aria-current={active ? 'page' : undefined}
          aria-label={tab.ariaLabel ?? tab.label}
          title={tab.title}
          className={cn(
            'tui-focusable select-none whitespace-nowrap border-b px-0.5 pb-0.5 text-tui transition-colors',
            active
              ? 'border-tui-accent font-bold text-tui-accent'
              : 'border-transparent text-tui-muted hover:border-tui-border-bright hover:text-tui-text'
          )}
        >
          {tab.index !== undefined ? (
            <span aria-hidden="true" className={cn('text-tui-faint', active && 'text-tui-accent')}>
              {tab.index}
            </span>
          ) : null}
          <span aria-hidden="true" className={cn('ml-1', labelClassName)}>
            {tab.label}
          </span>
        </button>
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
      className
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

/* ------------------------------------------------------------------ fields */

export const FieldLabel: React.FC<{
  htmlFor?: string;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}> = ({ htmlFor, hint, className, children }) => (
  <label
    htmlFor={htmlFor}
    className={cn('block text-tui-sm font-bold text-tui-muted', className)}
  >
    {children}
    {hint ? <span className="ml-2 font-normal text-tui-faint">{hint}</span> : null}
  </label>
);

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...rest }, ref) => (
    <input ref={ref} className={cn('tui-input w-full px-2 py-1 text-tui', className)} {...rest} />
  )
);
Input.displayName = 'Input';

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...rest }, ref) => (
  <select ref={ref} className={cn('tui-input w-full px-2 py-1 text-tui', className)} {...rest}>
    {children}
  </select>
));
Select.displayName = 'Select';

/**
 * `[x] label` — a checkbox drawn the only way a terminal can draw one.
 *
 * The real `<input type="checkbox">` stays in the tree, visually hidden, so the
 * control keeps native semantics, keyboard behaviour and form participation;
 * the glyph is what is painted.
 */
export const Checkbox: React.FC<{
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: React.ReactNode;
  description?: React.ReactNode;
  className?: string;
  id?: string;
}> = ({ checked, onChange, disabled = false, label, description, className, id }) => (
  <label
    className={cn(
      'group flex cursor-pointer select-none items-start gap-2 py-0.5 text-tui',
      disabled && 'cursor-not-allowed opacity-60',
      className
    )}
  >
    <input
      id={id}
      type="checkbox"
      className="sr-only"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
    <span
      aria-hidden="true"
      className={cn(
        'mt-px shrink-0 font-bold leading-tight',
        checked ? 'text-tui-ok' : 'text-tui-faint',
        !disabled && 'group-hover:text-tui-accent'
      )}
    >
      {checked ? '[x]' : '[ ]'}
    </span>
    <span className="min-w-0 flex-1">
      <span className={cn('block', checked ? 'text-tui-text' : 'text-tui-muted')}>{label}</span>
      {description ? (
        <span className="mt-0.5 block text-tui-sm leading-snug text-tui-faint">{description}</span>
      ) : null}
    </span>
  </label>
);

/** `(•) label` — one of a set. */
export const Radio: React.FC<{
  checked: boolean;
  onChange: () => void;
  name: string;
  disabled?: boolean;
  label: React.ReactNode;
  description?: React.ReactNode;
  className?: string;
}> = ({ checked, onChange, name, disabled = false, label, description, className }) => (
  <label
    className={cn(
      'group flex cursor-pointer select-none items-start gap-2 py-0.5 text-tui',
      disabled && 'cursor-not-allowed opacity-60',
      className
    )}
  >
    <input
      type="radio"
      name={name}
      className="sr-only"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
    />
    <span
      aria-hidden="true"
      className={cn(
        'mt-px shrink-0 font-bold leading-tight',
        checked ? 'text-tui-accent' : 'text-tui-faint',
        !disabled && 'group-hover:text-tui-accent'
      )}
    >
      {checked ? '(•)' : '( )'}
    </span>
    <span className="min-w-0 flex-1">
      <span className={cn('block', checked ? 'text-tui-text' : 'text-tui-muted')}>{label}</span>
      {description ? (
        <span className="mt-0.5 block text-tui-sm leading-snug text-tui-faint">{description}</span>
      ) : null}
    </span>
  </label>
);

/* ------------------------------------------------------------- selectable */

/**
 * One row of a list, with the cursor in front of it.
 *
 * Hover and keyboard focus put the cursor in the same place, because in a TUI
 * there is only ever one cursor and it is unambiguous what Enter would do.
 */
export const Selectable: React.FC<{
  selected?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  className?: string;
  title?: string;
  'aria-label'?: string;
  children: React.ReactNode;
}> = ({ selected = false, disabled = false, onSelect, className, children, ...rest }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onSelect}
    className={cn(
      'tui-focusable group flex w-full select-none items-center gap-2 px-1 py-0.5 text-left text-tui transition-colors',
      disabled
        ? 'cursor-not-allowed text-tui-faint'
        : selected
          ? 'bg-tui-selection font-bold text-tui-accent'
          : 'text-tui-muted hover:bg-tui-selection hover:text-tui-text',
      className
    )}
    {...rest}
  >
    <span
      aria-hidden="true"
      className={cn(
        'shrink-0',
        selected ? 'text-tui-accent' : 'text-transparent group-hover:text-tui-accent'
      )}
    >
      {GLYPH.cursor}
    </span>
    <span className="min-w-0 flex-1 truncate">{children}</span>
  </button>
);

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
      <span className="text-tui-border">{GLYPH.meterEmpty.repeat(Math.max(0, width - filled))}</span>
    </span>
  );
};

/* ------------------------------------------------------------------- table */

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  /** Width in characters; omit to let the column take what is left. */
  width?: number;
  align?: 'left' | 'right';
  className?: string;
  render: (item: T, index: number) => React.ReactNode;
}

/**
 * A table with rules instead of zebra stripes.
 *
 * The heading is uppercase and dim; a hovered row is inverse-video, exactly as
 * a selected row is in the Herdr sidebar.
 */
export function Table<T>({
  columns,
  items,
  rowKey,
  empty,
  className,
}: {
  columns: Column<T>[];
  items: T[];
  rowKey: (item: T, index: number) => string;
  empty: React.ReactNode;
  className?: string;
}) {
  if (items.length === 0) {
    return (
      <div className={cn('px-1 py-4 text-center text-tui text-tui-faint', className)}>{empty}</div>
    );
  }

  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <table className="w-full border-collapse text-tui">
        <thead>
          <tr className="border-b border-tui-border">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.width ? { width: `${column.width}ch` } : undefined}
                className={cn(
                  'whitespace-nowrap px-2 py-1 text-tui-sm font-bold text-tui-muted',
                  column.align === 'right' ? 'text-right' : 'text-left',
                  column.className
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr
              key={rowKey(item, index)}
              className="border-b border-tui-border-dim last:border-b-0 hover:bg-tui-selection"
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cn(
                    'px-2 py-1 align-top text-tui-text',
                    column.align === 'right' ? 'text-right' : 'text-left',
                    column.className
                  )}
                >
                  {column.render(item, index)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------- modal */

/**
 * A modal drawn as a panel floating over a dimmed terminal.
 *
 * The title sits in the top rule with `[esc]` closing it from the right end,
 * which is where a TUI puts the way out.
 */
export const Modal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  title: string;
  /** Right of the title, before the close control. */
  subtitle?: React.ReactNode;
  closeLabel: string;
  footer?: React.ReactNode;
  hints?: KeyHint[];
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  children: React.ReactNode;
}> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  closeLabel,
  footer,
  hints,
  size = 'md',
  className,
  children,
}) => {
  if (!isOpen) return null;

  const width = size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-3xl' : 'max-w-xl';
  const titleId = `tui-modal-${title.replace(/\s+/g, '-').toLowerCase()}`;

  const modal = (
    <div
      className="fixed inset-0 inset-x-0 z-50 grid place-items-center overflow-y-auto bg-tui-crust/85 p-3 sm:p-6"
      style={{ height: 'var(--app-height, 100dvh)', width: '100vw' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          'flex w-full flex-col border border-tui-border bg-tui-base',
          width,
          className
        )}
        style={{ maxHeight: 'calc(var(--app-height, 100dvh) - 1.5rem)' }}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-tui-border bg-tui-mantle px-3 py-1.5">
          <h2
            id={titleId}
            className="truncate text-tui font-bold text-tui-accent"
          >
            {title}
          </h2>
          {subtitle ? (
            <span className="min-w-0 flex-1 truncate text-tui-sm text-tui-faint">{subtitle}</span>
          ) : (
            <span className="flex-1" />
          )}
          <Button variant="ghost" onClick={onClose} aria-label={closeLabel} title={closeLabel}>
            esc
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">{children}</div>

        {footer || hints ? (
          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-tui-border bg-tui-mantle px-3 py-1.5">
            {hints ? <KeyHints hints={hints} /> : <span />}
            {footer ? <div className="flex items-center gap-2">{footer}</div> : null}
          </footer>
        ) : null}
      </div>
    </div>
  );

  // Portalling the frame to body keeps centering independent of the app shell's
  // clipped flex layout. On mobile the terminal layer is intentionally
  // overflow-hidden; a dialog must still center against the visible viewport.
  return typeof document === 'undefined' ? modal : createPortal(modal, document.body);
};

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
        className
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
      className
    )}
  >
    {children}
  </span>
);

/* ---------------------------------------------------------------- segments */

/**
 * Values joined by `·`, the separator Herdr uses between tokens on one row.
 *
 * A status area is a single line of text, not a row of chips: falsy entries and
 * the separator that would have preceded them disappear, exactly as an unset
 * sidebar token does in Herdr.
 */
export const Segments: React.FC<{
  items: React.ReactNode[];
  className?: string;
}> = ({ items, className }) => {
  const visible = items.filter(Boolean);
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      {visible.map((item, index) => (
        <React.Fragment key={index}>
          {index > 0 ? <Sep className="shrink-0" /> : null}
          {item}
        </React.Fragment>
      ))}
    </span>
  );
};

/* ------------------------------------------------------------- status line */

/**
 * The bottom line of the screen.
 *
 * Every terminal multiplexer ends its display with one: session facts on the
 * left, the keys that work here on the right. Putting the session's identity
 * down here instead of in a top bar is what frees the top of the window to be
 * nothing but the program's name and its tabs — which is the shape Herdr's own
 * tab bar and status area have.
 */
export const StatusLine: React.FC<{
  left?: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}> = ({ left, right, className }) => (
  <footer
    className={cn(
      'flex h-[var(--tui-row)] w-full shrink-0 items-center justify-between gap-3 overflow-hidden border-t border-tui-border bg-tui-mantle px-2 text-tui-sm',
      className
    )}
  >
    <div className="flex min-w-0 items-center gap-1.5 text-tui-muted">{left}</div>
    <div className="flex shrink-0 items-center gap-3">{right}</div>
  </footer>
);

/* ----------------------------------------------------------------- appframe */

/**
 * The shape every full-screen view in this client takes.
 *
 * It is the layout of the `herdr-remote` configuration TUI, transposed:
 *
 *     herdr-remote  control the web terminal        ← program line
 *     1 OVERVIEW  2 CLIENTS  3 PTYS                 ← numbered tabs
 *     ┌─ OVERVIEW ──────────────────────┐      ← body, fills the rest
 *     │ mode          local network       │
 *     └──────────────────────────────┘
 *     esc back · enter select                       ← key hints
 *
 * The chrome rows are fixed and only the body scrolls, so the program line and
 * the hints stay where they are put: a terminal never scrolls its own frame
 * away, and a view that did would stop reading as one screen.
 */
export const AppFrame: React.FC<{
  /** The program, bold, first thing on the first line. */
  name: string;
  tagline?: React.ReactNode;
  /** Right end of the program line: the tmux-style status area. */
  aside?: React.ReactNode;
  tabs?: TabDescriptor[];
  activeTabId?: string;
  onSelectTab?: (id: string) => void;
  tabsAriaLabel?: string;
  hints?: KeyHint[];
  /** Right end of the hint line. */
  footerAside?: React.ReactNode;
  bodyClassName?: string;
  className?: string;
  children: React.ReactNode;
}> = ({
  name,
  tagline,
  aside,
  tabs,
  activeTabId,
  onSelectTab,
  tabsAriaLabel,
  hints,
  footerAside,
  bodyClassName,
  className,
  children,
}) => (
  <div className={cn('flex h-full min-h-0 w-full flex-col bg-tui-crust', className)}>
    <div className="flex h-[var(--tui-row)] shrink-0 items-center justify-between gap-3 overflow-hidden border-b border-tui-border bg-tui-mantle px-2 text-tui">
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-bold text-tui-accent">{name}</span>
        {tagline ? (
          <span className="hidden truncate text-tui-sm text-tui-faint sm:block">{tagline}</span>
        ) : null}
      </span>
      {aside ? <span className="flex shrink-0 items-center gap-2">{aside}</span> : null}
    </div>

    {tabs && tabs.length > 0 && activeTabId !== undefined && onSelectTab ? (
      <div className="scrollbar-none shrink-0 overflow-x-auto border-b border-tui-border bg-tui-mantle px-2">
        <Tabs
          tabs={tabs}
          activeId={activeTabId}
          onSelect={onSelectTab}
          ariaLabel={tabsAriaLabel}
          className="gap-3"
        />
      </div>
    ) : null}

    <div className={cn('min-h-0 flex-1 overflow-y-auto p-2', bodyClassName)}>{children}</div>

    {hints || footerAside ? (
      <StatusLine left={hints ? <KeyHints hints={hints} /> : null} right={footerAside} />
    ) : null}
  </div>
);

/* --------------------------------------------------------------- spinner */

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Braille spinner, the one every terminal program uses. */
export const Spinner: React.FC<{ className?: string; label?: string }> = ({
  className,
  label,
}) => {
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
