import React from 'react';
import { useTerminal, ToastItem } from '../context/TerminalContext';
import { cn } from '../utils/cn';
import { GLYPH, StatusLevel, TONE } from './tui';

/**
 * Notifications, drawn the way a terminal program logs.
 *
 * Each one is a single line prefixed by a level glyph and coloured by that
 * level — no icon, no card, no shadow. They stack under the header in the top
 * right, the corner Herdr puts its own toasts in.
 */

const TOAST_TONE: Record<ToastItem['type'], StatusLevel> = {
  success: 'ok',
  warning: 'warn',
  error: 'bad',
  info: 'accent',
};

const TOAST_PREFIX: Record<ToastItem['type'], string> = {
  success: GLYPH.check,
  warning: GLYPH.warn,
  error: GLYPH.cross,
  info: '›',
};

export const ToastContainer: React.FC = () => {
  const { toasts, removeToast, t } = useTerminal();

  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed right-2 top-12 z-50 flex w-[calc(100vw-16px)] max-w-sm flex-col gap-1"
      aria-live="polite"
      aria-atomic="true"
    >
      {toasts.map((toast) => {
        const tone = TOAST_TONE[toast.type];
        return (
          <div
            key={toast.id}
            className={cn(
              'pointer-events-auto flex items-start gap-2 border border-tui-border border-l-2 bg-tui-base px-2 py-1 text-tui',
              TONE[tone].edgeL
            )}
            role="alert"
          >
            <span aria-hidden="true" className={cn('shrink-0 font-bold', TONE[tone].text)}>
              {TOAST_PREFIX[toast.type]}
            </span>
            <div className="min-w-0 flex-1 break-words leading-snug text-tui-text">
              {toast.message}
            </div>
            {toast.count > 1 && (
              <span
                className="shrink-0 border border-tui-border-dim px-1 text-tui-sm text-tui-muted"
                aria-label={`×${toast.count}`}
              >
                ×{toast.count}
              </span>
            )}
            <button
              type="button"
              onClick={() => removeToast(toast.id)}
              className="tui-focusable shrink-0 select-none px-0.5 text-tui-faint transition-colors hover:text-tui-bad"
              aria-label={t('common.dismissNotification')}
            >
              <span aria-hidden="true">{GLYPH.cross}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
};
