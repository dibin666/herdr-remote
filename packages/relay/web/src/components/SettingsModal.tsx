import React, { useEffect, useRef, useState } from 'react';
import { useTerminal } from '../context/TerminalContext';
import { getDefaultSettings } from '../utils/storage';
import { FONT_PRESETS } from '../utils/theme';
import { clampFontSize } from '../utils/terminalLayout';
import { TERMINAL_SOURCE_NAMES } from './HostFontPrompt';
import {
  ToolbarKeyDef,
  ALL_AVAILABLE_KEYS,
  getDefaultVirtualKeys,
  getLocalizedKeyTitle,
} from '../utils/virtualKeys';
import { cn } from '../utils/cn';
import { playAlertChime, unlockAlertChime } from '../utils/alertChime';
import { formatComboCaption, KeyComboError, parseKeyCombo } from '../protocol/keyCombo';
import {
  AGENT_PROFILE_IDS,
  AGENT_PROFILES,
  clearBarVisibility,
  getBarChoices,
  getProfileActions,
  type AgentProfileId,
  type AgentProfileDef,
  type AgentProfileKeymapOverride,
  type AppliedAgentAction,
} from '../utils/agentKeymaps';
import {
  Button,
  Checkbox,
  FieldLabel,
  GLYPH,
  Input,
  KeyCap,
  Meter,
  Modal,
  Radio,
  Rule,
  Select,
  Tabs,
} from './tui';

export type SettingsTab = 'appearance' | 'virtualKeys' | 'agentKeymaps';

/**
 * One agent-key row. Every column has a fixed width so the combo fields and
 * buttons line up down the list; a phone splits the row over two lines.
 */
const AGENT_ROW_GRID = [
  'grid items-center gap-x-2 gap-y-1 border-b border-tui-border-dim px-2 py-1.5 last:border-b-0',
  "grid-cols-[5rem_minmax(0,1fr)_6.5rem] [grid-template-areas:'cap_label_actions'_'combo_combo_default']",
  "sm:grid-cols-[5rem_minmax(0,1fr)_9rem_7rem_6.5rem] sm:[grid-template-areas:'cap_label_combo_default_actions']",
].join(' ');

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Open on this tab, showing the focused agent, instead of where it was left. */
  initialTab?: SettingsTab;
}

/**
 * Preferences, as a TUI settings screen.
 *
 * Numbered tabs across the top, a label column down the left, bracketed
 * checkboxes for booleans and a `█░` meter for the one continuous value. The
 * only thing here that paints a colour is the terminal font preview, and that
 * colour belongs to the host.
 */
