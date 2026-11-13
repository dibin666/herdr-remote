import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useSettings, useConnection } from '@/context/TerminalContext';
import { cn } from '@/shared/lib/cn';
import { ControlModeSwitch } from './ControlModeSwitch';

/**
 * The status line's read-only word for this window's input mode.
 *
 * What the segmented switch did inline it now does one tap away: the mode is a
 * bracketed badge — green for control, amber for watch-only — and pressing it
 * opens the explanation and the switch itself. A mode change can turn the
 * terminal the user is typing into into a read-only view, which is exactly the
 * kind of accident a status line should not offer single-click.
 */
export const ControlModeBadge: React.FC<{ className?: string }> = ({ className }) => {
  const { settings, t } = useSettings();
  const { connectionState, sharedWindowCount, assignedClientId } = useConnection();
  const observing = settings.observerMode;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <span ref={rootRef} className={cn('relative inline-flex items-center', className)}>
      <button
        type="button"
        data-testid="control-mode-badge"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t('role.modeLabel')}
        title={t('role.modeLabel')}
        className={cn(
          'tui-focusable select-none whitespace-nowrap font-bold uppercase',
          observing ? 'text-tui-warn' : 'text-tui-ok',
        )}
      >
        [{observing ? t('common.viewer') : t('role.controlBadge')}]
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('role.modeLabel')}
          className="absolute bottom-full left-0 z-[100] mb-1 w-72 max-w-[calc(100vw-1rem)] border border-tui-border bg-tui-base p-2 shadow-lg"
        >
          <ControlModeSwitch compact className="h-8" />
          <p className="mt-1.5 text-tui-sm leading-snug text-tui-faint">
            {observing ? t('role.observerHint') : t('role.controlHint')}
          </p>
          {connectionState === 'connected' && sharedWindowCount > 1 ? (
            <p className="mt-1 text-tui-sm text-tui-muted">
              {t('role.sharedWindows', { count: sharedWindowCount })}
            </p>
          ) : null}
          {assignedClientId ? (
            <p className="mt-1 truncate text-tui-sm text-tui-faint">
              {t('role.thisWindow')}: {assignedClientId}
            </p>
          ) : null}
        </div>
      )}
    </span>
  );
};
