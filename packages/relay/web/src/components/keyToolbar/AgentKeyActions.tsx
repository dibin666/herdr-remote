// The focused agent's shortcuts, inline on the key bar after the plain keys.

import { useConnection, useSettings } from '../../context/TerminalContext';
import { formatComboCaption } from '../../protocol/keyCombo';
import { AGENT_PROFILES, type AppliedAgentAction, getDrawerGroups } from '../../utils/agentKeymaps';
import { cn } from '../../utils/cn';
import { CAP_BASE, CHORD_TONE_CLASS } from './caps';

export function AgentKeyActions({
  capHeight,
  onCustomize,
  sendCombo,
}: {
  capHeight: string;
  /** Opens settings on the agent keys tab, where the user picks what the bar shows. */
  onCustomize?: () => void;
  sendCombo: (combo: string) => void;
}) {
  const { settings, t } = useSettings();
  const { agentProfile } = useConnection();
  const agentGroups = getDrawerGroups(agentProfile, settings.agentKeymaps[agentProfile]);

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
        className={cn(CAP_BASE, capHeight, 'max-w-[10rem] gap-1 px-1.5', CHORD_TONE_CLASS[tone])}
        title={`${caption} ${label}`.trim()}
        aria-label={`${caption} ${label}`.trim()}
      >
        <span className="font-bold">{caption}</span>
        <span className="max-w-[5rem] truncate text-tui-sm opacity-70">{label}</span>
      </button>
    );
  };

  const actions = [...agentGroups.agentActions, ...agentGroups.genericActions];
  // Kept even with every shortcut hidden, so there is always a way back to them.
  if (actions.length === 0 && !onCustomize) return null;
  return (
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
            capHeight,
            'px-1.5 text-tui-sm border-tui-border-dim bg-transparent text-tui-faint hover:border-tui-accent hover:text-tui-accent',
          )}
          title={t('agentKeymaps.customizeBar')}
          aria-label={t('agentKeymaps.customizeBar')}
        >
          {t('agentKeymaps.customizeBarShort')}
        </button>
      )}
    </div>
  );
}
