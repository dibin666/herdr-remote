import React from 'react';
import { useTerminal, ToastItem } from '../context/TerminalContext';
import { CheckCircle2, AlertTriangle, AlertCircle, Info, X } from 'lucide-react';
import { cn } from '../utils/cn';

const TOAST_ICONS: Record<ToastItem['type'], React.ReactNode> = {
  success: <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />,
  warning: <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />,
  error: <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0" />,
  info: <Info className="w-4 h-4 text-herdr-600 dark:text-herdr-400 flex-shrink-0" />,
};

const TOAST_CLASSES: Record<ToastItem['type'], string> = {
  success:
    'bg-paper dark:bg-charcoal-900 border-emerald-300 dark:border-emerald-700/70 text-charcoal-800 dark:text-charcoal-100 shadow-lg shadow-emerald-950/5 dark:shadow-emerald-950/30',
  warning:
    'bg-paper dark:bg-charcoal-900 border-amber-300 dark:border-amber-700/70 text-charcoal-800 dark:text-charcoal-100 shadow-lg shadow-amber-950/5 dark:shadow-amber-950/30',
  error:
    'bg-paper dark:bg-charcoal-900 border-red-300 dark:border-red-700/70 text-charcoal-800 dark:text-charcoal-100 shadow-lg shadow-red-950/5 dark:shadow-red-950/30',
  info:
    'bg-paper dark:bg-charcoal-900 border-sand-300 dark:border-charcoal-700 text-charcoal-800 dark:text-charcoal-100 shadow-lg shadow-charcoal-950/5 dark:shadow-charcoal-950/30',
};

export const ToastContainer: React.FC = () => {
  const { toasts, removeToast, t } = useTerminal();

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed top-14 right-3 z-50 flex flex-col gap-2 max-w-sm w-[calc(100vw-24px)] pointer-events-none"
      aria-live="polite"
      aria-atomic="true"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cn(
            'pointer-events-auto flex items-start gap-2.5 p-3 rounded-xl border backdrop-blur-md transition-all animate-in fade-in slide-in-from-top-2 text-xs font-medium',
            TOAST_CLASSES[toast.type]
          )}
          role="alert"
        >
          {TOAST_ICONS[toast.type]}
          <div className="flex-1 leading-snug break-words">{toast.message}</div>
          {toast.count > 1 && (
            <span
              className="shrink-0 rounded-full bg-sand-200 dark:bg-charcoal-800 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-charcoal-600 dark:text-charcoal-300"
              aria-label={`×${toast.count}`}
            >
              ×{toast.count}
            </span>
          )}
          <button
            type="button"
            onClick={() => removeToast(toast.id)}
            className="text-charcoal-400 hover:text-charcoal-700 dark:hover:text-charcoal-200 p-0.5 rounded focus:outline-none focus:ring-1 focus:ring-herdr-500"
            aria-label={t('common.dismissNotification')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
};
