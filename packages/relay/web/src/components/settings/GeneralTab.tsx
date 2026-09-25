import type React from 'react';
import { useConnection, useSettings } from '../../context/TerminalContext';
import { playAlertChime, unlockAlertChime } from '../../utils/alertChime';
import { cn } from '../../utils/cn';
import { clampFontSize } from '../../utils/terminalLayout';
import { FONT_PRESETS } from '../../utils/theme';
import { TERMINAL_SOURCE_NAMES } from '../HostFontPrompt';
import {
  Button,
  CONTROL_H,
  GLYPH,
  Segmented,
  Select,
  SettingRow,
  SettingSection,
  Toggle,
} from '../tui';
import { CONTROL_FIELD, toggleWords } from './styles';

/** Language, font, input and alerts; and the way to the relay dashboard. */
export const GeneralTab: React.FC<{ onOpenAdmin?: () => void }> = ({ onOpenAdmin }) => {
  const {
    settings,
    updateSettings,
    language,
    setLanguage,
    t,
    hostFont,
    syncHostFont,
    terminalFontFamily,
    terminalFontSize,
  } = useSettings();
  const { connectionState } = useConnection();

  /** A legacy/custom stack keeps its own option so the select never lies. */
  const activeFontPreset = FONT_PRESETS.find((preset) => preset.id === settings.fontFamily);
  const presetLabel = (id: string, name: string) =>
    id === 'host' || id === 'system' ? t(`fontPresets.${id}`) : name;
  /** `JetBrainsMono Nerd Font · 12px · GNOME Terminal · Loaded from the workstation` */
  const hostFontLine = (() => {
    const { font, status } = hostFont;
    const percent = hostFont.totalBytes
      ? Math.round((hostFont.receivedBytes / hostFont.totalBytes) * 100)
      : 0;
    const statusText = t(`settings.hostFontStatus.${status}`, { percent });
    if (!font) return statusText;
    return [
      font.family,
      font.sizePx ? `${Math.round(font.sizePx)}px` : null,
      font.source ? TERMINAL_SOURCE_NAMES[font.source] || font.source : null,
      statusText,
    ]
      .filter(Boolean)
      .join(' · ');
  })();
  const hostSizePx = hostFont.font?.sizePx ? clampFontSize(hostFont.font.sizePx) : null;
  /** `CJK: Noto Sans CJK SC · 3,812 characters on this device…` */
  const hostGlyphLine =
    hostFont.glyphs.source && hostFont.glyphs.status !== 'none'
      ? t('settings.hostGlyphLine', {
          family: hostFont.glyphs.source.family,
          status: t(`settings.hostGlyphStatus.${hostFont.glyphs.status}`, {
            count: hostFont.glyphs.covered.toLocaleString(),
          }),
        })
      : null;

  // Plain HTTP on a LAN is not a secure context, and there the API is absent.
  const notificationsAvailable =
    typeof window !== 'undefined' && window.isSecureContext && 'Notification' in window;

  const FONT_MIN = 10;
  const FONT_MAX = 24;

  const toggles = toggleWords(t);
  const followHostLabel = hostSizePx
    ? t('settings.fontSizeFollowHost', { size: hostSizePx })
    : t('settings.fontSizeFollowHostUnknown');

  return (
    <div className="space-y-4">
      <SettingSection title={t('settings.sectionInterface')}>
        <SettingRow
          label={t('settings.languageLabel')}
          control={
            <Segmented
              name="ui-language"
              aria-label={t('settings.languageLabel')}
              value={language}
              onChange={setLanguage}
              options={[
                { value: 'zh', label: '简体中文' },
                { value: 'en', label: 'English' },
              ]}
            />
          }
        />
      </SettingSection>

      <SettingSection title={t('settings.sectionFont')}>
        <SettingRow
          label={t('settings.fontFamilyLabel')}
          htmlFor="terminal-font-select"
          control={
            <Select
              id="terminal-font-select"
              value={settings.fontFamily}
              onChange={(e) => updateSettings({ fontFamily: e.target.value })}
              aria-label={t('settings.fontFamilyLabel')}
              className={CONTROL_FIELD}
            >
              {!activeFontPreset && (
                <option value={settings.fontFamily}>{settings.fontFamily}</option>
              )}
              {FONT_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {presetLabel(preset.id, preset.name)}
                </option>
              ))}
            </Select>
          }
        />

        {/* What the workstation reported, and whether this device has it. */}
        {settings.fontFamily === 'host' && (
          <SettingRow
            label={t('settings.hostFontLabel')}
            hint={
              <>
                <span data-testid="host-font-status" className="block break-words text-tui-info">
                  {hostFontLine}
                </span>
                {hostGlyphLine ? (
                  <span data-testid="host-glyph-status" className="block break-words">
                    {hostGlyphLine}
                  </span>
                ) : null}
              </>
            }
            control={
              <Button
                block
                onClick={syncHostFont}
                disabled={
                  connectionState !== 'connected' ||
                  hostFont.status === 'loading' ||
                  hostFont.glyphs.status === 'loading'
                }
                className={CONTROL_FIELD}
              >
                {t('settings.hostFontSync')}
              </Button>
            }
          />
        )}

        <SettingRow
          label={t('settings.fontSizeLabel', { size: terminalFontSize })}
          hint={t('settings.fontSizeHint')}
          htmlFor="terminal-font-size"
          control={
            <div className={cn('flex items-center', CONTROL_H)}>
              <input
                id="terminal-font-size"
                type="range"
                min={FONT_MIN}
                max={FONT_MAX}
                step={1}
                value={terminalFontSize}
                onChange={(e) =>
                  updateSettings({
                    fontSize: Number(e.target.value),
                    fontSizeFollowsHost: false,
                  })
                }
                className="h-1 w-full cursor-pointer appearance-none bg-tui-border accent-tui-accent"
              />
            </div>
          }
        />

        <SettingRow
          label={followHostLabel}
          control={
            <Toggle
              label={followHostLabel}
              {...toggles}
              checked={settings.fontSizeFollowsHost}
              // Leaving "follow" keeps the size on screen as the manual one,
              // so the terminal does not jump when it is switched off.
              onChange={(checked) =>
                updateSettings(
                  checked
                    ? { fontSizeFollowsHost: true }
                    : { fontSizeFollowsHost: false, fontSize: terminalFontSize },
                )
              }
            />
          }
        />

        {/* Live preview, rendered as a shell prompt in the chosen face. */}
        <div className="py-1.5">
          <div
            className="overflow-x-auto whitespace-nowrap border border-tui-border bg-tui-mantle px-2 py-1.5 leading-snug text-tui-text"
            style={{ fontFamily: terminalFontFamily, fontSize: `${terminalFontSize}px` }}
          >
            <span className="text-tui-ok">$</span> echo &quot;Herdr 0O 1lI {} [] () -&gt; =&gt;
            !=&quot;
          </div>
        </div>
      </SettingSection>

      <SettingSection title={t('settings.sectionInput')}>
        <SettingRow
          label={t('settings.predictiveEchoLabel')}
          hint={t('settings.predictiveEchoDesc')}
          control={
            <Segmented
              name="predictive-echo"
              aria-label={t('settings.predictiveEchoLabel')}
              value={settings.predictiveEcho}
              onChange={(predictiveEcho) => updateSettings({ predictiveEcho })}
              options={[
                { value: 'auto', label: t('settings.predictiveEchoAuto') },
                { value: 'always', label: t('settings.predictiveEchoAlways') },
                { value: 'off', label: t('settings.predictiveEchoOff') },
              ]}
            />
          }
        />
        <SettingRow
          label={t('settings.touchKeyToolbar')}
          hint={t('settings.touchKeyToolbarDesc')}
          control={
            <Toggle
              label={t('settings.touchKeyToolbar')}
              {...toggles}
              checked={settings.toolbarVisible}
              onChange={(checked) => updateSettings({ toolbarVisible: checked })}
            />
          }
        />
        <SettingRow
          label={t('settings.touchHaptics')}
          hint={t('settings.touchHapticsDesc')}
          control={
            <Toggle
              label={t('settings.touchHaptics')}
              {...toggles}
              checked={settings.vibrateOnKeyPress}
              onChange={(checked) => updateSettings({ vibrateOnKeyPress: checked })}
            />
          }
        />
      </SettingSection>

      <SettingSection title={t('settings.agentAlertsLabel')}>
        <SettingRow
          label={t('settings.agentAlertBadge')}
          hint={t('settings.agentAlertBadgeDesc')}
          control={
            <Toggle
              label={t('settings.agentAlertBadge')}
              {...toggles}
              checked={settings.agentAlertBadge}
              onChange={(checked) => updateSettings({ agentAlertBadge: checked })}
            />
          }
        />
        <SettingRow
          label={t('settings.agentAlertVibrate')}
          hint={t('settings.agentAlertVibrateDesc')}
          control={
            <Toggle
              label={t('settings.agentAlertVibrate')}
              {...toggles}
              checked={settings.agentAlertVibrate}
              onChange={(checked) => updateSettings({ agentAlertVibrate: checked })}
            />
          }
        />
        <SettingRow
          label={t('settings.agentAlertSound')}
          hint={t('settings.agentAlertSoundDesc')}
          control={
            <Toggle
              label={t('settings.agentAlertSound')}
              {...toggles}
              checked={settings.agentAlertSound}
              onChange={(checked) => {
                updateSettings({ agentAlertSound: checked });
                // This click is the gesture a browser wants before it plays
                // anything; use it, and let the person hear what they chose.
                if (checked) {
                  unlockAlertChime();
                  playAlertChime('done');
                }
              }}
            />
          }
        />
        {notificationsAvailable && (
          <SettingRow
            label={t('settings.agentAlertNotify')}
            hint={t('settings.agentAlertNotifyDesc')}
            control={
              <Toggle
                label={t('settings.agentAlertNotify')}
                {...toggles}
                checked={settings.agentAlertNotify}
                onChange={(checked) => {
                  if (checked && Notification.permission !== 'granted') {
                    void Notification.requestPermission().then((permission) =>
                      updateSettings({ agentAlertNotify: permission === 'granted' }),
                    );
                    return;
                  }
                  updateSettings({ agentAlertNotify: checked });
                }}
              />
            }
          />
        )}
      </SettingSection>

      {/* The dashboard's only signpost. It is not an access control — the
          dashboard asks for the relay's admin token before it shows anything
          — so it can live where every device can reach it. */}
      {onOpenAdmin && (
        <SettingSection title={t('settings.sectionAdmin')}>
          <SettingRow
            label={t('settings.adminEntry')}
            hint={t('settings.adminEntryHint')}
            control={
              <Button
                block
                variant="primary"
                glyph={GLYPH.arrowRight}
                onClick={onOpenAdmin}
                className={CONTROL_FIELD}
              >
                {t('settings.adminEntryOpen')}
              </Button>
            }
          />
        </SettingSection>
      )}
    </div>
  );
};
