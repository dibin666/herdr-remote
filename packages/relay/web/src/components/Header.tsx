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
 * One height for everything in the header's action strip. The role badge, the
 * lease button and the icon buttons used to size themselves independently,
 * which left the row visibly ragged.
 */
const HEADER_CONTROL_HEIGHT = 'h-8 sm:h-9';

const headerIconButtonClass =
  `${HEADER_CONTROL_HEIGHT} w-8 sm:w-9 shrink-0 rounded-lg border flex items-center justify-center transition-colors focus:outline-none focus:ring-1 focus:ring-herdr-500`;

const headerIdleButtonClass =
  'bg-sand-100 dark:bg-charcoal-800 border-sand-400/60 dark:border-charcoal-700 text-charcoal-600 dark:text-charcoal-300 hover:bg-sand-50 hover:text-charcoal-900 dark:hover:text-white hover:border-sand-400 dark:hover:border-charcoal-600';

interface HeaderProps {
  currentView: 'terminal' | 'admin';
  onNavigate: (view: 'terminal' | 'admin') => void;
  onOpenPairing: () => void;
  onOpenSettings: () => void;
  onToggleVirtualKeyboard: () => void;
  isVirtualKeyboardOpen: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  currentView,
  onNavigate,
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
      className="bg-sand-200 dark:bg-charcoal-900 border-b border-sand-400/70 dark:border-charcoal-700 px-2 sm:px-4 py-1.5 sm:py-2 flex items-center justify-between gap-1.5 sm:gap-3 select-none z-30 pt-[max(env(safe-area-inset-top,0px),0.375rem)] shadow-sm transition-colors flex-nowrap w-full overflow-x-hidden min-h-[48px]"
      role="banner"
    >
      {/* Left section: Logo + Brand + Tab switchers */}
      <div className="flex items-center gap-1.5 sm:gap-3 min-w-0 shrink-0">
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-herdr-100 dark:bg-herdr-950 border border-herdr-300 dark:border-herdr-700 flex items-center justify-center text-herdr-600 dark:text-herdr-400 shadow-sm shrink-0">
            <TerminalIcon className="w-4 h-4" aria-hidden="true" />
          </div>
          <span className="font-bold text-xs sm:text-sm md:text-base text-charcoal-900 dark:text-charcoal-100 tracking-tight hidden xxs:inline">
            {t('header.appName')}
          </span>
        </div>

        {/* View Switcher Tabs */}
        <nav
          className="flex items-center gap-0.5 bg-sand-100 dark:bg-charcoal-800 p-0.5 rounded-lg border border-sand-400/60 dark:border-charcoal-700 shrink-0"
          aria-label={t('header.mainNavigationAria')}
        >
          <button
            type="button"
            onClick={() => onNavigate('terminal')}
            className={cn(
              'flex items-center gap-1 px-2.5 h-7 sm:h-8 rounded-md text-xs font-semibold transition-all',
              currentView === 'terminal'
                ? 'bg-herdr-700 text-white shadow-sm'
                : 'text-charcoal-600 dark:text-charcoal-400 hover:bg-sand-50 hover:text-charcoal-900 dark:hover:text-charcoal-200'
            )}
            aria-current={currentView === 'terminal' ? 'page' : undefined}
          >
            <TerminalIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden xs:inline">{t('header.terminalTab')}</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('admin')}
            className={cn(
              'flex items-center gap-1 px-2.5 h-7 sm:h-8 rounded-md text-xs font-semibold transition-all',
              currentView === 'admin'
                ? 'bg-herdr-700 text-white shadow-sm'
                : 'text-charcoal-600 dark:text-charcoal-400 hover:bg-sand-50 hover:text-charcoal-900 dark:hover:text-charcoal-200'
            )}
            aria-current={currentView === 'admin' ? 'page' : undefined}
          >
            <Activity className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden xs:inline">{t('header.adminTab')}</span>
          </button>
        </nav>
      </div>

