import React, { useState } from 'react';
import { useTerminal } from '../context/TerminalContext';
import { Shield, ShieldAlert, ShieldCheck, Zap, LogOut, AlertTriangle } from 'lucide-react';
import { cn } from '../utils/cn';

/**
 * The badge sits in the header's action strip next to fixed-size icon buttons,
 * so it and its lease button carry the same height. Away from the header
 * (the phone sheet) the pair grows to a comfortable touch target instead.
 */
const badgeSizeClass = (compact: boolean) =>
  compact ? 'h-8 sm:h-9 px-2.5 text-xs' : 'h-10 px-3 text-xs';

export const RoleControlBadge: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const {
    role,
    controllerId,
    assignedClientId,
    connectionState,
    claimControl,
    releaseControl,
    t,
  } = useTerminal();

  const [showTakeoverConfirm, setShowTakeoverConfirm] = useState(false);

  const isConnected = connectionState === 'connected';
  const isController = role === 'controller';
  const hasActiveController = Boolean(controllerId);
  const isAnotherController =
    !isController && hasActiveController && controllerId !== assignedClientId;

  if (!isConnected) {
    return (
      <div
        className={cn(
          badgeSizeClass(compact),
          'inline-flex items-center gap-1.5 rounded-full font-medium bg-sand-100 dark:bg-charcoal-800 text-charcoal-600 dark:text-charcoal-400 border border-sand-400/60 dark:border-charcoal-700'
        )}
        role="status"
        aria-label={t('terminal.offlineStatusAria')}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-charcoal-400" />
        <span>{t('common.offline')}</span>
      </div>
    );
  }

  const handleTakeoverClick = () => {
    setShowTakeoverConfirm(true);
  };

  const handleConfirmTakeover = () => {
    setShowTakeoverConfirm(false);
    claimControl(true);
  };

  return (
    <>
      <div className={cn('flex items-center gap-1.5 sm:gap-2', !compact && 'w-full')}>
        {/* Role Indicator Badge */}
        <div
          className={cn(
            badgeSizeClass(compact),
            'inline-flex items-center gap-1.5 rounded-full font-medium border transition-colors',
            !compact && 'flex-1 min-w-0',
            isController
              ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-300 dark:border-emerald-700 text-emerald-800 dark:text-emerald-300'
              : 'bg-amber-50 dark:bg-amber-950/60 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300'
          )}
          role="status"
          aria-label={isController ? t('role.controllerMode') : t('role.viewerMode')}
        >
          {isController ? (
            <>
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="font-semibold">{compact ? t('role.controlActive') : `${t('role.controlActive')} (Input active)`}</span>
            </>
          ) : (
            <>
              <span className="w-2 h-2 rounded-full bg-amber-500" />
              <Shield className="w-3.5 h-3.5" aria-hidden="true" />
              <span>
                {compact
                  ? t('common.viewer')
                  : isAnotherController
                  ? t('role.viewerWithController', { controllerId: controllerId || '' })
                  : t('role.viewerReadOnly')}
              </span>
            </>
          )}
        </div>

        {/* Control Action Buttons */}
        {isController ? (
          <button
            type="button"
            onClick={releaseControl}
            className={cn(
              badgeSizeClass(compact),
              'inline-flex shrink-0 items-center justify-center gap-1 rounded-lg font-medium bg-sand-100 hover:bg-sand-50 active:bg-sand-300 dark:bg-charcoal-800 dark:hover:bg-charcoal-700 text-charcoal-700 dark:text-charcoal-200 border border-sand-400/60 dark:border-charcoal-600 transition-colors focus:outline-none focus:ring-2 focus:ring-herdr-500'
            )}
            aria-label={t('terminal.releaseControlAria')}
            title={t('role.releaseControlTitle')}
          >
            <LogOut className="w-3.5 h-3.5 text-charcoal-500" aria-hidden="true" />
            <span className="hidden sm:inline">{t('role.releaseControl')}</span>
          </button>
        ) : isAnotherController ? (
          <button
            type="button"
            onClick={handleTakeoverClick}
            className={cn(
              badgeSizeClass(compact),
              'inline-flex shrink-0 items-center justify-center gap-1 rounded-lg font-semibold bg-amber-600 hover:bg-amber-500 active:bg-amber-700 text-white transition-all shadow-sm focus:outline-none focus:ring-2 focus:ring-amber-500'
            )}
            aria-label={t('terminal.takeoverControlAria')}
            title={t('role.takeoverControlTitle', { controllerId: controllerId || '' })}
          >
            <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{t('role.takeoverControl')}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => claimControl(false)}
            className={cn(
              badgeSizeClass(compact),
              'inline-flex shrink-0 items-center justify-center gap-1 rounded-lg font-semibold bg-herdr-700 hover:bg-herdr-800 active:bg-herdr-900 text-white transition-all shadow-sm focus:outline-none focus:ring-2 focus:ring-herdr-500'
            )}
            aria-label={t('terminal.claimControlAria')}
            title={t('role.claimControlTitle')}
          >
            <Zap className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{t('role.claimControl')}</span>
          </button>
        )}
      </div>

      {/* Takeover Confirmation Modal */}
      {showTakeoverConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-charcoal-950/60 backdrop-blur-sm animate-in fade-in"
          role="dialog"
          aria-modal="true"
          aria-labelledby="takeover-modal-title"
        >
          <div className="bg-paper dark:bg-charcoal-850 border border-sand-300 dark:border-charcoal-700 rounded-2xl p-6 shadow-2xl max-w-sm w-full space-y-4">
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950 border border-amber-300 dark:border-amber-700 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <h3 id="takeover-modal-title" className="font-bold text-sm text-charcoal-900 dark:text-charcoal-100">
                  {t('role.takeoverModalTitle')}
                </h3>
                <p className="text-xs text-charcoal-600 dark:text-charcoal-300 mt-1 leading-relaxed">
                  {t('role.takeoverModalDesc')}
                </p>
                <p className="text-xs text-charcoal-500 dark:text-charcoal-400 mt-1">
                  {t('role.takeoverModalWarning')}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-sand-200 dark:border-charcoal-750">
              <button
                type="button"
                onClick={() => setShowTakeoverConfirm(false)}
                className="px-3.5 py-2 rounded-xl text-xs font-medium text-charcoal-700 dark:text-charcoal-300 hover:bg-sand-100 dark:hover:bg-charcoal-800 transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirmTakeover}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-amber-600 hover:bg-amber-500 active:bg-amber-700 text-white shadow-sm transition-colors"
              >
                {t('role.confirmTakeover')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
