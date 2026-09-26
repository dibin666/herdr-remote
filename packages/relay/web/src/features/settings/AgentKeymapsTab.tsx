import type React from 'react';
import { useRef, useState } from 'react';
import { useConnection, useSettings } from '@/context/TerminalContext';
import { formatComboCaption, KeyComboError, parseKeyCombo } from '@/shared/keys/keyCombo';
import {
  AGENT_PROFILE_IDS,
  AGENT_PROFILES,
  type AgentProfileDef,
  type AgentProfileId,
  type AgentProfileKeymapOverride,
  type AppliedAgentAction,
  clearBarVisibility,
  getBarChoices,
  getProfileActions,
} from '@/features/agents/agentKeymaps';
import { cn } from '@/shared/lib/cn';
import {
  Button,
  GLYPH,
  IconButton,
  Input,
  KeyCap,
  Select,
  SettingRow,
  SettingSection,
} from '@/shared/ui';
import { AGENT_ROW_GRID, COMPACT, COMPACT_FIELD, CONTROL_FIELD, DANGER_GHOST } from './styles';

/**
 * The agent keys on the key bar, per agent: which show, what each sends, and
 * the user's own. `profile` is the agent picked here, or null for the one the
 * workstation has focused.
 */
export const AgentKeymapsTab: React.FC<{
  profile: AgentProfileId | null;
  onProfileChange: (profile: AgentProfileId) => void;
}> = ({ profile, onProfileChange }) => {
  const { settings, updateSettings, t } = useSettings();
  const { agentProfile } = useConnection();
  const [comboDrafts, setComboDrafts] = useState<Record<string, string>>({});
  const comboDraftsRef = useRef<Record<string, string>>({});
  const [customLabel, setCustomLabel] = useState('');
  const [customCombo, setCustomCombo] = useState('');

  const keymapProfile = profile || agentProfile;
  const profileOverrides: AgentProfileKeymapOverride = settings.agentKeymaps[keymapProfile] || {};
  const profileActions = getProfileActions(keymapProfile, profileOverrides);
  const barChoices = getBarChoices(keymapProfile, profileOverrides);
  const shownBarCount = barChoices.filter((item) => !item.hidden).length;
  const actionLabel = (item: AppliedAgentAction) =>
    item.custom ? item.customLabel || '' : t(`agentActions.${item.labelKey}`);
  const actionCaption = (item: AppliedAgentAction) => {
    try {
      return formatComboCaption(item.combo);
    } catch {
      return item.combo;
    }
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
    try {
      parseKeyCombo(customCombo);
    } catch {
      return;
    }
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

  return (
    <div className="space-y-4">
      <SettingSection
        title={t('agentKeymaps.settingsProfileLabel')}
        aside={
          <Button
            variant="ghost"
            onClick={restoreAgentProfile}
            className={cn(DANGER_GHOST, COMPACT)}
          >
            {t('agentKeymaps.restoreProfile')}
          </Button>
        }
      >
        <SettingRow
          label={t('agentKeymaps.profileRowLabel')}
          htmlFor="agent-keymap-profile"
          hint={
            (AGENT_PROFILES[keymapProfile] as AgentProfileDef).configHint
              ? t('agentKeymaps.configHint', {
                  path: (AGENT_PROFILES[keymapProfile] as AgentProfileDef).configHint!,
                })
              : undefined
          }
          control={
            <Select
              id="agent-keymap-profile"
              aria-label={t('agentKeymaps.settingsProfileLabel')}
              value={keymapProfile}
              onChange={(event) => onProfileChange(event.target.value as AgentProfileId)}
              className={CONTROL_FIELD}
            >
              {AGENT_PROFILE_IDS.map((id) => (
                <option key={id} value={id}>
                  {AGENT_PROFILES[id].name}
                </option>
              ))}
            </Select>
          }
        />
      </SettingSection>

      <SettingSection
        title={t('agentKeymaps.barGroup')}
        aside={
          <Button
            variant="ghost"
            onClick={restoreBarVisibility}
            className={cn(DANGER_GHOST, COMPACT)}
          >
            {t('agentKeymaps.restoreBar')}
          </Button>
        }
      >
        <div className="space-y-2 py-1.5">
          <p className="text-tui-sm leading-snug text-tui-faint">
            {t('agentKeymaps.barHint', {
              profile: AGENT_PROFILES[keymapProfile].name,
              count: shownBarCount,
            })}
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
                      : 'border-tui-border text-tui-muted hover:border-tui-accent hover:text-tui-accent',
                  )}
                >
                  <span aria-hidden="true" className="font-bold">
                    {shown ? GLYPH.check : '+'}
                  </span>
                  <span className="font-bold">{caption}</span>
                  <span className={shown ? undefined : 'opacity-80'}>{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </SettingSection>

      <SettingSection
        title={t('agentKeymaps.listGroup', { profile: AGENT_PROFILES[keymapProfile].name })}
      >
        {profileActions.map((item, index) => {
          const label = actionLabel(item);
          const defaultText = t('agentKeymaps.defaultCombo', {
            combo: formatComboCaption(item.defaultCombo),
          });
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
              <span
                className="min-w-0 truncate text-tui text-tui-text [grid-area:label]"
                title={label}
              >
                {label}
                {!item.verified && (
                  <span className="ml-1 text-tui-sm text-tui-faint">
                    {t('agentKeymaps.unverified')}
                  </span>
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
              <span
                className="min-w-0 truncate text-tui-sm text-tui-faint [grid-area:default]"
                title={defaultText}
              >
                {defaultText}
              </span>
              <div className="flex items-center justify-end [grid-area:actions]">
                <IconButton
                  onClick={() => resetAgentAction(item)}
                  title={t('agentKeymaps.resetAction')}
                  aria-label={`${t('agentKeymaps.resetAction')} ${label}`}
                >
                  ↺
                </IconButton>
                <IconButton
                  disabled={index === 0}
                  onClick={() => moveAgentAction(index, 'up')}
                  title={t('agentKeymaps.moveUp')}
                  aria-label={`${t('agentKeymaps.moveUp')} ${label}`}
                >
                  ↑
                </IconButton>
                <IconButton
                  disabled={index === profileActions.length - 1}
                  onClick={() => moveAgentAction(index, 'down')}
                  title={t('agentKeymaps.moveDown')}
                  aria-label={`${t('agentKeymaps.moveDown')} ${label}`}
                >
                  ↓
                </IconButton>
                {item.custom ? (
                  <IconButton
                    variant="danger"
                    onClick={() => removeCustomAction(item.id)}
                    title={t('agentKeymaps.removeCustom')}
                    aria-label={`${t('agentKeymaps.removeCustom')} ${label}`}
                  >
                    {GLYPH.cross}
                  </IconButton>
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
          {customCombo.trim() &&
            (() => {
              try {
                parseKeyCombo(customCombo);
                return (
                  <p className="text-tui-sm text-tui-info">{formatComboCaption(customCombo)}</p>
                );
              } catch (reason) {
                const error = getComboErrorText(reason);
                return (
                  <p className="text-tui-sm text-tui-bad" role="alert">
                    {error}
                  </p>
                );
              }
            })()}
        </div>
      </SettingSection>
    </div>
  );
};
