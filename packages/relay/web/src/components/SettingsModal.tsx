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
  CONTROL_H,
  GLYPH,
  IconButton,
  Input,
  KeyCap,
  Modal,
  Segmented,
  Select,
  SettingRow,
  SettingSection,
  Tabs,
  Toggle,
} from './tui';

export type SettingsTab = 'general' | 'virtualKeys' | 'agentKeymaps';

/** A field or button sized to the settings column: one height, no own padding. */
const CONTROL_FIELD = cn(CONTROL_H, 'py-0');

/** The same, one step smaller, for controls inside a list row. */
const COMPACT_FIELD = 'h-7 py-0';

/** A section's own small action beside its heading. */
const COMPACT = 'h-7 py-0 px-1.5';

/** Resets are the only destructive words here, so they are the only red ones. */
const DANGER_GHOST = 'text-tui-bad hover:border-tui-bad hover:text-tui-bad';

/**
 * One agent-key row. Every column has a fixed width so the combo fields and
 * buttons line up down the list; a phone splits the row over two lines.
 */
const AGENT_ROW_GRID = [
  'grid items-center gap-x-2 gap-y-1 py-1',
  "grid-cols-[4rem_minmax(0,1fr)_7rem] [grid-template-areas:'cap_label_actions'_'combo_combo_default']",
  "sm:grid-cols-[4rem_minmax(0,1fr)_9rem_7rem_7rem] sm:[grid-template-areas:'cap_label_combo_default_actions']",
].join(' ');

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Open on this tab, showing the focused agent, instead of where it was left. */
  initialTab?: SettingsTab;
  /** Leave the dialog for the relay dashboard. */
  onOpenAdmin?: () => void;
}

/**
 * Preferences, as a TUI settings screen.
 *
 * Numbered tabs across the top; each tab is a stack of headed groups, and each
 * setting is one row with its words on the left and its control on the right.
 * Every control is the same width and height and every choice is drawn the
 * same way — cells with the chosen one filled — so the screen reads as one
 * column of answers rather than a page of mixed widgets. Colour is kept for
 * meaning: blue headings and choices, green for a switch that is on, red for
 * the words that reset something.
 */