      {/* Middle section (Tablet/Desktop info): Host, Client ID & RTT Latency */}
      <div className="hidden md:flex items-center gap-2 shrink min-w-0 truncate">
        {hostId && (
          <span
            className={cn(
              HEADER_CONTROL_HEIGHT,
              'flex items-center text-xs font-mono text-charcoal-600 dark:text-charcoal-300 px-2 bg-sand-100 dark:bg-charcoal-800 rounded-lg border border-sand-400/60 dark:border-charcoal-700 truncate'
            )}
          >
            {t('header.hostLabel')}{' '}
            <span className="text-herdr-700 dark:text-herdr-400 font-semibold">{hostId}</span>
          </span>
        )}

        <button
          type="button"
          onClick={copyClientId}
          className={cn(
            HEADER_CONTROL_HEIGHT,
            'text-xs font-mono text-charcoal-600 dark:text-charcoal-400 px-2 bg-sand-100 dark:bg-charcoal-800 hover:bg-sand-50 dark:hover:bg-charcoal-700 rounded-lg border border-sand-400/60 dark:border-charcoal-700 flex items-center gap-1 transition-colors shrink-0'
          )}
          title={t('header.copyClientIdTitle')}
        >
          <span>{t('header.clientIdLabel')} <span className="text-charcoal-800 dark:text-charcoal-200">{settings.clientId}</span></span>
          {copiedClientId ? (
            <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <Copy className="w-3 h-3 text-charcoal-400" />
          )}
        </button>

        {isConnected && rttMs !== null && (
          <span
            className="text-[11px] font-mono text-charcoal-600 dark:text-charcoal-400 flex items-center gap-1 shrink-0"
            title={t('header.latencyTitle')}
          >
            <span
              className={cn(
                'w-1.5 h-1.5 rounded-full',
                rttMs < 50
                  ? 'bg-emerald-500'
                  : rttMs < 150
                  ? 'bg-amber-500'
                  : 'bg-red-500'
              )}
            />
            {rttMs}ms
          </span>
        )}
      </div>

      {/* Right section: Role badge + Language + Actions */}
      <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
        <RoleControlBadge compact />

        {/* Language switch button */}
        <button
          type="button"
          onClick={toggleLanguage}
          className={cn(
            HEADER_CONTROL_HEIGHT,
            'shrink-0 px-2 rounded-lg border flex items-center justify-center gap-1 text-xs font-semibold transition-colors focus:outline-none focus:ring-1 focus:ring-herdr-500',
            headerIdleButtonClass
          )}
          title={t('header.languageToggleTitle')}
          aria-label={t('header.languageToggleTitle')}
        >
          <Globe className="w-3.5 h-3.5 text-herdr-600 dark:text-herdr-400" />
          <span className="text-[11px]">{language === 'zh' ? '中' : 'EN'}</span>
        </button>

        {/* Soft Keyboard trigger on mobile / compact */}
        {currentView === 'terminal' && (
          <button
            type="button"
            onClick={onToggleVirtualKeyboard}
            className={cn(
              headerIconButtonClass,
              isVirtualKeyboardOpen
                ? 'bg-herdr-100 dark:bg-herdr-950 border-herdr-400 text-herdr-700 dark:text-herdr-300'
                : headerIdleButtonClass
            )}
            title={t('header.virtualKeyboardTitle')}
            aria-label={t('header.virtualKeyboardTitle')}
          >
            <Keyboard className="w-4 h-4" />
          </button>
        )}

        {/* Pairing Modal trigger */}
        <button
          type="button"
          onClick={onOpenPairing}
          className={cn(headerIconButtonClass, headerIdleButtonClass)}
          title={t('header.pairingTitle')}
          aria-label={t('header.pairingTitle')}
        >
          <Link2 className="w-4 h-4" />
        </button>

        {/* Settings Modal trigger */}
        <button
          type="button"
          onClick={onOpenSettings}
          className={cn(headerIconButtonClass, headerIdleButtonClass)}
          title={t('header.settingsTitle')}
          aria-label={t('header.settingsTitle')}
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
