import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTerminal } from '../context/TerminalContext';
import { MobileControlSheet } from './MobileControlSheet';
import { describeConnection } from '../utils/connectionStatus';
import { cn } from '../utils/cn';
import { GLYPH, Sep, StatusDot } from './tui';

export interface MobileTerminalShellProps {
  onNavigateAdmin: () => void;
  /** False on operator-facing relays; hides the dashboard shortcut. */
  showAdminEntry?: boolean;
  onOpenPairing: () => void;
  onOpenSettings: () => void;
  onAddProfile?: () => void;
}

/**
 * The phone shell: one status row and a sheet holding everything else.
 *
 * The row is a TUI status line, not a floating pill — flat, square, the full
 * width of the screen, sitting on its own reserved terminal row so it can never
 * cover the first line of output the way an overlay did.
 */
export const MobileTerminalShell: React.FC<MobileTerminalShellProps> = ({
  onNavigateAdmin,
  showAdminEntry = true,
  onOpenPairing,
  onOpenSettings,
  onAddProfile = () => {},
}) => {
  const { connectionState, isController, t } = useTerminal();
  const [isOpen, setIsOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // With any modifier (Ctrl, Alt, Meta), NEVER intercept or stopPropagation/preventDefault
      if (event.ctrlKey || event.altKey || event.metaKey) {
        return;
      }
      if (event.key === 'Escape') {
        const target = event.target as Element | null;
        const isFromTerminal =
          target &&
          typeof target.closest === 'function' &&
          Boolean(target.closest('#terminal-container'));

        if (!isFromTerminal) {
          event.stopPropagation();
          event.preventDefault();
          close();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, close]);

  useEffect(() => {
    // `preventScroll`, because focusing a sheet pinned to the bottom of a phone
    // screen otherwise asks the browser to scroll it into view — and the page
    // visibly jumps to satisfy a request nothing needed.
    if (isOpen) sheetRef.current?.focus({ preventScroll: true });
  }, [isOpen]);

  const status = describeConnection(connectionState, t);

  return (
    <>
      {/*
       * Reserve a real top row for mobile chrome. An overlaid pill hid xterm's
       * first rows, which is where Herdr paints its own tab bar — the top of
       * the screen looked like two unrelated interfaces stacked together.
       */}
      <div
        data-testid="mobile-topbar"
        role="toolbar"
        aria-label={t('mobile.sessionControls')}
        className="pointer-events-none absolute inset-x-0 top-0 z-40 flex h-12 items-center justify-between gap-2 border-b border-tui-border bg-tui-mantle px-2 text-tui"
      >
        <div className="flex min-w-0 items-center gap-1.5 text-tui-sm text-tui-muted">
          <span aria-hidden="true" className="shrink-0 font-bold text-tui-accent">
            herdr
          </span>
          <Sep className="shrink-0" />
          <StatusDot level={status.level} />
          <span className="truncate uppercase">{status.label}</span>
        </div>

        <button
          type="button"
          data-testid="mobile-chrome-trigger"
          onClick={() => setIsOpen(true)}
          aria-label={t('mobile.sessionControls')}
          aria-expanded={isOpen}
          aria-haspopup="dialog"
          className={cn(
            'tui-focusable pointer-events-auto flex h-9 shrink-0 select-none items-center gap-1.5 border px-2 text-tui uppercase transition-colors',
            status.needsAttention
              ? 'border-tui-warn text-tui-warn'
              : isController
                ? 'border-tui-border text-tui-muted'
                : 'border-tui-accent text-tui-accent'
          )}
        >
          {!isController && !status.needsAttention && (
            <span className="max-w-[8rem] truncate">{t('common.viewer')}</span>
          )}
          <span aria-hidden="true" className="text-tui">
            {GLYPH.chevronDown}
          </span>
          <span aria-hidden="true">{t('mobile.menu')}</span>
        </button>
      </div>

      {isOpen && (
        <>
          <div
            data-testid="mobile-sheet-scrim"
            className="absolute inset-0 z-40 bg-tui-crust/70"
            onClick={close}
            aria-hidden="true"
          />

          <div
            ref={sheetRef}
            data-testid="mobile-control-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={t('mobile.sessionControls')}
            tabIndex={-1}
            className="herdr-sheet absolute inset-x-0 bottom-0 z-50 max-h-[85%] overflow-y-auto border-t border-tui-border bg-tui-base pb-3 focus:outline-none"
          >
            <MobileControlSheet
              onClose={close}
              showAdminEntry={showAdminEntry}
              onNavigateAdmin={() => {
                close();
                onNavigateAdmin();
              }}
              onOpenPairing={() => {
                close();
                onOpenPairing();
              }}
              onOpenSettings={() => {
                close();
                onOpenSettings();
              }}
              onAddProfile={() => {
                close();
                onAddProfile();
              }}
            />
          </div>
        </>
      )}
    </>
  );
};
