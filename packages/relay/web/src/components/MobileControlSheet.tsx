import React from 'react';
import { useTerminal } from '../context/TerminalContext';
import { RoleControlBadge } from './RoleControlBadge';
import { describeConnection } from '../utils/connectionStatus';
import {
  Activity,
  Check,
  Copy,
  Link2,
  Settings,
  Sliders,
  X,
  Globe,
} from 'lucide-react';
import { cn } from '../utils/cn';
import { translate } from '../i18n';

export interface MobileControlSheetProps {
  onClose: () => void;
  onNavigateAdmin: () => void;
  onOpenPairing: () => void;
  onOpenSettings: () => void;
}

/**
 * Actions read as rows, not as a wall of stacked icon tiles: a label beside its
 * icon stays legible at any translation length, and a 48px row is a target a
 * thumb hits without aiming.
 */
const actionButtonClass =
  'flex items-center gap-2.5 h-12 px-3 rounded-xl border text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-herdr-500 [&>svg]:shrink-0 [&>span]:truncate';

const idleActionClass =
  'bg-paper dark:bg-charcoal-800 border-sand-300 dark:border-charcoal-700 text-charcoal-700 dark:text-charcoal-200 active:bg-sand-200 dark:active:bg-charcoal-700';

const activeActionClass =
  'bg-herdr-100 dark:bg-herdr-950 border-herdr-400 text-herdr-700 dark:text-herdr-300';

const sectionClass =
  'rounded-2xl border border-sand-300 bg-sand-200/70 p-3 dark:border-charcoal-700 dark:bg-charcoal-850/80';

const sectionLabelClass =
  'mb-2 text-[11px] font-semibold uppercase tracking-wide text-charcoal-500 dark:text-charcoal-400';

export const MobileControlSheet: React.FC<MobileControlSheetProps> = ({
  onClose,
  onNavigateAdmin,
  onOpenPairing,
  onOpenSettings,
}) => {
  const {
    connectionState,
    stateDetail,
    rttMs,
    hostId,
    settings,
    updateSettings,
    connect,
    addToast,
    language,
    setLanguage,
    t,
  } = useTerminal();

  const [copiedClientId, setCopiedClientId] = React.useState(false);
  const status = describeConnection(connectionState, t);

  const copyClientId = () => {
    navigator.clipboard.writeText(settings.clientId).then(() => {
      setCopiedClientId(true);
      addToast('info', t('toasts.clientIdCopied', { id: settings.clientId }));
      setTimeout(() => setCopiedClientId(false), 2000);
    });
  };

  const toggleLanguage = () => {
    const nextLang = language === 'zh' ? 'en' : 'zh';
    setLanguage(nextLang);
    addToast(
      'info',
      translate(nextLang, 'toasts.switchedLanguage', {
        lang: nextLang === 'zh' ? '简体中文' : 'English',
      })
    );
  };

  return (
    <div className="flex flex-col gap-3 px-4 pb-2">
      {/* Grab handle + title */}
      <div className="flex flex-col items-center gap-2.5 pt-2.5">
        <span
          className="h-1 w-10 rounded-full bg-sand-400 dark:bg-charcoal-600"
          aria-hidden="true"
        />
        <div className="flex w-full items-center justify-between">
          <h2 className="text-sm font-bold tracking-tight text-charcoal-900 dark:text-charcoal-100">
            {t('mobile.sessionControls')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-sand-300 bg-sand-100 text-charcoal-600 transition-colors active:bg-sand-200 dark:border-charcoal-700 dark:bg-charcoal-800 dark:text-charcoal-300"
            aria-label={t('mobile.closeSessionControls')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Connection */}
      <section className={sectionClass} aria-label={t('mobile.connectionStatusAria')}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn('h-2 w-2 shrink-0 rounded-full', status.dotClass)} />
            <span className="text-xs font-semibold text-charcoal-800 dark:text-charcoal-100">
              {status.label}
            </span>
            {connectionState === 'connected' && rttMs !== null && (
              <span className="font-mono text-[11px] text-charcoal-500 dark:text-charcoal-400">
                {rttMs}ms
              </span>
            )}
          </div>
          {status.actionLabel && (
            <button
              type="button"
              onClick={() => connect()}
              className="shrink-0 rounded-lg bg-herdr-700 px-2.5 py-1 text-[11px] font-semibold text-white transition-colors active:bg-herdr-900"
            >
              {status.actionLabel}
            </button>
          )}
        </div>

        {status.needsAttention && stateDetail && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-charcoal-600 dark:text-charcoal-300">
            {stateDetail}
          </p>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {hostId && (
            <span className="truncate rounded border border-sand-300 bg-paper px-2 py-0.5 font-mono text-[11px] text-charcoal-600 dark:border-charcoal-700 dark:bg-charcoal-900 dark:text-charcoal-300">
              {t('common.host')}:{' '}
              <span className="font-semibold text-herdr-700 dark:text-herdr-400">
                {hostId}
              </span>
            </span>
          )}
          <button
            type="button"
            onClick={copyClientId}
            className="flex items-center gap-1 rounded border border-sand-300 bg-paper px-2 py-0.5 font-mono text-[11px] text-charcoal-600 transition-colors active:bg-sand-200 dark:border-charcoal-700 dark:bg-charcoal-900 dark:text-charcoal-300"
            title={t('header.copyClientIdTitle')}
          >
            <span>{t('header.clientIdLabel')} {settings.clientId}</span>
            {copiedClientId ? (
              <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Copy className="h-3 w-3 text-charcoal-400" />
            )}
          </button>
        </div>
      </section>

      {/* Control lease — the switch between viewer and full input */}
      <section className={sectionClass} aria-label={t('mobile.terminalControlAria')}>
        <p className={sectionLabelClass}>{t('mobile.inputControl')}</p>
        <RoleControlBadge />
      </section>

      {/* Action Grid */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={toggleLanguage}
          className={cn(actionButtonClass, idleActionClass)}
          aria-label={t('header.languageToggleTitle')}
        >
          <Globe className="h-4 w-4 text-herdr-600 dark:text-herdr-400" />
          <span>{language === 'zh' ? 'English' : '中文'}</span>
        </button>

        <button
          type="button"
          onClick={onOpenSettings}
          className={cn(actionButtonClass, idleActionClass)}
          aria-label={t('mobile.settingsAria')}
        >
          <Settings className="h-4 w-4" />
          <span>{t('common.settings')}</span>
        </button>

        <button
          type="button"
          onClick={onNavigateAdmin}
          className={cn(actionButtonClass, idleActionClass)}
          aria-label={t('mobile.adminAria')}
        >
          <Activity className="h-4 w-4" />
          <span>{t('common.admin')}</span>
        </button>

        <button
          type="button"
          onClick={onOpenPairing}
          className={cn(actionButtonClass, idleActionClass)}
          aria-label={t('mobile.pairingAria')}
        >
          <Link2 className="h-4 w-4" />
          <span>{t('common.pairing')}</span>
        </button>

        <button
          type="button"
          onClick={() => updateSettings({ toolbarVisible: !settings.toolbarVisible })}
          className={cn(
            actionButtonClass,
            settings.toolbarVisible ? activeActionClass : idleActionClass
          )}
          aria-label={t('mobile.keybarAria')}
          aria-pressed={settings.toolbarVisible}
        >
          <Sliders className="h-4 w-4" />
          <span>{t('common.keyBar')}</span>
        </button>

      </div>
    </div>
  );
};
