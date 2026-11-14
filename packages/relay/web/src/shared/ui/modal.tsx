import type React from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { attachWebUIShortcuts } from '@/shared/keys/dialogEscape';
import { cn } from '@/shared/lib/cn';
import { Button, type KeyHint, KeyHints } from './buttons';

/* ------------------------------------------------------------------- modal */

/** The dialogs on screen, outermost first. Escape belongs to the last one. */
const openModals: object[] = [];

interface ModalProps {
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
}

/**
 * A modal drawn as a panel floating over a dimmed terminal.
 *
 * The title sits in the top rule with `[esc]` closing it from the right end,
 * which is where a TUI puts the way out.
 */
export const Modal: React.FC<ModalProps> = (props) =>
  props.isOpen ? <ModalFrame {...props} /> : null;

const ModalFrame: React.FC<ModalProps> = ({
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
  const width = size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-3xl' : 'max-w-xl';
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Every dialog answers the `esc` its title bar shows, and only the one on
  // top: a picker opened from Settings closes alone, not Settings with it.
  useEffect(() => {
    const entry = {};
    openModals.push(entry);
    const detach = attachWebUIShortcuts(
      {
        onCloseModals: () => {
          if (openModals[openModals.length - 1] === entry) onCloseRef.current();
        },
      },
      { isModalOpen: true },
    );
    return () => {
      detach();
      openModals.splice(openModals.indexOf(entry), 1);
    };
  }, []);

  // Read while rendering: by the time an effect runs, a field with autoFocus
  // inside the dialog has already taken focus from what was behind it.
  const [openedFrom] = useState(() =>
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  // Left on the terminal, focus kept sending every key typed "into" the dialog
  // to the workstation, and kept a phone's keyboard up over half of it.
  useEffect(() => {
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
    return () => {
      if (openedFrom?.isConnected) openedFrom.focus({ preventScroll: true });
    };
  }, [openedFrom]);

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
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          'relative flex max-h-full w-full flex-col border border-tui-border bg-tui-base focus:outline-none',
          width,
          fixedHeight && 'h-[46rem]',
          className,
        )}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-tui-border bg-tui-mantle px-3 py-1.5">
          {/* Where the subtitle does not fit beside the title it drops to its
              own line: an ellipsis on a phone left three words of it. */}
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
            <h2 id={titleId} className="break-words text-tui-lg font-bold text-tui-accent">
              {title}
            </h2>
            {subtitle ? (
              <span className="min-w-0 break-words text-tui-sm text-tui-faint">{subtitle}</span>
            ) : null}
          </div>
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
