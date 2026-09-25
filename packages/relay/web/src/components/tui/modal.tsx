import type React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../utils/cn';
import { Button, type KeyHint, KeyHints } from './buttons';

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
  /**
   * Hold the dialog at one height whatever its body holds. A tabbed dialog
   * needs it: sized to its content, the frame jumped every time a tab with a
   * different amount on it was chosen.
   */
  fixedHeight?: boolean;
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
  fixedHeight = false,
  className,
  children,
}) => {
  if (!isOpen) return null;

  const width = size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-3xl' : 'max-w-xl';
  const titleId = `tui-modal-${title.replace(/\s+/g, '-').toLowerCase()}`;

  // Only the body scrolls. The frame is clipped and the panel is capped to the
  // frame's padded box, so no wheel can carry the whole dialog off the top of
  // the screen. Absolutely positioned descendants — every `sr-only` field — are
  // anchored inside the panel: anchored to the fixed frame, a row scrolled out
  // of a list left its hidden label behind and made the frame taller than the
  // screen.
  const modal = (
    <div
      className="fixed inset-0 inset-x-0 z-50 flex items-center justify-center overflow-hidden bg-tui-crust/85 p-3 sm:p-6"
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
          'relative flex max-h-full w-full flex-col border border-tui-border bg-tui-base',
          width,
          fixedHeight && 'h-[46rem]',
          className,
        )}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-tui-border bg-tui-mantle px-3 py-1.5">
          <h2 id={titleId} className="truncate text-tui font-bold text-tui-accent">
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

        <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
          {children}
        </div>

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
