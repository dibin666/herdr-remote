import React from 'react';
import { useTerminal } from '../context/TerminalContext';
import { RefreshCw, AlertCircle, WifiOff } from 'lucide-react';

export const StatusBanner: React.FC = () => {
  const { connectionState, stateDetail, connect, settings, t } = useTerminal();

  if (connectionState === 'connected') {
    return null;
  }

  // If there's no token or pair code, let OnboardingView handle the guidance
  if (!settings.token && !settings.pairCode && connectionState === 'disconnected') {
    return null;
  }

  if (connectionState === 'connecting') {
    return (
      <aside
        className="w-full bg-sand-200/90 dark:bg-charcoal-800 border-b border-sand-300 dark:border-charcoal-700 text-charcoal-700 dark:text-charcoal-200 px-3 py-1.5 text-xs flex items-center justify-between"
        aria-live="polite"
      >
        <div className="flex items-center gap-2">
          <RefreshCw className="w-3.5 h-3.5 animate-spin text-herdr-600 dark:text-herdr-400" aria-hidden="true" />
          <span>{t('statusBanner.connecting')}</span>
        </div>
      </aside>
    );
  }

  if (connectionState === 'reconnecting') {
    return (
      <aside
        className="w-full bg-amber-50 dark:bg-amber-950/80 border-b border-amber-300 dark:border-amber-800/60 text-amber-900 dark:text-amber-200 px-3 py-1.5 text-xs flex items-center justify-between"
        aria-live="assertive"
      >
        <div className="flex items-center gap-2">
          <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-600 dark:text-amber-400" aria-hidden="true" />
          <span>{stateDetail || t('statusBanner.reconnectingDefault')}</span>
        </div>
        <button
          type="button"
          onClick={() => connect()}
          className="px-2.5 py-0.5 bg-amber-600 hover:bg-amber-700 text-white rounded text-[11px] font-medium transition-colors"
        >
          {t('statusBanner.reconnectNow')}
        </button>
      </aside>
    );
  }

  if (connectionState === 'error') {
    return (
      <aside
        className="w-full bg-red-50 dark:bg-red-950/80 border-b border-red-300 dark:border-red-800/60 text-red-900 dark:text-red-200 px-3 py-1.5 text-xs flex items-center justify-between"
        aria-live="assertive"
      >
        <div className="flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5 text-red-600 dark:text-red-400 flex-shrink-0" aria-hidden="true" />
          <span className="truncate">{stateDetail || t('statusBanner.errorDefault')}</span>
        </div>
        <button
          type="button"
          onClick={() => connect()}
          className="px-2.5 py-0.5 bg-red-600 hover:bg-red-700 text-white rounded text-[11px] font-medium flex-shrink-0 transition-colors ml-2"
        >
          {t('common.retry')}
        </button>
      </aside>
    );
  }

  if (connectionState === 'disconnected') {
    return (
      <aside
        className="w-full bg-sand-200/90 dark:bg-charcoal-800 border-b border-sand-300 dark:border-charcoal-700 text-charcoal-700 dark:text-charcoal-300 px-3 py-1.5 text-xs flex items-center justify-between"
        aria-live="polite"
      >
        <div className="flex items-center gap-2">
          <WifiOff className="w-3.5 h-3.5 text-charcoal-500" aria-hidden="true" />
          <span>{t('statusBanner.disconnected')}</span>
        </div>
        <button
          type="button"
          onClick={() => connect()}
          className="px-2.5 py-0.5 bg-herdr-700 hover:bg-herdr-800 text-white font-semibold rounded text-[11px] transition-colors"
        >
          {t('common.connect')}
        </button>
      </aside>
    );
  }

  return null;
};
