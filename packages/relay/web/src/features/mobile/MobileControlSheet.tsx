import type React from 'react';
import { useRef, useState } from 'react';
import { useSettings, useConnection, useToasts, useTerminalIO } from '@/context/TerminalContext';
import { ControlModeSwitch } from '@/features/status/ControlModeSwitch';
import { describeConnection } from '@/connection/connectionStatus';
import { UploadFileInputs } from '@/features/keyboard/UploadControls';
import { cn } from '@/shared/lib/cn';
import { translate } from '@/shared/i18n';
import { Button, GLYPH, Notice, Panel, StatusDot } from '@/shared/ui';
import { useCopyFeedback } from '@/context/useCopyFeedback';

export interface MobileControlSheetProps {
  onClose: () => void;
  onOpenSettings: () => void;
  /** Open the paste box / the file list. Both outlive the sheet, so the shell owns them. */
  onOpenPaste: () => void;
  onOpenFiles: () => void;
}

/**
 * Everything the phone shell hides, opened from the dock's ☰.
 *
 * The quick actions lead because they are why the sheet was opened most of
 * the time; the session rows below are words, not icon tiles — an icon has
 * to be learnt, a word does not, and a translated word never overflows a
 * 48px square.
 */
const actionRowClass =
  'tui-focusable group flex h-11 w-full select-none items-center gap-2 border border-tui-border px-2 text-left text-tui transition-colors';

const idleRowClass =
  'text-tui-muted hover:border-tui-accent hover:text-tui-accent active:bg-tui-selection';

const quickCellClass =
  'tui-focusable flex h-11 select-none items-center justify-center gap-1.5 border border-tui-border text-tui text-tui-text transition-colors hover:border-tui-accent hover:text-tui-accent active:bg-tui-selection';

