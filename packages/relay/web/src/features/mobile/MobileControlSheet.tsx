import type React from 'react';
import { useState } from 'react';
import { useSettings, useConnection, useToasts } from '@/context/TerminalContext';
import { ControlModeSwitch } from '@/features/status/ControlModeSwitch';
import { describeConnection } from '@/connection/connectionStatus';
import { cn } from '@/shared/lib/cn';
import { translate } from '@/shared/i18n';
import { Button, GLYPH, Panel, StatusDot } from '@/shared/ui';
import { useCopyFeedback } from '@/context/useCopyFeedback';

export interface MobileControlSheetProps {
  onClose: () => void;
  onOpenSettings: () => void;
}

/**
 * Everything the phone shell hides, as framed panels.
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

const Cursor: React.FC<{ active?: boolean }> = ({ active = false }) => (
  <span
    aria-hidden="true"
    className={cn(
      'shrink-0',
      active ? 'text-tui-accent' : 'text-tui-faint group-hover:text-tui-accent',
    )}
  >
    {GLYPH.cursor}
  </span>
);

export const MobileControlSheet: React.FC<MobileControlSheetProps> = ({
  onClose,
  onOpenSettings,
}) => {
  const { settings, updateSettings, language, setLanguage, t } = useSettings();
  const { connectionState, stateDetail, rttMs, hostId, assignedClientId, connect } =
    useConnection();
  const { addToast } = useToasts();

  const { copied, copy } = useCopyFeedback();
  const copiedClientId = copied !== null;
  const status = describeConnection(connectionState, t);
  const [detailsOpen, setDetailsOpen] = useState(false);

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

  const copyClientId = () =>
    copy(settings.clientId, t('toasts.clientIdCopied', { id: settings.clientId }), 'info');

  const toggleLanguage = () => {
    const nextLang = language === 'zh' ? 'en' : 'zh';
    setLanguage(nextLang);
    addToast(
      'info',
      translate(nextLang, 'toasts.switchedLanguage', {
        lang: nextLang === 'zh' ? '简体中文' : 'English',
      }),
    );
  };

  const detailRow = (label: string, value: string, copyable = false) => (
    <button
      type="button"
      onClick={copyable ? copyClientId : undefined}
      className={cn(
        'flex w-full items-baseline gap-2 text-left text-tui-sm',
        copyable && 'tui-focusable',
      )}
      title={copyable ? t('header.copyClientIdTitle') : undefined}
      tabIndex={copyable ? 0 : -1}
    >
      <span className="shrink-0 text-tui-faint" style={{ width: '9ch' }}>
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-tui-muted">{value}</span>
      {copyable ? (
        <span
          aria-hidden="true"
          className={cn('shrink-0', copiedClientId ? 'text-tui-ok' : 'text-tui-faint')}
        >
          {copiedClientId ? GLYPH.check : '⧉'}
        </span>
      ) : null}
    </button>
  );

  return (
    <div className="flex flex-col gap-3 px-3 pb-2 pt-1">
      <div className="flex items-center justify-between gap-2 border-b border-tui-border pb-1.5">
        <h2 className="text-tui font-bold uppercase text-tui-accent">
          {t('mobile.sessionControls')}
        </h2>
        <Button
          variant="ghost"
          onClick={onClose}
          aria-label={t('mobile.closeSessionControls')}
          title={t('mobile.closeSessionControls')}
        >
          {GLYPH.cross}
        </Button>
      </div>

      {/* Connection state, once: the top bar and the status bar both carry a
          dot, so the sheet keeps the words and the retry, not another lamp.
          The ids nobody reads mid-session fold into "details". */}
      <Panel
        title={t('common.status')}
        tone={status.level === 'ok' ? 'ok' : status.level === 'bad' ? 'bad' : 'warn'}
        bodyClassName="space-y-1.5"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <StatusDot level={status.level} />
            <span className="truncate text-tui uppercase text-tui-text">{status.label}</span>
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

        <button
          type="button"
          onClick={() => setDetailsOpen((open) => !open)}
          aria-expanded={detailsOpen}
          className={cn(actionRowClass, idleRowClass, 'h-9 text-tui-sm')}
        >
          <span aria-hidden="true" className="shrink-0 text-tui-faint">
            {detailsOpen ? GLYPH.chevronDown : GLYPH.chevronRight}
          </span>
          <span className="truncate">{t('mobile.connectionDetails')}</span>
        </button>
        {detailsOpen && (
          <div className="space-y-1 border-l border-tui-border-dim pl-2">
            {hostId ? detailRow(t('common.host'), hostId) : null}
            {detailRow(
              t('header.clientIdLabel').replace(/:$/, ''),
              assignedClientId || settings.clientId,
              true,
            )}
            {assignedClientId && assignedClientId !== settings.clientId
              ? detailRow(t('role.thisWindow'), assignedClientId)
              : null}
          </div>
        )}
      </Panel>

      {/* This window's input: full control, or only watching */}
      <Panel
        title={t('mobile.inputControl')}
        tone="accent"
        aria-label={t('mobile.terminalControlAria')}
      >
        <ControlModeSwitch className="h-11" />
      </Panel>

      {/* Menu: the most-used first. Language is last because it is the one
          choice a person makes once. */}
      <Panel title={t('mobile.menu')} tone="accent" bodyClassName="flex flex-col gap-1">
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
          onClick={() => updateSettings({ toolbarVisible: !settings.toolbarVisible })}
          className={cn(actionRowClass, idleRowClass)}
          aria-label={t('mobile.keybarAria')}
          aria-pressed={settings.toolbarVisible}
        >
          <Cursor active={settings.toolbarVisible} />
          <span className="truncate">{t('common.keyBar')}</span>
          <span
            aria-hidden="true"
            className={cn(
              'ml-auto shrink-0 text-tui-sm',
              settings.toolbarVisible ? 'text-tui-ok' : 'text-tui-faint',
            )}
          >
            {settings.toolbarVisible ? t('settings.toggleOn') : t('settings.toggleOff')}
          </span>
        </button>

        <button
          type="button"
          onClick={toggleLanguage}
          className={cn(actionRowClass, idleRowClass)}
          aria-label={t('header.languageToggleTitle')}
        >
          <Cursor />
          <span className="truncate">{t('mobile.languageRow')}</span>
          <span aria-hidden="true" className="ml-auto shrink-0 text-tui-sm text-tui-faint">
            {language === 'zh' ? '中' : 'EN'}
          </span>
        </button>
      </Panel>
    </div>
  );
};
