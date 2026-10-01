// The focused agent's shortcuts, inline on the key bar after the plain keys.

import { useConnection, useSettings } from '@/context/TerminalContext';
import { formatComboCaption } from '@/shared/keys/keyCombo';
import {
  AGENT_PROFILES,
  type AppliedAgentAction,
  getDrawerGroups,
} from '@/features/agents/agentKeymaps';
import { cn } from '@/shared/lib/cn';
import { CAP_BASE, CHORD_TONE_CLASS } from './caps';
import { KeyIcon, KeyLabel } from './KeyLabel';

export function AgentKeyActions({
  keyClass,
  squareKeyClass,
  onCustomize,
  sendCombo,
}: {
  keyClass: string;
  squareKeyClass: string;
  /** Opens settings on the agent keys tab, where the user picks what the bar shows. */
  onCustomize?: () => void;
  sendCombo: (combo: string) => void;
}) {
  const { settings, t } = useSettings();
  const { agentProfile, shellProfile } = useConnection();
  const agentGroups = getDrawerGroups(
    agentProfile,
    settings.agentKeymaps[agentProfile],
    shellProfile,
  );

  const renderAgentAction = (item: AppliedAgentAction) => {
    let caption = '';
    try {
      caption = formatComboCaption(item.combo);
    } catch {
      // A combo the user is still typing has no caption yet; the label is enough.
    }
    const label = item.custom ? item.customLabel || '' : t(`agentActions.${item.labelKey}`);
    const tone =
      item.labelKey === 'interrupt' && item.combo.trim().toLowerCase() === 'ctrl+c'
        ? 'bad'
        : item.combo.trim().toLowerCase() === 'ctrl+z'
          ? 'warn'
          : 'default';
    return (
      <button
        key={item.id}
        type="button"
        data-testid={`agent-key-${item.id}`}
        onClick={() => sendCombo(item.combo)}
        className={cn(CAP_BASE, keyClass, 'font-bold', CHORD_TONE_CLASS[tone])}
        title={`${caption} ${label}`.trim()}
        aria-label={`${caption} ${label}`.trim()}
      >
        {/* The combo alone keeps every cap one size; what it does is in the
            title and the accessible name. A custom key with no combo caption
            yet shows its own label instead. */}
        <KeyLabel text={caption || label} />
      </button>
    );
  };

  const actions = [...agentGroups.agentActions, ...agentGroups.genericActions];
  // Kept even with every shortcut hidden, so there is always a way back to them.
  if (actions.length === 0 && !onCustomize) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of keys in a toolbar, not a form fieldset
    <div
      data-testid="agent-key-actions"
      role="group"
      aria-label={`${AGENT_PROFILES[agentProfile].name} ${t('agentKeymaps.agentGroup')}`}
      className="flex shrink-0 items-center gap-1"
    >
      <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-tui-border-dim" />
      {actions.map(renderAgentAction)}
      {onCustomize && (
        <button
          type="button"
          data-testid="agent-key-customize"
          onClick={onCustomize}
          className={cn(
            CAP_BASE,
            squareKeyClass,
            'border-tui-border-dim bg-transparent text-tui-faint hover:border-tui-accent hover:text-tui-accent',
          )}
          title={t('agentKeymaps.customizeBar')}
          aria-label={t('agentKeymaps.customizeBar')}
        >
          <KeyIcon name="customize" />
        </button>
      )}
    </div>
  );
}