export const MobileControlSheet: React.FC<MobileControlSheetProps> = ({
  onClose,
  onOpenSettings,
  onOpenPaste,
  onOpenFiles,
}) => {
  const { settings, updateSettings, language, setLanguage, t } = useSettings();
  const { connectionState, stateDetail, rttMs, hostId, assignedClientId, isController, connect } =
    useConnection();
  const { warnViewerMode } = useTerminalIO();
  const { addToast } = useToasts();

  const { copied, copy } = useCopyFeedback();
  const copiedClientId = copied !== null;
  const status = describeConnection(connectionState, t);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const anyFileInputRef = useRef<HTMLInputElement | null>(null);
  const displayedClientId = assignedClientId || settings.clientId;
  const copyClientId = () =>
    copy(displayedClientId, t('toasts.clientIdCopied', { id: displayedClientId }), 'info');

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

  const pickFile = (ref: React.RefObject<HTMLInputElement | null>) => () => {
    if (!isController) {
      warnViewerMode();
      return;
    }
    ref.current?.click();
  };

  const detailRowClass = 'flex w-full items-baseline gap-2 text-left text-tui-sm';
  const detailWords = (label: string, value: string) => (
    <>
      <span className="shrink-0 text-tui-faint" style={{ width: '9ch' }}>
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-tui-muted">{value}</span>
    </>
  );

  return (
    <div className="flex flex-col gap-3 px-3 pb-2 pt-1">
      {/* The sheet steps aside once a file is chosen, so the upload's progress
          and the terminal it lands in are what is on screen. */}
      <UploadFileInputs
        fileInputRef={fileInputRef}
        anyFileInputRef={anyFileInputRef}
        onPicked={onClose}
      />
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

      {status.needsAttention && (
        <Notice
          tone={status.level === 'bad' ? 'bad' : 'warn'}
          action={
            status.actionLabel ? (
              <Button variant="warn" onClick={() => connect()}>
                {status.actionLabel}
              </Button>
            ) : undefined
          }
        >
          <span className="block font-bold">{status.label}</span>
          {stateDetail ? <span className="block text-tui-muted">{stateDetail}</span> : null}
        </Notice>
      )}

      {/* The three taps the sheet exists for, first. */}
      <div className="grid grid-cols-3 gap-1">
        <button
          type="button"
          className={quickCellClass}
          onClick={() => (isController ? onOpenPaste() : warnViewerMode())}
        >
          {t('clipboard.paste')}
        </button>
        <button type="button" className={quickCellClass} onClick={pickFile(fileInputRef)}>
          {t('virtualKeyboard.uploadImage')}
        </button>
        <button type="button" className={quickCellClass} onClick={pickFile(anyFileInputRef)}>
          {t('virtualKeyboard.uploadFile')}
        </button>
      </div>

      {/* Session rows: the things a phone needs that are not keys. */}
      <Panel title={t('mobile.sessionPanel')} tone="accent" bodyClassName="flex flex-col gap-1">
        <div className="flex items-center gap-1.5 px-1 py-0.5 text-tui-sm">
          <StatusDot level={status.level} />
          <span className="truncate uppercase text-tui-text">{status.label}</span>
          {connectionState === 'connected' && rttMs !== null && (
            <span className="text-tui-muted">{rttMs}ms</span>
          )}
          <button
            type="button"
            className="tui-focusable ml-auto flex h-11 items-center px-2 text-tui text-tui-muted hover:text-tui-accent"
            onClick={() => (isController ? onOpenFiles() : warnViewerMode())}
          >
            {t('virtualKeyboard.fileList')} ›
          </button>
        </div>

        <div className="px-1 py-0.5">
          <div className="pb-1 text-tui-sm text-tui-faint">{t('mobile.inputControl')}</div>
          <ControlModeSwitch className="h-11" />
        </div>

        <button
          type="button"
          onClick={() => updateSettings({ toolbarVisible: !settings.toolbarVisible })}
          className={cn(actionRowClass, idleRowClass)}
          aria-label={t('mobile.keybarAria')}
          aria-pressed={settings.toolbarVisible}
        >
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
          onClick={() => {
            const focused = document.activeElement as HTMLElement | null;
            focused?.blur?.();
            onOpenSettings();
          }}
          className={cn(actionRowClass, idleRowClass)}
          aria-label={t('mobile.settingsAria')}
        >
          <span className="truncate">{t('common.settings')}</span>
          <span aria-hidden="true" className="ml-auto shrink-0 text-tui-faint">
            {GLYPH.chevronRight}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setDetailsOpen((open) => !open)}
          aria-expanded={detailsOpen}
          className={cn(actionRowClass, idleRowClass)}
        >
          <span aria-hidden="true" className="shrink-0 text-tui-faint">
            {detailsOpen ? GLYPH.chevronDown : GLYPH.chevronRight}
          </span>
          <span className="truncate">{t('mobile.connectionDetails')}</span>
        </button>
        {detailsOpen && (
          <div className="space-y-1 border-l border-tui-border-dim pb-1 pl-2">
            {/* Only the row that copies is a button; the host is just text. */}
            {hostId ? (
              <div className={detailRowClass}>{detailWords(t('common.host'), hostId)}</div>
            ) : null}
            <button
              type="button"
              onClick={copyClientId}
              className={cn(detailRowClass, 'tui-focusable')}
              title={t('header.copyClientIdTitle')}
            >
              {detailWords(t('header.clientIdLabel').replace(/:$/, ''), displayedClientId)}
              <span
                aria-hidden="true"
                className={cn('shrink-0', copiedClientId ? 'text-tui-ok' : 'text-tui-faint')}
              >
                {copiedClientId ? GLYPH.check : '⧉'}
              </span>
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={toggleLanguage}
          className={cn(actionRowClass, idleRowClass)}
          aria-label={t('header.languageToggleTitle')}
        >
          <span className="truncate">{t('mobile.languageRow')}</span>
          <span aria-hidden="true" className="ml-auto shrink-0 text-tui-sm text-tui-faint">
            {language === 'zh' ? '中' : 'EN'}
          </span>
        </button>
      </Panel>
    </div>
  );
};
