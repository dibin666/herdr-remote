import React from 'react';
import { cn } from '../../utils/cn';
import { GLYPH } from './tokens';

/* ------------------------------------------------------------------ fields */

export const FieldLabel: React.FC<{
  htmlFor?: string;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}> = ({ htmlFor, hint, className, children }) => (
  <label htmlFor={htmlFor} className={cn('block text-tui-sm font-bold text-tui-muted', className)}>
    {children}
    {hint ? <span className="ml-2 font-normal text-tui-faint">{hint}</span> : null}
  </label>
);

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...rest }, ref) => (
  <input ref={ref} className={cn('tui-input w-full px-2 py-1 text-tui', className)} {...rest} />
));
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
      className,
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
        !disabled && 'group-hover:text-tui-accent',
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
      className,
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
        !disabled && 'group-hover:text-tui-accent',
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
      className,
    )}
    {...rest}
  >
    <span
      aria-hidden="true"
      className={cn(
        'shrink-0',
        selected ? 'text-tui-accent' : 'text-transparent group-hover:text-tui-accent',
      )}
    >
      {GLYPH.cursor}
    </span>
    <span className="min-w-0 flex-1 truncate">{children}</span>
  </button>
);
