import React, { useEffect, useRef } from 'react';
import { useTerminal } from '../context/TerminalContext';
import { formatFontBytes } from '../utils/hostFont';
import { Button, Meter, Notice, Panel } from './tui';

/** Product names of the terminals the host can read; not translated. */
export const TERMINAL_SOURCE_NAMES: Record<string, string> = {
  'gnome-terminal': 'GNOME Terminal',
  ptyxis: 'Ptyxis',
  tilix: 'Tilix',
  konsole: 'Konsole',
  'xfce4-terminal': 'Xfce Terminal',
  kitty: 'kitty',
  alacritty: 'Alacritty',
  ghostty: 'Ghostty',
  wezterm: 'WezTerm',
  foot: 'foot',
  vscode: 'VS Code',
  iterm2: 'iTerm2',
  'apple-terminal': 'Terminal',
  xterm: 'xterm',
  urxvt: 'urxvt',
};

const KNOWN_REASONS = ['host_font_unavailable', 'host_font_timeout', 'disconnected', 'font_api_unavailable'];

/**
 * The workstation's terminal font is not on this device: fetch it?
 *
 * Asked once per workstation and font, the first time this browser meets it,
 * because the answer costs megabytes — which a phone on mobile data should
 * see before paying. The answer is remembered; Settings can sync again later.
 * Only asked while the terminal font setting follows the host, and never on
 * top of the "start Herdr" question.
 */
export const HostFontPrompt: React.FC = () => {
  const {
    hostFont,
    loadHostFont,
    declineHostFont,
    settings,
    herdrLaunch,
    hostname,
    activeProfile,
    addToast,
    t,
  } = useTerminal();

  const { font, status, glyphs } = hostFont;
  const busy = status === 'loading' || glyphs.status === 'loading';
  const failed = status === 'failed' || glyphs.status === 'failed';

  // One notice when a transfer the user started finishes, however many
  // chunks it took.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy && !failed && hostFont.interactive) addToast('success', t('hostFont.loaded'));
    wasBusy.current = busy && hostFont.interactive;
  }, [busy, failed, hostFont.interactive, addToast, t]);

  const asking = status === 'available' || glyphs.status === 'available';
  // A transfer the user started shows its progress here; one resumed on its
  // own (the answer was given before) stays out of the way.
  const working = hostFont.interactive && (busy || failed);
  const visible = font && settings.fontFamily === 'host' && !herdrLaunch && (asking || working);
  if (!visible) return null;

  const primaryAsked = status === 'available' || (hostFont.interactive && (status === 'loading' || status === 'failed'));
  const glyphsAsked = glyphs.source
    && (glyphs.status === 'available' || (hostFont.interactive && (glyphs.status === 'loading' || glyphs.status === 'failed')));

  const host = hostname || activeProfile?.displayName || t('herdrLaunch.thisHost');
  const details = [
    font.sizePx ? `${Math.round(font.sizePx)}px` : null,
    font.source ? TERMINAL_SOURCE_NAMES[font.source] || font.source : null,
  ].filter(Boolean).join(t('hostFont.detailSeparator'));
  const reason = hostFont.error && KNOWN_REASONS.includes(hostFont.error) ? hostFont.error : 'other';
  const ratio = hostFont.totalBytes ? hostFont.receivedBytes / hostFont.totalBytes : 0;

  return (
    <div
      data-testid="host-font-prompt"
      className="absolute inset-0 z-30 flex items-center justify-center bg-tui-crust/85 p-3"
    >
      <Panel
        title={t('hostFont.title')}
        tone={status === 'failed' ? 'bad' : 'accent'}
        className="w-full max-w-md"
        bodyClassName="space-y-3"
        aria-label={t('hostFont.title')}
      >
        <p className="leading-snug text-tui-text">
          {primaryAsked || !glyphs.source
            ? t('hostFont.body', {
              host,
              family: font.family,
              detail: details ? t('hostFont.detail', { detail: details }) : '',
            })
            : t('hostFont.bodyGlyphsOnly', { host, family: glyphs.source.family })}
        </p>

        {busy ? (
          <div className="space-y-1" role="status">
            <Meter value={ratio} width={32} className="max-w-full overflow-hidden" />
            <p className="text-tui-sm text-tui-muted">
              {t('hostFont.loading', {
                received: formatFontBytes(hostFont.receivedBytes),
                total: formatFontBytes(hostFont.totalBytes),
              })}
            </p>
          </div>
        ) : (
          <>
            {failed ? (
              <Notice tone="bad">
                {t('hostFont.failed', { reason: t(`hostFont.reasons.${reason}`) })}
              </Notice>
            ) : (
              <div className="space-y-1 text-tui-sm leading-snug text-tui-faint">
                {primaryAsked && font.faces.length ? (
                  <p>
                    {t('hostFont.download', {
                      count: font.faces.length,
                      size: formatFontBytes(hostFont.totalBytes),
                    })}
                  </p>
                ) : null}
                {glyphsAsked && glyphs.source ? (
                  <p>
                    {t(glyphs.source.scope === 'all' ? 'hostFont.glyphsAll' : 'hostFont.glyphs', {
                      family: glyphs.source.family,
                    })}
                  </p>
                ) : null}
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={declineHostFont}>{t('hostFont.decline')}</Button>
              <Button variant="primary" onClick={loadHostFont} autoFocus>
                {failed ? t('common.retry') : t('hostFont.load')}
              </Button>
            </div>
          </>
        )}
      </Panel>
    </div>
  );
};
