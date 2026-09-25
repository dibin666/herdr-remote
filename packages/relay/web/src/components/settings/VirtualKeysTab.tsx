import type React from 'react';
import { useState } from 'react';
import { useSettings, useToasts } from '../../context/TerminalContext';
import { cn } from '../../utils/cn';
import {
  ALL_AVAILABLE_KEYS,
  getDefaultVirtualKeys,
  getLocalizedKeyTitle,
  type ToolbarKeyDef,
} from '../../utils/virtualKeys';
import { Button, GLYPH, IconButton, KeyCap, SettingSection, Toggle } from '../tui';
import { COMPACT, CONTROL_FIELD, DANGER_GHOST, toggleWords } from './styles';

/** Which keys the touch toolbar shows, in which order. */
export const VirtualKeysTab: React.FC = () => {
  const { settings, updateSettings, t } = useSettings();
  const { addToast } = useToasts();
  const [showAddKeyPalette, setShowAddKeyPalette] = useState(false);
  const toggles = toggleWords(t);

  const currentVirtualKeys: ToolbarKeyDef[] =
    settings.virtualKeys && settings.virtualKeys.length > 0
      ? settings.virtualKeys
      : getDefaultVirtualKeys();

  // Virtual keys reordering and management
  const handleToggleKey = (keyId: string) => {
    const updated = currentVirtualKeys.map((k) =>
      k.id === keyId ? { ...k, enabled: !k.enabled } : k,
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
        k.id === newKey.id ? { ...k, enabled: true } : k,
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
    <div className="space-y-3">
      <SettingSection
        title={t('virtualKeyboard.customizeTitle')}
        aside={
          <Button
            variant="ghost"
            onClick={handleResetVirtualKeys}
            className={cn(DANGER_GHOST, COMPACT)}
          >
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
                  keyItem.enabled ? 'text-tui-text' : 'text-tui-faint',
                )}
              >
                {title}
              </span>
              <Toggle
                label={`${t('virtualKeyboard.enableKey')} ${keyItem.label}`}
                {...toggles}
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
                      : 'border-tui-border text-tui-text hover:border-tui-accent hover:text-tui-accent',
                  )}
                >
                  <span>{availableKey.label}</span>
                  <span
                    aria-hidden="true"
                    className={isAlreadyAdded ? 'text-tui-ok' : 'text-tui-accent'}
                  >
                    {isAlreadyAdded ? GLYPH.check : '+'}
                  </span>
                </button>
              );
            })}
          </div>
        </SettingSection>
      )}
    </div>
  );
};
