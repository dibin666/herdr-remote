import React from 'react';
import { useTerminal } from '../context/TerminalContext';
import { cn } from '../utils/cn';
import { translate } from '../i18n';
import { Tabs } from './tui';

/**
 * The two chrome rows at the top of the window.
 *
 * Row one is the program and its actions; row two is the numbered tab strip.
 * That is Herdr's own arrangement, and the reason it works is that neither row
 * carries session *state* — the host, the client id, the latency and the
 * control lease all live on the status line at the bottom of the screen, where
 * a multiplexer keeps them. Splitting the two means the top of the window stays
 * the same width at every connection state instead of reflowing every time a
 * round-trip time appears.
 *
 * The actions are words, not icons: `cfg`, `link`, `cmd`. A terminal spells
 * what it does, and a three-letter word survives translation and a 320px screen
 * where a glyph has to be learnt.
 */

const actionClass =
  'tui-focusable select-none border border-transparent px-1.5 text-tui uppercase transition-colors';

const actionIdle = 'text-tui-muted hover:border-tui-border hover:text-tui-accent';

const actionActive = 'border-tui-accent bg-tui-accent text-tui-crust';

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
  const { addToast, language, setLanguage, t } = useTerminal();

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

  const tabs = [
    { id: 'terminal', label: t('header.terminalTab'), index: 1, ariaLabel: t('header.terminalTab') },
    ...(showAdminEntry || currentView === 'admin'
      ? [{ id: 'admin', label: t('header.adminTab'), index: 2, ariaLabel: t('header.adminTab') }]
      : []),
  ];

  return (
    <header
      role="banner"
      className="z-30 w-full shrink-0 select-none overflow-hidden border-b border-tui-border bg-tui-mantle px-2 pt-[max(env(safe-area-inset-top,0px),0.125rem)]"
    >
      {/*
       * One compact tab row, not a web header stacked over a nav bar. Herdr's
       * TUI gives the program name, tabs and right-side commands one terminal
       * row; the view below owns its own panels. Keeping these on one row also
       * stops a narrow admin screen from spending four rows on chrome before
       * the first useful value appears.
       */}
      <div className="scrollbar-none flex min-h-[var(--tui-row)] items-center gap-2 overflow-x-auto text-tui">
        <span className="flex shrink-0 items-baseline gap-2">
          <span className="font-bold text-tui-accent">herdr-remote</span>
          <span className="hidden text-tui-sm text-tui-faint sm:inline">{t('header.tagline')}</span>
        </span>

        <span aria-hidden="true" className="h-4 w-px shrink-0 bg-tui-border" />

        <Tabs
          tabs={tabs}
          activeId={currentView}
          onSelect={(id) => onNavigate(id as 'terminal' | 'admin')}
          ariaLabel={t('header.mainNavigationAria')}
          className="shrink-0 gap-3"
        />

        <span aria-hidden="true" className="h-4 w-px shrink-0 bg-tui-border" />

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={toggleLanguage}
            className={cn(actionClass, actionIdle)}
            title={t('header.languageToggleTitle')}
            aria-label={t('header.languageToggleTitle')}
          >
            {language === 'zh' ? '中' : 'en'}
          </button>

          {currentView === 'terminal' && (
            <button
              type="button"
              onClick={onToggleVirtualKeyboard}
              className={cn(actionClass, isVirtualKeyboardOpen ? actionActive : actionIdle)}
              title={t('header.virtualKeyboardTitle')}
              aria-label={t('header.virtualKeyboardTitle')}
            >
              cmd
            </button>
          )}

          <button
            type="button"
            onClick={onOpenPairing}
            className={cn(actionClass, actionIdle)}
            title={t('header.pairingTitle')}
            aria-label={t('header.pairingTitle')}
          >
            link
          </button>

          <button
            type="button"
            onClick={onOpenSettings}
            className={cn(actionClass, actionIdle)}
            title={t('header.settingsTitle')}
            aria-label={t('header.settingsTitle')}
          >
            cfg
          </button>
        </div>
      </div>
    </header>
  );
};
