import React from 'react';
import { useTerminal } from '../context/TerminalContext';
import { RoleControlBadge } from './RoleControlBadge';
import { describeConnection } from '../utils/connectionStatus';
import { cn } from '../utils/cn';
import { translate } from '../i18n';
import { Button, GLYPH, Panel, Row, StatusDot } from './tui';
import { HostSwitcher } from './HostSwitcher';
import { copyText } from '../utils/clipboard';

export interface MobileControlSheetProps {
  onClose: () => void;
  onNavigateAdmin: () => void;
  showAdminEntry?: boolean;
  onOpenPairing: () => void;
  onOpenSettings: () => void;
  onAddProfile?: () => void;
}

/**
 * Everything the phone shell hides, as three framed panels.
 *
 * Actions are full-width rows with the cursor glyph in front, the way a TUI
 * menu is navigated: a `▸` and a word, at a height a thumb hits without aiming.
 * They are not a grid of icon tiles — an icon has to be learnt, a word does not,
 * and a translated word never overflows a 48px square.
 */
const actionRowClass =
  'tui-focusable group flex h-11 w-full select-none items-center gap-2 border px-2 text-left text-tui transition-colors';

const idleRowClass =
  'border-tui-border text-tui-muted hover:border-tui-accent hover:text-tui-accent active:bg-tui-selection';

const activeRowClass = 'border-tui-accent bg-tui-selection text-tui-accent';

const Cursor: React.FC<{ active?: boolean }> = ({ active = false }) => (
  <span
    aria-hidden="true"
    className={cn(
      'shrink-0',
      active ? 'text-tui-accent' : 'text-tui-faint group-hover:text-tui-accent'
    )}
  >
    {GLYPH.cursor}
  </span>
);

export const MobileControlSheet: React.FC<MobileControlSheetProps> = ({
  onClose,
  onNavigateAdmin,
  showAdminEntry = true,
  onOpenPairing,
  onOpenSettings,
  onAddProfile = () => {},
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

  /**
   * Runs a sheet action with the pressed button already blurred.
   *
   * The action unmounts this sheet. A focused element disappearing mid-frame
   * makes the browser hunt for somewhere to put focus and scroll there, which
   * is seen as the page jumping the instant a panel opens.
   */
  const withoutFocusScroll = (action: () => void) => () => {
    const focused = document.activeElement as HTMLElement | null;
    focused?.blur?.();
    action();
  };

  const copyClientId = () => {
    copyText(settings.clientId).then((res) => {
      if (res === 'failed') {
        addToast('error', t('clipboard.copyFailed'));
        return;
      }
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
    <div className="flex flex-col gap-3 px-3 pb-2 pt-2">
      <div className="flex items-center justify-between gap-2 border-b border-tui-border pb-1.5">
        <h2 className="text-tui font-bold uppercase text-tui-accent">
          {t('mobile.sessionControls')}
        </h2>
        <Button
          variant="ghost"
          onClick={onClose}
          aria-label={t('mobile.closeSessionControls')}
        >
          esc
        </Button>
      </div>

      {/* Saved Herdr instances. This list is local-only and never comes from
          relay-wide discovery. */}
      <Panel title={t('profiles.title')} tone="accent" bodyClassName="space-y-1">
        <HostSwitcher mobile onAddProfile={onAddProfile} />
      </Panel>

      {/* Connection */}
      <Panel
        title={t('common.status')}
        tone={status.level === 'ok' ? 'ok' : status.level === 'bad' ? 'bad' : 'warn'}
        bodyClassName="space-y-1.5"
      >
        <div className="flex items-center justify-between gap-2" aria-label={t('mobile.connectionStatusAria')}>
          <div className="flex min-w-0 items-center gap-1.5">
            <StatusDot level={status.level} />
            <span className="truncate text-tui uppercase text-tui-text">
              {status.label}
            </span>
            {connectionState === 'connected' && rttMs !== null && (
              <span className="text-tui-sm text-tui-muted">{rttMs}ms</span>
            )}
          </div>
          {status.actionLabel && (
            <Button variant="primary" onClick={() => connect()} className="shrink-0">
              {status.actionLabel}
            </Button>
          )}
        </div>

        {status.needsAttention && stateDetail && (
          <p className="text-tui-sm leading-snug text-tui-muted">{stateDetail}</p>
        )}

        {hostId && <Row label={t('common.host')} labelWidth={9}>{hostId}</Row>}

        <button
          type="button"
          onClick={copyClientId}
          className="tui-focusable flex w-full items-baseline gap-2 text-left text-tui"
          title={t('header.copyClientIdTitle')}
        >
          <span className="shrink-0 text-tui-muted" style={{ width: '9ch' }}>
            {t('header.clientIdLabel')}
          </span>
          <span className="min-w-0 flex-1 truncate text-tui-text">{settings.clientId}</span>
          <span
            aria-hidden="true"
            className={cn('shrink-0', copiedClientId ? 'text-tui-ok' : 'text-tui-faint')}
          >
            {copiedClientId ? GLYPH.check : '⧉'}
          </span>
        </button>
      </Panel>

      {/* Control lease — the switch between viewer and full input */}
      <Panel
        title={t('mobile.inputControl')}
        tone="accent"
        aria-label={t('mobile.terminalControlAria')}
      >
        <RoleControlBadge />
      </Panel>

      {/* Menu */}
      <Panel title={t('mobile.menu')} tone="accent" bodyClassName="flex flex-col gap-1">
        <button
          type="button"
          onClick={toggleLanguage}
          className={cn(actionRowClass, idleRowClass)}
          aria-label={t('header.languageToggleTitle')}
        >
          <Cursor />
          <span className="truncate">{language === 'zh' ? 'English' : '中文'}</span>
        </button>

        <button
          type="button"
          onClick={withoutFocusScroll(onOpenSettings)}
          className={cn(actionRowClass, idleRowClass)}
          aria-label={t('mobile.settingsAria')}
        >
          <Cursor />
          <span className="truncate">{t('common.settings')}</span>
        </button>

        <button
          type="button"
          onClick={withoutFocusScroll(onOpenPairing)}
          className={cn(actionRowClass, idleRowClass)}
          aria-label={t('mobile.pairingAria')}
        >
          <Cursor />
          <span className="truncate">{t('common.pairing')}</span>
        </button>

        {showAdminEntry && (
          <button
            type="button"
            onClick={withoutFocusScroll(onNavigateAdmin)}
            className={cn(actionRowClass, idleRowClass)}
            aria-label={t('mobile.adminAria')}
          >
            <Cursor />
            <span className="truncate">{t('common.admin')}</span>
          </button>
        )}

        <button
          type="button"
          onClick={() => updateSettings({ toolbarVisible: !settings.toolbarVisible })}
          className={cn(
            actionRowClass,
            settings.toolbarVisible ? activeRowClass : idleRowClass
          )}
          aria-label={t('mobile.keybarAria')}
          aria-pressed={settings.toolbarVisible}
        >
          <Cursor active={settings.toolbarVisible} />
          <span className="truncate">{t('common.keyBar')}</span>
          <span aria-hidden="true" className="ml-auto shrink-0 text-tui-sm">
            {settings.toolbarVisible ? '[x]' : '[ ]'}
          </span>
        </button>
      </Panel>
    </div>
  );
};
