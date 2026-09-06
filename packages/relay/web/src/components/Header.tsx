import React from 'react';
import { useTerminal } from '../context/TerminalContext';
import { RoleControlBadge } from './RoleControlBadge';
import {
  Terminal as TerminalIcon,
  Activity,
  Settings,
  Link2,
  Keyboard,
  Copy,
  Check,
  Globe,
} from 'lucide-react';
import { cn } from '../utils/cn';
import { translate } from '../i18n';

/**
 * Header actions are icons and nothing else: no plate, no border, no fill.
 * Only the icon color reacts to hover and to the active view, so the strip
 * reads as a row of glyphs instead of a row of boxes.
 */
const headerIconButtonClass =
  'h-8 w-8 sm:h-9 sm:w-9 shrink-0 flex items-center justify-center rounded-md bg-transparent border-0 transition-colors focus:outline-none focus:ring-1 focus:ring-herdr-500';

const headerIconIdleClass =
  'text-charcoal-500 dark:text-charcoal-400 hover:text-charcoal-900 dark:hover:text-white';

const headerIconActiveClass = 'text-herdr-600 dark:text-herdr-400';

interface HeaderProps {
  currentView: 'terminal' | 'admin';
  onNavigate: (view: 'terminal' | 'admin') => void;
  /** False on operator-facing relays, where visitors get no dashboard signpost. */
  showAdminEntry?: boolean;
  onOpenPairing: () => void;
  onOpenSettings: () => void;
  onToggleVirtualKeyboard: () => void;
  isVirtualKeyboardOpen: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  currentView,
  onNavigate,
  showAdminEntry = true,
  onOpenPairing,
  onOpenSettings,
  onToggleVirtualKeyboard,
  isVirtualKeyboardOpen,
}) => {
  const {
    connectionState,
    rttMs,
    hostId,
    settings,
    addToast,
    language,
    setLanguage,
    t,
  } = useTerminal();

  const [copiedClientId, setCopiedClientId] = React.useState(false);

  const isConnected = connectionState === 'connected';

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
    <header
      className="bg-sand-200 dark:bg-charcoal-900 border-b border-sand-400/70 dark:border-charcoal-700 px-2 sm:px-3 py-1.5 sm:py-2 flex items-center justify-between gap-2 sm:gap-3 select-none z-30 pt-[max(env(safe-area-inset-top,0px),0.375rem)] shadow-sm transition-colors flex-nowrap w-full overflow-x-hidden min-h-[48px]"
      role="banner"
    >
      {/*
       * Session identity comes first, in the reading position: host, client and
       * round-trip time are one plain line of text — no chips, no plates —
       * because they are information, not controls.
       */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2 font-mono text-[11px] sm:text-xs text-charcoal-600 dark:text-charcoal-400">
        {hostId && (
          <>
            <span className="truncate" title={`${t('header.hostLabel')} ${hostId}`}>
              {t('header.hostLabel')}{' '}
              <span className="text-herdr-700 dark:text-herdr-300 font-semibold">{hostId}</span>
            </span>
            <span className="text-charcoal-400/60 dark:text-charcoal-600 shrink-0" aria-hidden="true">
              ·
            </span>
          </>
        )}

        <button
          type="button"
          onClick={copyClientId}
          className="flex min-w-0 items-center gap-1 bg-transparent border-0 p-0 hover:text-charcoal-900 dark:hover:text-charcoal-100 transition-colors"
          title={t('header.copyClientIdTitle')}
        >
          <span className="truncate">
            {t('header.clientIdLabel')}{' '}
            <span className="text-charcoal-800 dark:text-charcoal-200">{settings.clientId}</span>
          </span>
          {copiedClientId ? (
            <Check className="w-3 h-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <Copy className="w-3 h-3 shrink-0 text-charcoal-400" />
          )}
        </button>

        {isConnected && rttMs !== null && (
          <span
            className="flex items-center gap-1 shrink-0 text-[10px] sm:text-[11px]"
            title={t('header.latencyTitle')}
          >
            <span
              className={cn(
                'w-1.5 h-1.5 rounded-full',
                rttMs < 50 ? 'bg-emerald-500' : rttMs < 150 ? 'bg-amber-500' : 'bg-red-500'
              )}
            />
            {rttMs}ms
          </span>
        )}
      </div>

      {/* Right section: view switch, control lease and icon-only actions */}
      <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
        <nav
          className="flex items-center gap-0.5"
          aria-label={t('header.mainNavigationAria')}
        >
          <button
            type="button"
            onClick={() => onNavigate('terminal')}
            className={cn(
              headerIconButtonClass,
              currentView === 'terminal' ? headerIconActiveClass : headerIconIdleClass
            )}
            aria-current={currentView === 'terminal' ? 'page' : undefined}
            title={t('header.terminalTab')}
            aria-label={t('header.terminalTab')}
          >
            <TerminalIcon className="w-4 h-4" aria-hidden="true" />
          </button>
          {(showAdminEntry || currentView === 'admin') && (
            <button
              type="button"
              onClick={() => onNavigate('admin')}
              className={cn(
                headerIconButtonClass,
                currentView === 'admin' ? headerIconActiveClass : headerIconIdleClass
              )}
              aria-current={currentView === 'admin' ? 'page' : undefined}
              title={t('header.adminTab')}
              aria-label={t('header.adminTab')}
            >
              <Activity className="w-4 h-4" aria-hidden="true" />
            </button>
          )}
        </nav>

        <RoleControlBadge compact />

        {/* Language switch */}
        <button
          type="button"
          onClick={toggleLanguage}
          className={cn(headerIconButtonClass, headerIconIdleClass)}
          title={t('header.languageToggleTitle')}
          aria-label={t('header.languageToggleTitle')}
        >
          <Globe className="w-4 h-4" aria-hidden="true" />
        </button>

        {/* Soft keyboard helper */}
        {currentView === 'terminal' && (
          <button
            type="button"
            onClick={onToggleVirtualKeyboard}
            className={cn(
              headerIconButtonClass,
              isVirtualKeyboardOpen ? headerIconActiveClass : headerIconIdleClass
            )}
            title={t('header.virtualKeyboardTitle')}
            aria-label={t('header.virtualKeyboardTitle')}
          >
            <Keyboard className="w-4 h-4" />
          </button>
        )}

        {/* Pairing */}
        <button
          type="button"
          onClick={onOpenPairing}
          className={cn(headerIconButtonClass, headerIconIdleClass)}
          title={t('header.pairingTitle')}
          aria-label={t('header.pairingTitle')}
        >
          <Link2 className="w-4 h-4" />
        </button>

        {/* Settings */}
        <button
          type="button"
          onClick={onOpenSettings}
          className={cn(headerIconButtonClass, headerIconIdleClass)}
          title={t('header.settingsTitle')}
          aria-label={t('header.settingsTitle')}
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