export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, initialTab }) => {
  const {
    settings,
    updateSettings,
    addToast,
    language,
    setLanguage,
    t,
    agentProfile,
    connectionState,
    hostFont,
    syncHostFont,
    terminalFontFamily,
    terminalFontSize,
  } = useTerminal();
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance');
  const [settingsAgentProfile, setSettingsAgentProfile] = useState<AgentProfileId | null>(null);
  const [comboDrafts, setComboDrafts] = useState<Record<string, string>>({});
  const comboDraftsRef = useRef<Record<string, string>>({});
  const [customLabel, setCustomLabel] = useState('');
  const [customCombo, setCustomCombo] = useState('');
  const [showAddKeyPalette, setShowAddKeyPalette] = useState(false);

  useEffect(() => {
    if (!isOpen || !initialTab) return;
    setActiveTab(initialTab);
    setSettingsAgentProfile(null);
  }, [isOpen, initialTab]);

  if (!isOpen) return null;

  /** A legacy/custom stack keeps its own option so the select never lies. */
  const activeFontPreset = FONT_PRESETS.find((preset) => preset.id === settings.fontFamily);
  const presetLabel = (id: string, name: string) => (
    id === 'host' || id === 'system' ? t(`fontPresets.${id}`) : name
  );
  /** `JetBrainsMono Nerd Font · 12px · GNOME Terminal · Loaded from the workstation` */
  const hostFontLine = (() => {
    const { font, status } = hostFont;
    const percent = hostFont.totalBytes ? Math.round((hostFont.receivedBytes / hostFont.totalBytes) * 100) : 0;
    const statusText = t(`settings.hostFontStatus.${status}`, { percent });
    if (!font) return statusText;
    return [
      font.family,
      font.sizePx ? `${Math.round(font.sizePx)}px` : null,
      font.source ? TERMINAL_SOURCE_NAMES[font.source] || font.source : null,
      statusText,
    ].filter(Boolean).join(' · ');
  })();
  const hostSizePx = hostFont.font?.sizePx ? clampFontSize(hostFont.font.sizePx) : null;
  /** `CJK: Noto Sans CJK SC · 3,812 characters on this device…` */
  const hostGlyphLine = hostFont.glyphs.source && hostFont.glyphs.status !== 'none'
    ? t('settings.hostGlyphLine', {
      family: hostFont.glyphs.source.family,
      status: t(`settings.hostGlyphStatus.${hostFont.glyphs.status}`, {
        count: hostFont.glyphs.covered.toLocaleString(),
      }),
    })
    : null;

  const currentVirtualKeys: ToolbarKeyDef[] =
    settings.virtualKeys && settings.virtualKeys.length > 0
      ? settings.virtualKeys
      : getDefaultVirtualKeys();

  const keymapProfile = settingsAgentProfile || agentProfile;
  const profileOverrides: AgentProfileKeymapOverride = settings.agentKeymaps[keymapProfile] || {};
  const profileActions = getProfileActions(keymapProfile, profileOverrides);
  const barChoices = getBarChoices(keymapProfile, profileOverrides);
  const shownBarCount = barChoices.filter((item) => !item.hidden).length;
  const actionLabel = (item: AppliedAgentAction) => (item.custom
    ? item.customLabel || ''
    : t(`agentActions.${item.labelKey}`));
  const actionCaption = (item: AppliedAgentAction) => {
    try { return formatComboCaption(item.combo); } catch { return item.combo; }
  };

  const saveAgentKeymaps = (nextProfile: AgentProfileKeymapOverride) => {
    updateSettings({
      agentKeymaps: { ...settings.agentKeymaps, [keymapProfile]: nextProfile },
    });
  };

  const updateAgentAction = (id: string, patch: { keys?: string; hidden?: boolean }) => {
    saveAgentKeymaps({
      ...profileOverrides,
      actions: {
        ...profileOverrides.actions,
        [id]: { ...profileOverrides.actions?.[id], ...patch },
      },
    });
  };

  const resetAgentAction = (item: AppliedAgentAction) => {
    updateAgentAction(item.id, { keys: item.defaultCombo });
  };

  const moveAgentAction = (index: number, direction: 'up' | 'down') => {
    const nextIndex = index + (direction === 'up' ? -1 : 1);
    if (nextIndex < 0 || nextIndex >= profileActions.length) return;
    const order = profileActions.map((item) => item.id);
    [order[index], order[nextIndex]] = [order[nextIndex], order[index]];
    saveAgentKeymaps({ ...profileOverrides, order });
  };

  const removeCustomAction = (id: string) => {
    saveAgentKeymaps({
      ...profileOverrides,
      custom: (profileOverrides.custom || []).filter((item) => item.id !== id),
      order: profileOverrides.order?.filter((item) => item !== id),
    });
  };

  const restoreBarVisibility = () => saveAgentKeymaps(clearBarVisibility(profileOverrides));

  const restoreAgentProfile = () => {
    const next = { ...settings.agentKeymaps };
    delete next[keymapProfile];
    updateSettings({ agentKeymaps: next });
  };

  const addCustomAgentAction = () => {
    const label = customLabel.trim();
    if (!label) return;
    try { parseKeyCombo(customCombo); } catch { return; }
    const id = `custom-${Date.now().toString(36)}`;
    saveAgentKeymaps({
      ...profileOverrides,
      custom: [...(profileOverrides.custom || []), { id, label, keys: customCombo.trim() }],
      order: [...profileActions.map((item) => item.id), id],
    });
    setCustomLabel('');
    setCustomCombo('');
  };

  const getComboErrorText = (error: unknown): string => {
    if (error instanceof KeyComboError) {
      return t(`agentKeymaps.errors.${error.code}`, error.params);
    }
    return String(error);
  };

  const comboDraftKey = (profile: AgentProfileId, actionId: string) => `${profile}:${actionId}`;

  const updateComboDraft = (actionId: string, value: string) => {
    const draftKey = comboDraftKey(keymapProfile, actionId);
    comboDraftsRef.current = { ...comboDraftsRef.current, [draftKey]: value };
    setComboDrafts(comboDraftsRef.current);
    try {
      parseKeyCombo(value);
      updateAgentAction(actionId, { keys: value });
    } catch {
      // The cap keeps using its last valid combo until the draft is corrected.
    }
  };

  const finishComboDraft = (actionId: string) => {
    const draftKey = comboDraftKey(keymapProfile, actionId);
    const draft = comboDraftsRef.current[draftKey];
    if (draft === undefined) return;
    delete comboDraftsRef.current[draftKey];
    setComboDrafts({ ...comboDraftsRef.current });
    try {
      parseKeyCombo(draft);
      updateAgentAction(actionId, { keys: draft });
    } catch {
      // Dropping the draft restores the last valid, saved value in the field.
    }
  };

  // Plain HTTP on a LAN is not a secure context, and there the API is absent.
  const notificationsAvailable =
    typeof window !== 'undefined' && window.isSecureContext && 'Notification' in window;

  const handleResetDefaults = () => {
    const defaults = getDefaultSettings();
    updateSettings({
      fontSize: defaults.fontSize,
      fontSizeFollowsHost: defaults.fontSizeFollowsHost,
      fontFamily: defaults.fontFamily,
      toolbarVisible: defaults.toolbarVisible,
      vibrateOnKeyPress: defaults.vibrateOnKeyPress,
      predictiveEcho: defaults.predictiveEcho,
      agentAlertBadge: defaults.agentAlertBadge,
      agentAlertSound: defaults.agentAlertSound,
      agentAlertVibrate: defaults.agentAlertVibrate,
      agentAlertNotify: defaults.agentAlertNotify,
      language: defaults.language,
      virtualKeys: defaults.virtualKeys,
    });
    addToast('info', t('settings.resetDefaultsToast'));
  };

  // Virtual keys reordering and management
  const handleToggleKey = (keyId: string) => {
    const updated = currentVirtualKeys.map((k) =>
      k.id === keyId ? { ...k, enabled: !k.enabled } : k
    );
    updateSettings({ virtualKeys: updated });
  };

  const handleMoveKey = (index: number, direction: 'up' | 'down') => {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= currentVirtualKeys.length) return;

    const copy = [...currentVirtualKeys];
    const temp = copy[index];
    copy[index] = copy[targetIndex];
    copy[targetIndex] = temp;

    updateSettings({ virtualKeys: copy });
  };

  const handleAddKey = (newKey: ToolbarKeyDef) => {
    const exists = currentVirtualKeys.some((k) => k.id === newKey.id);
    if (exists) {
      // If already in list, ensure enabled
      const updated = currentVirtualKeys.map((k) =>
        k.id === newKey.id ? { ...k, enabled: true } : k
      );
      updateSettings({ virtualKeys: updated });
    } else {
      const updated = [...currentVirtualKeys, { ...newKey, enabled: true }];
      updateSettings({ virtualKeys: updated });
    }
    setShowAddKeyPalette(false);
  };

  const handleRemoveKey = (keyId: string) => {
    const updated = currentVirtualKeys.filter((k) => k.id !== keyId);
    updateSettings({ virtualKeys: updated });
  };

  const handleResetVirtualKeys = () => {
    updateSettings({ virtualKeys: getDefaultVirtualKeys() });
    addToast('info', t('toasts.keyLayoutReset'));
  };

  const FONT_MIN = 10;
  const FONT_MAX = 24;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('settings.title')}
      subtitle={t('settings.subtitle')}
      closeLabel={t('common.closeDialog')}
      size="lg"
      hints={[{ keys: 'esc', action: t('common.close') }]}
      footer={
        <>
          <Button variant="ghost" onClick={handleResetDefaults}>
            {t('settings.resetDefaults')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('common.done')}
          </Button>
        </>
      }
    >
      <Tabs
        tabs={[
          { id: 'appearance', label: t('settings.tabAppearance'), index: 1 },
          { id: 'virtualKeys', label: t('settings.tabVirtualKeys'), index: 2 },
          { id: 'agentKeymaps', label: t('settings.tabAgentKeymaps'), index: 3 },
        ]}
        activeId={activeTab}
        onSelect={(id) => setActiveTab(id as SettingsTab)}
        className="mb-3 border-b border-tui-border-dim pb-1"
      />

      {activeTab === 'appearance' && (
        <div className="space-y-4">
          {/* Language — a radio group, because it is one of two. */}
          <div className="space-y-1">
            <FieldLabel>{t('settings.languageLabel')}</FieldLabel>
            <div className="grid gap-0.5 sm:grid-cols-2">
              <Radio
                name="ui-language"
                checked={language === 'zh'}
                onChange={() => setLanguage('zh')}
                label="简体中文"
              />
              <Radio
                name="ui-language"
                checked={language === 'en'}
                onChange={() => setLanguage('en')}
                label="English"
              />
            </div>
          </div>

          {/* Terminal font */}
          <div className="space-y-1">
            <FieldLabel htmlFor="terminal-font-select">
              {t('settings.fontFamilyLabel')}
            </FieldLabel>
            <Select
              id="terminal-font-select"
              value={settings.fontFamily}
              onChange={(e) => updateSettings({ fontFamily: e.target.value })}
              aria-label={t('settings.fontFamilyLabel')}
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

            {/* What the workstation reported, and whether this device has it. */}
            {settings.fontFamily === 'host' && (
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <div className="min-w-0 space-y-0.5 break-words text-tui-sm leading-snug text-tui-muted">
                  <p data-testid="host-font-status">{hostFontLine}</p>
                  {hostGlyphLine ? <p data-testid="host-glyph-status">{hostGlyphLine}</p> : null}
                </div>
                <Button
                  onClick={syncHostFont}
                  disabled={connectionState !== 'connected' || hostFont.status === 'loading' || hostFont.glyphs.status === 'loading'}
                >
                  {t('settings.hostFontSync')}
                </Button>
              </div>
            )}

            {/* Live preview, rendered as a shell prompt in the chosen face. */}
            <div
              className="overflow-x-auto whitespace-nowrap border border-tui-border bg-tui-mantle px-2 py-1.5 leading-snug text-tui-text"
              style={{ fontFamily: terminalFontFamily, fontSize: `${terminalFontSize}px` }}
            >
              <span className="text-tui-ok">$</span> echo &quot;Herdr 0O 1lI {} [] () -&gt; =&gt;
              !=&quot;
            </div>
          </div>

          {/* Font size, with the meter a terminal would draw. */}
          <div className="space-y-1">
            <FieldLabel htmlFor="terminal-font-size">
              {t('settings.fontSizeLabel', { size: terminalFontSize })}
            </FieldLabel>
            <Checkbox
              checked={settings.fontSizeFollowsHost}
              // Leaving "follow" keeps the size on screen as the manual one,
              // so the terminal does not jump when the box is cleared.
              onChange={(checked) => updateSettings(checked
                ? { fontSizeFollowsHost: true }
                : { fontSizeFollowsHost: false, fontSize: terminalFontSize })}
              label={hostSizePx
                ? t('settings.fontSizeFollowHost', { size: hostSizePx })
                : t('settings.fontSizeFollowHostUnknown')}
            />
            <div className="flex items-center gap-2">
              <Meter
                value={(terminalFontSize - FONT_MIN) / (FONT_MAX - FONT_MIN)}
                width={24}
                className="hidden shrink-0 sm:inline-flex"
              />
              <input
                id="terminal-font-size"
                type="range"
                min={FONT_MIN}
                max={FONT_MAX}
                step={1}
                value={terminalFontSize}
                onChange={(e) => updateSettings({ fontSize: Number(e.target.value), fontSizeFollowsHost: false })}
                className="h-1 w-full cursor-pointer appearance-none bg-tui-border accent-tui-accent"
              />
            </div>
            <div className="flex justify-between text-tui-sm text-tui-faint">
              <span>{t('settings.fontSizeCompact')}</span>
              <span>{t('settings.fontSizeDefault')}</span>
              <span>{t('settings.fontSizeLarge')}</span>
            </div>
            <p className="text-tui-sm leading-snug text-tui-faint">{t('settings.mobileFontNote')}</p>
            <p className="text-tui-sm leading-snug text-tui-faint">
              {t('settings.windowZoomSharedNote')}
            </p>
          </div>

          <Rule />

          {/* Predictive echo */}
          <div className="space-y-1">
            <FieldLabel>{t('settings.predictiveEchoLabel')}</FieldLabel>
            <div className="grid gap-0.5 sm:grid-cols-3">
              <Radio
                name="predictive-echo"
                checked={settings.predictiveEcho === 'auto'}
                onChange={() => updateSettings({ predictiveEcho: 'auto' })}
                label={t('settings.predictiveEchoAuto')}
              />
              <Radio
                name="predictive-echo"
                checked={settings.predictiveEcho === 'always'}
                onChange={() => updateSettings({ predictiveEcho: 'always' })}
                label={t('settings.predictiveEchoAlways')}
              />
              <Radio
                name="predictive-echo"
                checked={settings.predictiveEcho === 'off'}
                onChange={() => updateSettings({ predictiveEcho: 'off' })}
                label={t('settings.predictiveEchoOff')}
              />
            </div>
            <p className="text-tui-sm leading-snug text-tui-faint">
              {t('settings.predictiveEchoDesc')}
            </p>
          </div>

          <Rule />

          <div className="space-y-1">
            <Checkbox
              checked={settings.toolbarVisible}
              onChange={(checked) => updateSettings({ toolbarVisible: checked })}
              label={t('settings.touchKeyToolbar')}
              description={t('settings.touchKeyToolbarDesc')}
            />
            <Checkbox
              checked={settings.vibrateOnKeyPress}
              onChange={(checked) => updateSettings({ vibrateOnKeyPress: checked })}
              label={t('settings.touchHaptics')}
              description={t('settings.touchHapticsDesc')}
            />
          </div>

          <Rule />

          {/* Agent alerts */}
          <div className="space-y-1">
            <FieldLabel>{t('settings.agentAlertsLabel')}</FieldLabel>
            <Checkbox
              checked={settings.agentAlertBadge}
              onChange={(checked) => updateSettings({ agentAlertBadge: checked })}
              label={t('settings.agentAlertBadge')}
              description={t('settings.agentAlertBadgeDesc')}
            />
            <Checkbox
              checked={settings.agentAlertVibrate}
              onChange={(checked) => updateSettings({ agentAlertVibrate: checked })}
              label={t('settings.agentAlertVibrate')}
              description={t('settings.agentAlertVibrateDesc')}
            />
            <Checkbox
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
              label={t('settings.agentAlertSound')}
              description={t('settings.agentAlertSoundDesc')}
            />
            {notificationsAvailable && (
              <Checkbox
                checked={settings.agentAlertNotify}
                onChange={(checked) => {
                  if (checked && Notification.permission !== 'granted') {
                    void Notification.requestPermission().then((permission) =>
                      updateSettings({ agentAlertNotify: permission === 'granted' })
                    );
                    return;
                  }
                  updateSettings({ agentAlertNotify: checked });
                }}
                label={t('settings.agentAlertNotify')}
                description={t('settings.agentAlertNotifyDesc')}
              />
            )}
          </div>

          <Rule />

          <p className="text-tui-sm leading-snug text-tui-faint">
            <span aria-hidden="true" className="mr-1">
              {GLYPH.arrowRight}
            </span>
            {t('settings.colorPassthroughNote')}
          </p>
        </div>
      )}

      {activeTab === 'virtualKeys' && (
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-tui font-bold uppercase text-tui-accent">
                {t('virtualKeyboard.customizeTitle')}
              </h3>
              <p className="text-tui-sm leading-snug text-tui-faint">
                {t('virtualKeyboard.customizeDesc')}
              </p>
            </div>
            <Button variant="ghost" onClick={handleResetVirtualKeys} className="shrink-0">
              {t('virtualKeyboard.resetLayout')}
            </Button>
          </div>

          {/* Configured layout: one row per key, in send order. */}
          <div className="relative max-h-72 overflow-y-auto overscroll-contain border border-tui-border bg-tui-mantle">
            {currentVirtualKeys.map((keyItem, index) => (
              <div
                key={keyItem.id}
                className="flex items-center justify-between gap-2 border-b border-tui-border-dim px-2 py-1 last:border-b-0 hover:bg-tui-selection"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={keyItem.enabled}
                    onChange={() => handleToggleKey(keyItem.id)}
                    className="sr-only"
                    id={`toggle-${keyItem.id}`}
                  />
                  <label
                    htmlFor={`toggle-${keyItem.id}`}
                    className={cn(
                      'shrink-0 cursor-pointer select-none font-bold',
                      keyItem.enabled ? 'text-tui-ok' : 'text-tui-faint'
                    )}
                    aria-hidden="true"
                  >
                    {keyItem.enabled ? '[x]' : '[ ]'}
                  </label>
                  <KeyCap className={cn(!keyItem.enabled && 'opacity-50')}>{keyItem.label}</KeyCap>
                  <span className="truncate text-tui-sm text-tui-muted">
                    {getLocalizedKeyTitle(keyItem, t)}
                  </span>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    brackets={false}
                    disabled={index === 0}
                    onClick={() => handleMoveKey(index, 'up')}
                    title={t('virtualKeyboard.moveUp')}
                    aria-label={t('virtualKeyboard.moveUp')}
                    className="px-1"
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    brackets={false}
                    disabled={index === currentVirtualKeys.length - 1}
                    onClick={() => handleMoveKey(index, 'down')}
                    title={t('virtualKeyboard.moveDown')}
                    aria-label={t('virtualKeyboard.moveDown')}
                    className="px-1"
                  >
                    ↓
                  </Button>
                  <Button
                    variant="ghost"
                    brackets={false}
                    onClick={() => handleRemoveKey(keyItem.id)}
                    title={t('virtualKeyboard.deleteKeyTitle')}
                    aria-label={t('virtualKeyboard.deleteKeyTitle')}
                    className="px-1 text-tui-bad hover:text-tui-bad"
                  >
                    {GLYPH.cross}
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <Button
            block
            glyph="+"
            onClick={() => setShowAddKeyPalette(!showAddKeyPalette)}
            className="border-dashed"
          >
            {t('virtualKeyboard.addKey')}
          </Button>

          {showAddKeyPalette && (
            <div className="space-y-2 border border-tui-border bg-tui-mantle p-2">
              <Rule label={t('virtualKeyboard.availableKeys')} />
              <div className="relative flex max-h-48 flex-wrap gap-1 overflow-y-auto overscroll-contain">
                {ALL_AVAILABLE_KEYS.map((availableKey) => {
                  const isAlreadyAdded = currentVirtualKeys.some((k) => k.id === availableKey.id);
                  return (
                    <button
                      key={availableKey.id}
                      type="button"
                      onClick={() => handleAddKey(availableKey)}
                      title={getLocalizedKeyTitle(availableKey, t)}
                      className={cn(
                        'tui-focusable flex select-none items-center gap-1 border px-1.5 py-0.5 text-tui-sm transition-colors',
                        isAlreadyAdded
                          ? 'border-tui-border-dim text-tui-faint'
                          : 'border-tui-border text-tui-text hover:border-tui-accent hover:text-tui-accent'
                      )}
                    >
                      <span>{availableKey.label}</span>
                      <span aria-hidden="true" className={isAlreadyAdded ? 'text-tui-ok' : 'text-tui-accent'}>
                        {isAlreadyAdded ? GLYPH.check : '+'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'agentKeymaps' && (
        <div className="space-y-3">
          <div className="space-y-1">
            <FieldLabel htmlFor="agent-keymap-profile">{t('agentKeymaps.settingsProfileLabel')}</FieldLabel>
            <Select
              id="agent-keymap-profile"
              aria-label={t('agentKeymaps.settingsProfileLabel')}
              value={keymapProfile}
              onChange={(event) => setSettingsAgentProfile(event.target.value as AgentProfileId)}
            >
              {AGENT_PROFILE_IDS.map((id) => (
                <option key={id} value={id}>{AGENT_PROFILES[id].name}</option>
              ))}
            </Select>
            {(AGENT_PROFILES[keymapProfile] as AgentProfileDef).configHint && (
              <p className="text-tui-sm text-tui-faint">
                {t('agentKeymaps.configHint', { path: (AGENT_PROFILES[keymapProfile] as AgentProfileDef).configHint! })}
              </p>
            )}
          </div>

          <Rule label={t('agentKeymaps.barGroup')} />
          <div className="space-y-2">
            <p className="text-tui-sm leading-snug text-tui-faint">
              {t('agentKeymaps.barHint', { profile: AGENT_PROFILES[keymapProfile].name, count: shownBarCount })}
            </p>
            <div
              role="group"
              aria-label={t('agentKeymaps.barGroup')}
              data-testid="agent-bar-choices"
              className="flex flex-wrap gap-1"
            >
              {barChoices.map((item) => {
                const label = actionLabel(item);
                const caption = actionCaption(item);
                const shown = !item.hidden;
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-testid={`agent-bar-toggle-${item.id}`}
                    aria-pressed={shown}
                    onClick={() => updateAgentAction(item.id, { hidden: shown })}
                    title={`${caption} ${label}`.trim()}
                    className={cn(
                      'tui-focusable inline-flex h-8 select-none items-center gap-1 border px-1.5 text-tui-sm transition-colors',
                      shown
                        ? 'border-tui-accent bg-tui-accent text-tui-crust'
                        : 'border-tui-border text-tui-muted hover:border-tui-accent hover:text-tui-accent'
                    )}
                  >
                    <span aria-hidden="true" className="font-bold">{shown ? GLYPH.check : '+'}</span>
                    <span className="font-bold">{caption}</span>
                    <span className={shown ? undefined : 'opacity-80'}>{label}</span>
                  </button>
                );
              })}
            </div>
            <Button variant="ghost" onClick={restoreBarVisibility}>
              {t('agentKeymaps.restoreBar')}
            </Button>
          </div>

          <Rule label={t('agentKeymaps.agentGroup')} />
          <div className="relative max-h-72 overflow-y-auto overscroll-contain border border-tui-border bg-tui-mantle">
            {profileActions.map((item, index) => {
              const label = actionLabel(item);
              const defaultText = t('agentKeymaps.defaultCombo', { combo: formatComboCaption(item.defaultCombo) });
              const savedCombo = profileOverrides.actions?.[item.id]?.keys ?? item.combo;
              const draftKey = comboDraftKey(keymapProfile, item.id);
              const displayedCombo = comboDrafts[draftKey] ?? savedCombo;
              let caption = '';
              let error: string | null = null;
              try {
                parseKeyCombo(displayedCombo);
                caption = formatComboCaption(displayedCombo);
              } catch (reason) {
                error = getComboErrorText(reason);
              }
              return (
                <div
                  key={item.id}
                  data-testid={`agent-setting-row-${item.id}`}
                  className={AGENT_ROW_GRID}
                >
                  <KeyCap className="max-w-full justify-self-start overflow-hidden whitespace-nowrap font-bold [grid-area:cap]">
                    {caption || '—'}
                  </KeyCap>
                  <span className="min-w-0 truncate text-tui-sm text-tui-text [grid-area:label]" title={label}>
                    {label}
                    {!item.verified && (
                      <span className="ml-1 text-tui-sm text-tui-faint">{t('agentKeymaps.unverified')}</span>
                    )}
                  </span>
                  <label className="sr-only" htmlFor={`agent-combo-${item.id}`}>
                    {t('agentKeymaps.shortcutLabel')} {label}
                  </label>
                  <Input
                    id={`agent-combo-${item.id}`}
                    aria-label={`${t('agentKeymaps.shortcutLabel')} ${label}`}
                    value={displayedCombo}
                    onChange={(event) => updateComboDraft(item.id, event.target.value)}
                    onBlur={() => finishComboDraft(item.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                    placeholder={t('agentKeymaps.comboPlaceholder')}
                    aria-invalid={Boolean(error)}
                    className="w-full min-w-0 [grid-area:combo]"
                  />
                  <span className="min-w-0 truncate text-tui-sm text-tui-faint [grid-area:default]" title={defaultText}>
                    {defaultText}
                  </span>
                  <div className="flex items-center gap-1 [grid-area:actions]">
                    <Button
                      variant="ghost"
                      brackets={false}
                      className="px-1"
                      onClick={() => resetAgentAction(item)}
                      title={t('agentKeymaps.resetAction')}
                      aria-label={`${t('agentKeymaps.resetAction')} ${label}`}
                    >↺</Button>
                    <Button
                      variant="ghost"
                      brackets={false}
                      className="px-1"
                      disabled={index === 0}
                      onClick={() => moveAgentAction(index, 'up')}
                      title={t('agentKeymaps.moveUp')}
                      aria-label={`${t('agentKeymaps.moveUp')} ${label}`}
                    >↑</Button>
                    <Button
                      variant="ghost"
                      brackets={false}
                      className="px-1"
                      disabled={index === profileActions.length - 1}
                      onClick={() => moveAgentAction(index, 'down')}
                      title={t('agentKeymaps.moveDown')}
                      aria-label={`${t('agentKeymaps.moveDown')} ${label}`}
                    >↓</Button>
                    {item.custom && (
                      <Button
                        variant="ghost"
                        brackets={false}
                        className="px-1 text-tui-bad"
                        onClick={() => removeCustomAction(item.id)}
                        title={t('agentKeymaps.removeCustom')}
                        aria-label={`${t('agentKeymaps.removeCustom')} ${label}`}
                      >{GLYPH.cross}</Button>
                    )}
                  </div>
                  {error && (
                    <p className="col-span-full text-tui-sm text-tui-bad" role="alert">
                      {t('agentKeymaps.invalidCombo', { error })}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          <Rule label={t('agentKeymaps.addCustom')} />
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-[9rem] flex-1 space-y-1 text-tui-sm text-tui-faint">
              <span>{t('agentKeymaps.customLabel')}</span>
              <Input value={customLabel} onChange={(event) => setCustomLabel(event.target.value)} />
            </label>
            <label className="min-w-[9rem] flex-1 space-y-1 text-tui-sm text-tui-faint">
              <span>{t('agentKeymaps.customCombo')}</span>
              <Input value={customCombo} onChange={(event) => setCustomCombo(event.target.value)} />
            </label>
            <Button onClick={addCustomAgentAction} disabled={!customLabel.trim() || !customCombo.trim()}>
              {t('agentKeymaps.addAction')}
            </Button>
          </div>
          {customCombo.trim() && (() => {
            try {
              parseKeyCombo(customCombo);
              return <p className="text-tui-sm text-tui-faint">{formatComboCaption(customCombo)}</p>;
            } catch (reason) {
              const error = getComboErrorText(reason);
              return <p className="text-tui-sm text-tui-bad" role="alert">{error}</p>;
            }
          })()}
          <Button variant="ghost" onClick={restoreAgentProfile}>
            {t('agentKeymaps.restoreProfile')}
          </Button>
        </div>
      )}
    </Modal>
  );
};