export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, initialTab, onOpenAdmin }) => {
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
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
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

  const toggleWords = { offLabel: t('settings.toggleOff'), onLabel: t('settings.toggleOn') };
  const followHostLabel = hostSizePx
    ? t('settings.fontSizeFollowHost', { size: hostSizePx })
    : t('settings.fontSizeFollowHostUnknown');

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('settings.title')}
      subtitle={t('settings.subtitle')}
      closeLabel={t('common.closeDialog')}
      size="lg"
      fixedHeight
      hints={[{ keys: 'esc', action: t('common.close') }]}
      footer={
        <>
          <Button variant="ghost" onClick={handleResetDefaults} className={DANGER_GHOST}>
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
          { id: 'general', label: t('settings.tabGeneral'), index: 1 },
          { id: 'virtualKeys', label: t('settings.tabVirtualKeys'), index: 2 },
          { id: 'agentKeymaps', label: t('settings.tabAgentKeymaps'), index: 3 },
        ]}
        activeId={activeTab}
        onSelect={(id) => setActiveTab(id as SettingsTab)}
        className="mb-3 border-b border-tui-border-dim pb-1"
      />

      {activeTab === 'general' && (
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
                    disabled={connectionState !== 'connected' || hostFont.status === 'loading' || hostFont.glyphs.status === 'loading'}
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
                    onChange={(e) => updateSettings({ fontSize: Number(e.target.value), fontSizeFollowsHost: false })}
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
                  {...toggleWords}
                  checked={settings.fontSizeFollowsHost}
                  // Leaving "follow" keeps the size on screen as the manual one,
                  // so the terminal does not jump when it is switched off.
                  onChange={(checked) => updateSettings(checked
                    ? { fontSizeFollowsHost: true }
                    : { fontSizeFollowsHost: false, fontSize: terminalFontSize })}
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
                  {...toggleWords}
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
                  {...toggleWords}
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
                  {...toggleWords}
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
                  {...toggleWords}
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
                  {...toggleWords}
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
                    {...toggleWords}
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
      )}

      {activeTab === 'virtualKeys' && (
        <div className="space-y-3">
          <SettingSection
            title={t('virtualKeyboard.customizeTitle')}
            aside={
              <Button variant="ghost" onClick={handleResetVirtualKeys} className={cn(DANGER_GHOST, COMPACT)}>
                {t('virtualKeyboard.resetLayout')}
              </Button>
            }
          >
            {/* Configured layout: one row per key, in send order. */}
            {currentVirtualKeys.map((keyItem, index) => {
              const title = getLocalizedKeyTitle(keyItem, t);
              return (
                <div key={keyItem.id} className="flex items-center gap-2 py-1">
                  <KeyCap className={cn('w-16 shrink-0 truncate', !keyItem.enabled && 'opacity-50')}>
                    {keyItem.label}
                  </KeyCap>
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-tui',
                      keyItem.enabled ? 'text-tui-text' : 'text-tui-faint'
                    )}
                  >
                    {title}
                  </span>
                  <Toggle
                    label={`${t('virtualKeyboard.enableKey')} ${keyItem.label}`}
                    {...toggleWords}
                    checked={keyItem.enabled}
                    onChange={() => handleToggleKey(keyItem.id)}
                    className="h-7 w-24 shrink-0"
                  />
                  <IconButton
                    disabled={index === 0}
                    onClick={() => handleMoveKey(index, 'up')}
                    title={t('virtualKeyboard.moveUp')}
                    aria-label={t('virtualKeyboard.moveUp')}
                  >
                    ↑
                  </IconButton>
                  <IconButton
                    disabled={index === currentVirtualKeys.length - 1}
                    onClick={() => handleMoveKey(index, 'down')}
                    title={t('virtualKeyboard.moveDown')}
                    aria-label={t('virtualKeyboard.moveDown')}
                  >
                    ↓
                  </IconButton>
                  <IconButton
                    variant="danger"
                    onClick={() => handleRemoveKey(keyItem.id)}
                    title={t('virtualKeyboard.deleteKeyTitle')}
                    aria-label={t('virtualKeyboard.deleteKeyTitle')}
                  >
                    {GLYPH.cross}
                  </IconButton>
                </div>
              );
            })}
          </SettingSection>

          <Button
            block
            glyph="+"
            onClick={() => setShowAddKeyPalette(!showAddKeyPalette)}
            className={cn('border-dashed', CONTROL_FIELD)}
          >
            {t('virtualKeyboard.addKey')}
          </Button>

          {showAddKeyPalette && (
            <SettingSection title={t('virtualKeyboard.availableKeys')}>
              <div className="flex flex-wrap gap-1 py-1.5">
                {ALL_AVAILABLE_KEYS.map((availableKey) => {
                  const isAlreadyAdded = currentVirtualKeys.some((k) => k.id === availableKey.id);
                  return (
                    <button
                      key={availableKey.id}
                      type="button"
                      onClick={() => handleAddKey(availableKey)}
                      title={getLocalizedKeyTitle(availableKey, t)}
                      className={cn(
                        'tui-focusable flex h-7 select-none items-center gap-1 border px-1.5 text-tui-sm transition-colors',
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
            </SettingSection>
          )}
        </div>
      )}

      {activeTab === 'agentKeymaps' && (
        <div className="space-y-4">
          <SettingSection
            title={t('agentKeymaps.settingsProfileLabel')}
            aside={
              <Button variant="ghost" onClick={restoreAgentProfile} className={cn(DANGER_GHOST, COMPACT)}>
                {t('agentKeymaps.restoreProfile')}
              </Button>
            }
          >
            <SettingRow
              label={t('agentKeymaps.profileRowLabel')}
              htmlFor="agent-keymap-profile"
              hint={(AGENT_PROFILES[keymapProfile] as AgentProfileDef).configHint
                ? t('agentKeymaps.configHint', { path: (AGENT_PROFILES[keymapProfile] as AgentProfileDef).configHint! })
                : undefined}
              control={
                <Select
                  id="agent-keymap-profile"
                  aria-label={t('agentKeymaps.settingsProfileLabel')}
                  value={keymapProfile}
                  onChange={(event) => setSettingsAgentProfile(event.target.value as AgentProfileId)}
                  className={CONTROL_FIELD}
                >
                  {AGENT_PROFILE_IDS.map((id) => (
                    <option key={id} value={id}>{AGENT_PROFILES[id].name}</option>
                  ))}
                </Select>
              }
            />
          </SettingSection>

          <SettingSection
            title={t('agentKeymaps.barGroup')}
            aside={
              <Button variant="ghost" onClick={restoreBarVisibility} className={cn(DANGER_GHOST, COMPACT)}>
                {t('agentKeymaps.restoreBar')}
              </Button>
            }
          >
            <div className="space-y-2 py-1.5">
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
                        'tui-focusable inline-flex h-7 select-none items-center gap-1 border px-1.5 text-tui-sm transition-colors',
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
            </div>
          </SettingSection>

          <SettingSection title={t('agentKeymaps.listGroup', { profile: AGENT_PROFILES[keymapProfile].name })}>
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
                  <KeyCap className="w-full overflow-hidden whitespace-nowrap font-bold [grid-area:cap]">
                    {caption || '—'}
                  </KeyCap>
                  <span className="min-w-0 truncate text-tui text-tui-text [grid-area:label]" title={label}>
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
                    className={cn('w-full min-w-0 [grid-area:combo]', COMPACT_FIELD)}
                  />
                  <span className="min-w-0 truncate text-tui-sm text-tui-faint [grid-area:default]" title={defaultText}>
                    {defaultText}
                  </span>
                  <div className="flex items-center justify-end [grid-area:actions]">
                    <IconButton
                      onClick={() => resetAgentAction(item)}
                      title={t('agentKeymaps.resetAction')}
                      aria-label={`${t('agentKeymaps.resetAction')} ${label}`}
                    >↺</IconButton>
                    <IconButton
                      disabled={index === 0}
                      onClick={() => moveAgentAction(index, 'up')}
                      title={t('agentKeymaps.moveUp')}
                      aria-label={`${t('agentKeymaps.moveUp')} ${label}`}
                    >↑</IconButton>
                    <IconButton
                      disabled={index === profileActions.length - 1}
                      onClick={() => moveAgentAction(index, 'down')}
                      title={t('agentKeymaps.moveDown')}
                      aria-label={`${t('agentKeymaps.moveDown')} ${label}`}
                    >↓</IconButton>
                    {item.custom ? (
                      <IconButton
                        variant="danger"
                        onClick={() => removeCustomAction(item.id)}
                        title={t('agentKeymaps.removeCustom')}
                        aria-label={`${t('agentKeymaps.removeCustom')} ${label}`}
                      >{GLYPH.cross}</IconButton>
                    ) : (
                      /* Holds the delete column so every row's arrows line up. */
                      <span aria-hidden="true" className="h-7 w-7 shrink-0" />
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
          </SettingSection>

          <SettingSection title={t('agentKeymaps.addCustom')}>
            <div className="space-y-1 py-1.5">
              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-[9rem] flex-1 space-y-1 text-tui-sm text-tui-muted">
                  <span>{t('agentKeymaps.customLabel')}</span>
                  <Input
                    value={customLabel}
                    onChange={(event) => setCustomLabel(event.target.value)}
                    className={CONTROL_FIELD}
                  />
                </label>
                <label className="min-w-[9rem] flex-1 space-y-1 text-tui-sm text-tui-muted">
                  <span>{t('agentKeymaps.customCombo')}</span>
                  <Input
                    value={customCombo}
                    onChange={(event) => setCustomCombo(event.target.value)}
                    placeholder={t('agentKeymaps.comboPlaceholder')}
                    className={CONTROL_FIELD}
                  />
                </label>
                <Button
                  variant="primary"
                  glyph="+"
                  onClick={addCustomAgentAction}
                  disabled={!customLabel.trim() || !customCombo.trim()}
                  className={CONTROL_FIELD}
                >
                  {t('agentKeymaps.addAction')}
                </Button>
              </div>
              {customCombo.trim() && (() => {
                try {
                  parseKeyCombo(customCombo);
                  return <p className="text-tui-sm text-tui-info">{formatComboCaption(customCombo)}</p>;
                } catch (reason) {
                  const error = getComboErrorText(reason);
                  return <p className="text-tui-sm text-tui-bad" role="alert">{error}</p>;
                }
              })()}
            </div>
          </SettingSection>
        </div>
      )}
    </Modal>
  );
};
