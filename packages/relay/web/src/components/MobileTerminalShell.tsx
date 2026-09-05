import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTerminal } from '../context/TerminalContext';
import { MobileControlSheet } from './MobileControlSheet';
import { describeConnection } from '../utils/connectionStatus';
import { Sliders, Terminal as TerminalIcon } from 'lucide-react';
import { cn } from '../utils/cn';

export interface MobileTerminalShellProps {
  onNavigateAdmin: () => void;
  onOpenPairing: () => void;
  onOpenSettings: () => void;
}

export const MobileTerminalShell: React.FC<MobileTerminalShellProps> = ({
  onNavigateAdmin,
  onOpenPairing,
  onOpenSettings,
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
    if (isOpen) sheetRef.current?.focus();
  }, [isOpen]);

  const status = describeConnection(connectionState, t);

  return (
    <>
      {/*
       * Reserve a real top row for mobile chrome. The old pill floated over
       * xterm's first rows, which hid Herdr's own tab/switch controls and made
       * the top of the terminal look like two unrelated interfaces were
       * stacked on top of each other.
       */}
      <div
        data-testid="mobile-topbar"
        role="toolbar"
        aria-label={t('mobile.sessionControls')}
        className="pointer-events-none absolute inset-x-0 top-0 z-40 flex h-12 items-center justify-between border-b border-sand-300/80 bg-paper/95 px-3 shadow-sm backdrop-blur-md dark:border-charcoal-700/80 dark:bg-charcoal-900/95"
      >
        <div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-charcoal-700 dark:text-charcoal-200">
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-terracotta-300 bg-terracotta-100 text-terracotta-600 dark:border-terracotta-700 dark:bg-terracotta-950 dark:text-terracotta-300"
            aria-hidden="true"
          >
            <TerminalIcon className="h-3.5 w-3.5" />
          </span>
          <span className="truncate">{t('header.appName')}</span>
        </div>

        <button
          type="button"
          data-testid="mobile-chrome-trigger"
          onClick={() => setIsOpen(true)}
          aria-label={t('mobile.sessionControls')}
          aria-expanded={isOpen}
          aria-haspopup="dialog"
          className={cn(
            'pointer-events-auto flex h-11 min-w-[2.75rem] shrink-0 items-center justify-center gap-1.5 rounded-full border px-2.5 shadow-md transition-colors',
            'bg-paper dark:bg-charcoal-900',
            status.needsAttention
              ? 'border-amber-400 dark:border-amber-600'
              : isController
                ? 'border-sand-400/70 dark:border-charcoal-700'
                : 'border-terracotta-400 dark:border-terracotta-700'
          )}
        >
          <span className={cn('h-2 w-2 shrink-0 rounded-full', status.dotClass)} aria-hidden="true" />
          {(status.needsAttention || !isController) && (
            <span className="max-w-[9rem] truncate text-[11px] font-semibold text-charcoal-700 dark:text-charcoal-200">
              {status.needsAttention ? status.label : t('common.viewer')}
            </span>
          )}
          <Sliders
            className="h-3.5 w-3.5 shrink-0 text-charcoal-500 dark:text-charcoal-400"
            aria-hidden="true"
          />
        </button>
      </div>

      {isOpen && (
        <>
          <div
            data-testid="mobile-sheet-scrim"
            className="absolute inset-0 z-40 bg-charcoal-950/40"
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
            className={cn(
              'herdr-sheet absolute inset-x-0 bottom-0 z-50 max-h-[80%] overflow-y-auto',
              'rounded-t-2xl border-t border-sand-300 bg-paper/95 shadow-2xl backdrop-blur-md',
              'pb-3 focus:outline-none',
              'dark:border-charcoal-700 dark:bg-charcoal-900/95'
            )}
          >
            <MobileControlSheet
              onClose={close}
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
            />
          </div>
        </>
      )}
    </>
  );
};
