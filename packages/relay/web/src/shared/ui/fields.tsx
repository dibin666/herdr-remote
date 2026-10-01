import React from 'react';
import { cn } from '@/shared/lib/cn';

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
