import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSettings, useConnection } from '@/context/TerminalContext';
import { MobileControlSheet } from './MobileControlSheet';
import { describeConnection } from '@/connection/connectionStatus';
import { cn } from '@/shared/lib/cn';
import { Sep, StatusDot } from '@/shared/ui';
import { MobileStatusBar } from './MobileStatusBar';

export interface MobileTerminalShellProps {
  onOpenSettings: () => void;
  onAddProfile?: () => void;
}

/**
 * The phone shell: a top status row, a compact persistent bottom bar, and a
 * sheet holding everything else.
 *
 * The rows are TUI status lines, not floating pills — flat, square, full width,
 * and sitting on reserved terminal rows so they can never cover output.
 */
export const MobileTerminalShell: React.FC<MobileTerminalShellProps> = ({
  onOpenSettings,
  onAddProfile = () => {},
}) => {
  const { t } = useSettings();
  const { connectionState, isController } = useConnection();
  const [isOpen, setIsOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setIsOpen(false), []);

  /* A bottom sheet lets go the way a thumb expects: grabbed by its handle and
     pulled down. 64px of downward travel commits the close; less snaps back. */
  const dragStartYRef = useRef<number | null>(null);
  const sheetDragRef = useRef(0);
  const onSheetTouchStart = useCallback((event: React.TouchEvent) => {
    dragStartYRef.current = event.touches[0]?.clientY ?? null;
    sheetDragRef.current = 0;
  }, []);
  const onSheetTouchMove = useCallback((event: React.TouchEvent) => {
    if (dragStartYRef.current === null) return;
    const dy = (event.touches[0]?.clientY ?? 0) - dragStartYRef.current;
    sheetDragRef.current = Math.max(0, dy);
    if (sheetRef.current && dy > 0) {
      sheetRef.current.style.transform = `translateY(${dy}px)`;
    }
  }, []);
  const onSheetTouchEnd = useCallback(() => {
    const dy = sheetDragRef.current;
    dragStartYRef.current = null;
    sheetDragRef.current = 0;
    if (sheetRef.current) sheetRef.current.style.transform = '';
    if (dy > 64) close();
  }, [close]);

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
        className="pointer-events-none absolute inset-x-0 top-0 z-40 flex h-8 items-center justify-between gap-2 border-b border-tui-border bg-tui-mantle px-2 text-tui"
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
            status.needsAttention || !isController
              ? 'border-tui-warn text-tui-warn'
              : 'border-tui-border text-tui-muted',
          )}
        >
          {!isController && <span className="max-w-[8rem] truncate">{t('common.viewer')}</span>}
          <span aria-hidden="true" className="text-tui">
            ☰
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
            {/* The grab strip: pulling it down closes the sheet, the gesture
                every other bottom sheet on the phone already taught. */}
            <div
              data-testid="mobile-sheet-handle"
              aria-hidden="true"
              className="flex touch-none items-start justify-center pb-1 pt-1.5"
              onTouchStart={onSheetTouchStart}
              onTouchMove={onSheetTouchMove}
              onTouchEnd={onSheetTouchEnd}
              onTouchCancel={onSheetTouchEnd}
            >
              <span className="h-1 w-9 bg-tui-border-bright" />
            </div>
            <MobileControlSheet
              onClose={close}
              onOpenSettings={() => {
                close();
                onOpenSettings();
              }}
            />
          </div>
        </>
      )}
      <MobileStatusBar onAddProfile={onAddProfile} />
    </>
  );
};
