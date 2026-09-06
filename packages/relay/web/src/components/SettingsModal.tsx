import React, { useState } from 'react';
import { useTerminal } from '../context/TerminalContext';
import { getDefaultSettings } from '../utils/storage';
import { FONT_PRESETS } from '../utils/theme';
import {
  X,
  Settings,
  Type,
  RotateCcw,
  Check,
  Globe,
  Keyboard,
  ArrowUp,
  ArrowDown,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  ToolbarKeyDef,
  ALL_AVAILABLE_KEYS,
  getDefaultVirtualKeys,
  getLocalizedKeyTitle,
} from '../utils/virtualKeys';
import { cn } from '../utils/cn';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

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

  return (
    // Sized from the visual viewport, not `vh`. On a phone `vh` is the tall
    // viewport behind the browser's own chrome, so a dialog measured in it
    // reaches below the visible area and the browser scrolls to compensate —
    // which is the jump users saw the moment this panel opened.
    <div
      className="fixed inset-x-0 top-0 z-50 flex items-center justify-center p-4 bg-charcoal-950/60 backdrop-blur-sm animate-in fade-in"
      style={{ height: 'var(--app-height, 100dvh)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
    >
      <div
        className="bg-paper dark:bg-charcoal-850 border border-sand-300 dark:border-charcoal-700 rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden flex flex-col"
        style={{ maxHeight: 'calc(var(--app-height, 100dvh) - 2rem)' }}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-sand-200 dark:border-charcoal-750 flex items-center justify-between bg-sand-50 dark:bg-charcoal-900">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-herdr-100 dark:bg-herdr-950 border border-herdr-300 dark:border-herdr-700 flex items-center justify-center text-herdr-600 dark:text-herdr-400 shadow-sm">
              <Settings className="w-4 h-4" />
            </div>
            <div>
              <h2 id="settings-modal-title" className="font-semibold text-sm sm:text-base text-charcoal-900 dark:text-charcoal-100">
                {t('settings.title')}
              </h2>
              <p className="text-[11px] text-charcoal-500 dark:text-charcoal-400">
                {t('settings.subtitle')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-charcoal-400 hover:text-charcoal-700 dark:hover:text-charcoal-200 p-1.5 rounded-lg hover:bg-sand-200 dark:hover:bg-charcoal-800 transition-colors"
            aria-label={t('common.closeDialog')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center gap-2 px-5 pt-3 pb-1 border-b border-sand-200 dark:border-charcoal-750 bg-sand-50/50 dark:bg-charcoal-900/50 text-xs">
          <button
            type="button"
            onClick={() => setActiveTab('appearance')}
            className={cn(
              'px-3 py-1.5 rounded-lg font-semibold transition-colors flex items-center gap-1.5',
              activeTab === 'appearance'
                ? 'bg-herdr-700 text-white shadow-sm'
                : 'text-charcoal-600 dark:text-charcoal-400 hover:bg-sand-200 dark:hover:bg-charcoal-800'
            )}
          >
            <Type className="w-3.5 h-3.5" />
            <span>{t('settings.tabAppearance')}</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('virtualKeys')}
            className={cn(
              'px-3 py-1.5 rounded-lg font-semibold transition-colors flex items-center gap-1.5',
              activeTab === 'virtualKeys'
                ? 'bg-herdr-700 text-white shadow-sm'
                : 'text-charcoal-600 dark:text-charcoal-400 hover:bg-sand-200 dark:hover:bg-charcoal-800'
            )}
          >
            <Keyboard className="w-3.5 h-3.5" />
            <span>{t('settings.tabVirtualKeys')}</span>
          </button>
        </div>

        {/* Content */}
        <div className="p-5 flex-1 overflow-y-auto space-y-5 text-xs">
          {activeTab === 'appearance' && (
            <>
              {/* Language Selection */}
              <div>
                <label className="flex items-center gap-1.5 text-charcoal-800 dark:text-charcoal-200 font-semibold mb-2">
                  <Globe className="w-3.5 h-3.5 text-herdr-500" />
                  <span>{t('settings.languageLabel')}</span>
                </label>
                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => setLanguage('zh')}
                    className={`p-3 rounded-xl border text-left transition-all flex items-center justify-between ${
                      language === 'zh'
                        ? 'border-herdr-500 ring-2 ring-herdr-500/30 bg-herdr-50 dark:bg-herdr-950/40 text-herdr-900 dark:text-herdr-200 font-bold'
                        : 'border-sand-300 dark:border-charcoal-700 bg-sand-50 dark:bg-charcoal-900 text-charcoal-700 dark:text-charcoal-300'
                    }`}
                  >
                    <span>简体中文</span>
                    {language === 'zh' && <span className="w-2 h-2 rounded-full bg-herdr-700" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setLanguage('en')}
                    className={`p-3 rounded-xl border text-left transition-all flex items-center justify-between ${
                      language === 'en'
                        ? 'border-herdr-500 ring-2 ring-herdr-500/30 bg-herdr-50 dark:bg-herdr-950/40 text-herdr-900 dark:text-herdr-200 font-bold'
                        : 'border-sand-300 dark:border-charcoal-700 bg-sand-50 dark:bg-charcoal-900 text-charcoal-700 dark:text-charcoal-300'
                    }`}
                  >
                    <span>English</span>
                    {language === 'en' && <span className="w-2 h-2 rounded-full bg-herdr-700" />}
                  </button>
                </div>
              </div>

              {/* Terminal Font Family */}
              <div className="space-y-2">
                <label
                  htmlFor="terminal-font-select"
                  className="flex items-center gap-1.5 text-charcoal-800 dark:text-charcoal-200 font-semibold"
                >
                  <Type className="w-3.5 h-3.5 text-herdr-500" />
                  <span>{t('settings.fontFamilyLabel')}</span>
                </label>

                <select
                  id="terminal-font-select"
                  value={settings.fontFamily}
                  onChange={(e) => updateSettings({ fontFamily: e.target.value })}
                  className="w-full bg-sand-50 dark:bg-charcoal-900 border border-sand-300 dark:border-charcoal-700 rounded-xl px-3 py-2 text-xs text-charcoal-900 dark:text-charcoal-100 focus:outline-none focus:border-herdr-500 focus:ring-1 focus:ring-herdr-500"
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
                </select>

                {/* Live monospace preview in the selected font */}
                <div
                  className="px-3 py-2 bg-sand-100 dark:bg-charcoal-900 border border-sand-300 dark:border-charcoal-700 rounded-xl text-charcoal-800 dark:text-charcoal-200 leading-snug overflow-x-auto whitespace-nowrap"
                  style={{ fontFamily: settings.fontFamily, fontSize: `${settings.fontSize}px` }}
                >
                  $ echo &quot;Herdr 0O 1lI {} [] () -&gt; =&gt; !=&quot;
                </div>
              </div>

              {/* Font Size Slider */}
              <div>
                <label className="flex items-center gap-1.5 text-charcoal-800 dark:text-charcoal-200 font-semibold mb-1.5">
                  <Type className="w-3.5 h-3.5 text-herdr-500" />
                  <span>{t('settings.fontSizeLabel', { size: settings.fontSize })}</span>
                </label>
                <input
                  type="range"
                  min={10}
                  max={24}
                  step={1}
                  value={settings.fontSize}
                  onChange={(e) => updateSettings({ fontSize: Number(e.target.value) })}
                  className="w-full h-1.5 bg-sand-300 dark:bg-charcoal-700 rounded-lg appearance-none cursor-pointer accent-herdr-600"
                />
                <div className="flex justify-between text-[10px] text-charcoal-500 dark:text-charcoal-400 mt-1 font-mono">
                  <span>{t('settings.fontSizeCompact')}</span>
                  <span>{t('settings.fontSizeDefault')}</span>
                  <span>{t('settings.fontSizeLarge')}</span>
                </div>
                <p className="text-[11px] text-charcoal-500 dark:text-charcoal-400 mt-1.5 leading-relaxed">
                  {t('settings.mobileFontNote')}
                </p>
                <p className="text-[11px] text-charcoal-500 dark:text-charcoal-400 mt-1 leading-relaxed">
                  {t('settings.windowZoomSharedNote')}
                </p>
              </div>

              {/* Toggle Options */}
              <div className="space-y-3 pt-2 border-t border-sand-200 dark:border-charcoal-750">
                {/* Key Toolbar */}
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-charcoal-800 dark:text-charcoal-200 font-medium block">{t('settings.touchKeyToolbar')}</span>
                    <span className="text-[11px] text-charcoal-500 dark:text-charcoal-400">{t('settings.touchKeyToolbarDesc')}</span>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.toolbarVisible}
                      onChange={(e) => updateSettings({ toolbarVisible: e.target.checked })}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-sand-300 dark:bg-charcoal-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-paper after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-herdr-700"></div>
                  </label>
                </div>

                {/* Haptic vibration */}
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-charcoal-800 dark:text-charcoal-200 font-medium block">{t('settings.touchHaptics')}</span>
                    <span className="text-[11px] text-charcoal-500 dark:text-charcoal-400">{t('settings.touchHapticsDesc')}</span>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.vibrateOnKeyPress}
                      onChange={(e) => updateSettings({ vibrateOnKeyPress: e.target.checked })}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-sand-300 dark:bg-charcoal-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-paper after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-herdr-700"></div>
                  </label>
                </div>
              </div>

              {/* Colors are the host's, not ours */}
              <p className="text-[11px] text-charcoal-500 dark:text-charcoal-400 leading-relaxed pt-2 border-t border-sand-200 dark:border-charcoal-750">
                {t('settings.colorPassthroughNote')}
              </p>
            </>
          )}

          {activeTab === 'virtualKeys' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-charcoal-900 dark:text-charcoal-100">
                    {t('virtualKeyboard.customizeTitle')}
                  </h3>
                  <p className="text-[11px] text-charcoal-500 dark:text-charcoal-400">
                    {t('virtualKeyboard.customizeDesc')}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleResetVirtualKeys}
                  className="text-herdr-700 dark:text-herdr-400 hover:underline text-[11px] font-medium flex items-center gap-1"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>{t('virtualKeyboard.resetLayout')}</span>
                </button>
              </div>

              {/* Active / Configured Keys List */}
              <div className="bg-sand-50 dark:bg-charcoal-900 rounded-xl p-2 border border-sand-200 dark:border-charcoal-750 divide-y divide-sand-200 dark:divide-charcoal-800 max-h-72 overflow-y-auto">
                {currentVirtualKeys.map((keyItem, index) => (
                  <div
                    key={keyItem.id}
                    className="flex items-center justify-between py-2 px-2 hover:bg-sand-100/80 dark:hover:bg-charcoal-800/80 rounded-lg transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <input
                        type="checkbox"
                        checked={keyItem.enabled}
                        onChange={() => handleToggleKey(keyItem.id)}
                        className="rounded border-sand-300 dark:border-charcoal-700 text-herdr-600 focus:ring-herdr-500 w-4 h-4 cursor-pointer"
                        id={`toggle-${keyItem.id}`}
                      />
                      <label
                        htmlFor={`toggle-${keyItem.id}`}
                        className={cn(
                          'font-mono text-xs font-semibold px-2 py-0.5 rounded border cursor-pointer select-none',
                          keyItem.enabled
                            ? 'bg-paper dark:bg-charcoal-800 text-charcoal-900 dark:text-charcoal-100 border-sand-300 dark:border-charcoal-700'
                            : 'bg-sand-200 dark:bg-charcoal-950 text-charcoal-400 dark:text-charcoal-600 border-transparent'
                        )}
                      >
                        {keyItem.label}
                      </label>
                      <span className="text-[11px] text-charcoal-500 dark:text-charcoal-400 truncate">
                        {getLocalizedKeyTitle(keyItem, t)}
                      </span>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        disabled={index === 0}
                        onClick={() => handleMoveKey(index, 'up')}
                        className="p-1 text-charcoal-400 hover:text-charcoal-700 dark:hover:text-charcoal-200 disabled:opacity-30 rounded"
                        title={t('virtualKeyboard.moveUp')}
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={index === currentVirtualKeys.length - 1}
                        onClick={() => handleMoveKey(index, 'down')}
                        className="p-1 text-charcoal-400 hover:text-charcoal-700 dark:hover:text-charcoal-200 disabled:opacity-30 rounded"
                        title={t('virtualKeyboard.moveDown')}
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveKey(keyItem.id)}
                        className="p-1 text-red-400 hover:text-red-600 dark:hover:text-red-300 rounded"
                        title={t('virtualKeyboard.deleteKeyTitle')}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Add More Keys Button & Palette */}
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddKeyPalette(!showAddKeyPalette)}
                  className="w-full py-2 px-3 rounded-xl border border-dashed border-sand-300 dark:border-charcoal-700 hover:border-herdr-500 text-charcoal-700 dark:text-charcoal-300 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
                >
                  <Plus className="w-4 h-4 text-herdr-600" />
                  <span>{t('virtualKeyboard.addKey')}</span>
                </button>

                {showAddKeyPalette && (
                  <div className="mt-3 p-3 bg-sand-50 dark:bg-charcoal-900 border border-sand-300 dark:border-charcoal-700 rounded-xl space-y-3 animate-in fade-in">
                    <span className="font-semibold text-xs text-charcoal-800 dark:text-charcoal-200 block">
                      {t('virtualKeyboard.availableKeys')}
                    </span>

                    {/* Palette grid */}
                    <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto p-1">
                      {ALL_AVAILABLE_KEYS.map((availableKey) => {
                        const isAlreadyAdded = currentVirtualKeys.some((k) => k.id === availableKey.id);
                        return (
                          <button
                            key={availableKey.id}
                            type="button"
                            onClick={() => handleAddKey(availableKey)}
                            title={getLocalizedKeyTitle(availableKey, t)}
                            className={cn(
                              'px-2 py-1 rounded-lg text-xs font-mono font-medium border transition-colors flex items-center gap-1',
                              isAlreadyAdded
                                ? 'bg-sand-200 dark:bg-charcoal-800 text-charcoal-400 border-sand-300 dark:border-charcoal-700 opacity-60'
                                : 'bg-paper dark:bg-charcoal-800 hover:bg-herdr-50 dark:hover:bg-herdr-950/60 border-sand-300 dark:border-charcoal-700 text-charcoal-800 dark:text-charcoal-200 hover:border-herdr-400'
                            )}
                          >
                            <span>{availableKey.label}</span>
                            {isAlreadyAdded ? (
                              <Check className="w-3 h-3 text-emerald-600" />
                            ) : (
                              <Plus className="w-3 h-3 text-herdr-600" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-sand-200 dark:border-charcoal-750 flex items-center justify-between bg-sand-50 dark:bg-charcoal-900">
          <button
            type="button"
            onClick={handleResetDefaults}
            className="text-charcoal-500 hover:text-charcoal-800 dark:text-charcoal-400 dark:hover:text-charcoal-200 flex items-center gap-1 text-xs transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>{t('settings.resetDefaults')}</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-herdr-700 hover:bg-herdr-800 active:bg-herdr-900 text-white rounded-xl font-semibold text-xs transition-colors shadow-sm"
          >
            {t('common.done')}
          </button>
        </div>
      </div>
    </div>
  );
};
