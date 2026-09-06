import React, { useState } from 'react';
import { useTerminal } from '../context/TerminalContext';
import { getDefaultSettings } from '../utils/storage';
import { FONT_PRESETS } from '../utils/theme';
import {
  ToolbarKeyDef,
  ALL_AVAILABLE_KEYS,
  getDefaultVirtualKeys,
  getLocalizedKeyTitle,
} from '../utils/virtualKeys';
import { cn } from '../utils/cn';
import {
  Button,
  Checkbox,
  FieldLabel,
  GLYPH,
  KeyCap,
  Meter,
  Modal,
  Radio,
  Rule,
  Select,
  Tabs,
} from './tui';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Preferences, as a TUI settings screen.
 *
 * Numbered tabs across the top, a label column down the left, bracketed
 * checkboxes for booleans and a `█░` meter for the one continuous value. The
 * only thing here that paints a colour is the terminal font preview, and that
 * colour belongs to the host.
 */
export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const { settings, updateSettings, addToast, language, setLanguage, t } = useTerminal();
  const [activeTab, setActiveTab] = useState<'appearance' | 'virtualKeys'>('appearance');
  const [showAddKeyPalette, setShowAddKeyPalette] = useState(false);

  if (!isOpen) return null;

  /** A legacy/custom stack keeps its own option so the select never lies. */
  const activeFontPreset = FONT_PRESETS.find((preset) => preset.font === settings.fontFamily);

  const currentVirtualKeys: ToolbarKeyDef[] =
    settings.virtualKeys && settings.virtualKeys.length > 0
      ? settings.virtualKeys
      : getDefaultVirtualKeys();

  const handleResetDefaults = () => {
    const defaults = getDefaultSettings();
    updateSettings({
      fontSize: defaults.fontSize,
      fontFamily: defaults.fontFamily,
      toolbarVisible: defaults.toolbarVisible,
      vibrateOnKeyPress: defaults.vibrateOnKeyPress,
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
        ]}
        activeId={activeTab}
        onSelect={(id) => setActiveTab(id as 'appearance' | 'virtualKeys')}
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
                <option key={preset.id} value={preset.font}>
                  {t(`fontPresets.${preset.id}` as any) || preset.name}
                </option>
              ))}
            </Select>

            {/* Live preview, rendered as a shell prompt in the chosen face. */}
            <div
              className="overflow-x-auto whitespace-nowrap border border-tui-border bg-tui-mantle px-2 py-1.5 leading-snug text-tui-text"
              style={{ fontFamily: settings.fontFamily, fontSize: `${settings.fontSize}px` }}
            >
              <span className="text-tui-ok">$</span> echo &quot;Herdr 0O 1lI {} [] () -&gt; =&gt;
              !=&quot;
            </div>
          </div>

          {/* Font size, with the meter a terminal would draw. */}
          <div className="space-y-1">
            <FieldLabel htmlFor="terminal-font-size">
              {t('settings.fontSizeLabel', { size: settings.fontSize })}
            </FieldLabel>
            <div className="flex items-center gap-2">
              <Meter
                value={(settings.fontSize - FONT_MIN) / (FONT_MAX - FONT_MIN)}
                width={24}
                className="hidden shrink-0 sm:inline-flex"
              />
              <input
                id="terminal-font-size"
                type="range"
                min={FONT_MIN}
                max={FONT_MAX}
                step={1}
                value={settings.fontSize}
                onChange={(e) => updateSettings({ fontSize: Number(e.target.value) })}
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
          <div className="max-h-72 overflow-y-auto border border-tui-border bg-tui-mantle">
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
              <div className="flex max-h-48 flex-wrap gap-1 overflow-y-auto">
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
    </Modal>
  );
};
