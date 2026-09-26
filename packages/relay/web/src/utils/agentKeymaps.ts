// The key bar for an agent: its keys with the user's rebinds, visibility,
// order and custom keys applied.

import { parseKeyCombo } from '../protocol/keyCombo';
import {
  type AgentActionDef,
  type AgentActionLabel,
  type AgentProfileDef,
  type AgentProfileId,
  action,
  AGENT_PROFILES,
} from './agentProfiles';

export * from './agentIds';
export * from './agentProfiles';

export interface AgentKeymapActionOverride {
  keys?: string;
  hidden?: boolean;
}

export interface AgentKeymapCustomAction {
  id: string;
  label: string;
  keys: string;
}

export interface AgentProfileKeymapOverride {
  order?: string[];
  actions?: Record<string, AgentKeymapActionOverride>;
  custom?: AgentKeymapCustomAction[];
}

export type AgentKeymapsSettings = Record<string, AgentProfileKeymapOverride>;

interface AppliedAgentActionBase extends Omit<AgentActionDef, 'labelKey'> {
  defaultCombo: string;
  combo: string;
  hidden: boolean;
}

/** An action as the key bar shows it: built in and translated, or the user's own. */
export type AppliedAgentAction = AppliedAgentActionBase &
  (
    | { custom: false; labelKey: AgentActionLabel; customLabel?: undefined }
    | { custom: true; labelKey: 'custom'; customLabel?: string }
  );

export const GENERIC_SHELL_ACTIONS: AgentActionDef[] = [
  action('genericCtrlC', 'interrupt', 'ctrl+c'),
  action('genericCtrlD', 'eof', 'ctrl+d'),
  action('genericCtrlZ', 'suspend', 'ctrl+z'),
  action('genericCtrlL', 'clear', 'ctrl+l'),
  action('genericCtrlR', 'history', 'ctrl+r'),
  action('genericCtrlA', 'startOfLine', 'ctrl+a'),
  action('genericCtrlE', 'endOfLine', 'ctrl+e'),
  action('genericCtrlK', 'killToEnd', 'ctrl+k'),
];

/** Common chords a bare shell keeps on the bar; an agent only keeps ^C. */
const SHELL_GENERIC_BAR = ['genericCtrlC', 'genericCtrlD', 'genericCtrlL', 'genericCtrlR'];
const AGENT_GENERIC_BAR = ['genericCtrlC'];

/** Apply saved labels, key combos, visibility and order without mutating defaults. */
export function applyOverrides(
  defaults: AgentActionDef[],
  overrides?: AgentProfileKeymapOverride,
): AppliedAgentAction[] {
  const rows: AppliedAgentAction[] = defaults.map((definition) => {
    const saved = overrides?.actions?.[definition.id];
    let combo = typeof saved?.keys === 'string' ? saved.keys : definition.combo;
    try {
      parseKeyCombo(combo);
    } catch {
      combo = definition.combo;
    }
    return {
      ...definition,
      defaultCombo: definition.combo,
      combo,
      hidden: typeof saved?.hidden === 'boolean' ? saved.hidden : definition.defaultHidden === true,
      custom: false as const,
    };
  });

  const ids = new Set(rows.map((row) => row.id));
  for (const custom of overrides?.custom || []) {
    if (!custom || typeof custom.id !== 'string' || ids.has(custom.id)) continue;
    const combo = custom.keys;
    try {
      parseKeyCombo(combo);
    } catch {
      continue;
    }
    rows.push({
      id: custom.id,
      labelKey: 'custom',
      defaultCombo: combo,
      combo,
      verified: true,
      hidden: overrides?.actions?.[custom.id]?.hidden === true,
      custom: true,
      customLabel: custom.label,
    });
    ids.add(custom.id);
  }

  if (Array.isArray(overrides?.order)) {
    const rank = new Map(overrides.order.map((id, index) => [id, index]));
    rows.sort(
      (left, right) =>
        (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    );
  }
  return rows;
}

/**
 * Drop a common shell cap the agent already binds to the same combo, shown or
 * not, so each combo has one switch in settings and hiding it hides it.
 */
export function filterDuplicateGenericActions(
  agentActions: AppliedAgentAction[],
  genericActions: AppliedAgentAction[],
): AppliedAgentAction[] {
  const agentCombos = new Set(agentActions.map((item) => item.combo.trim().toLowerCase()));
  return genericActions.filter((item) => !agentCombos.has(item.combo.trim().toLowerCase()));
}

const isGenericAction = (item: { id: string }) => item.id.startsWith('generic');

export function getProfileActions(
  profileId: AgentProfileId,
  overrides?: AgentProfileKeymapOverride,
): AppliedAgentAction[] {
  const profile: AgentProfileDef = AGENT_PROFILES[profileId];
  const bar = new Set([
    ...(profile.bar || []),
    ...(profileId === 'shell' ? SHELL_GENERIC_BAR : AGENT_GENERIC_BAR),
  ]);
  const defaults = [...profile.actions, ...GENERIC_SHELL_ACTIONS].map((definition) => ({
    ...definition,
    defaultHidden: !bar.has(definition.id),
  }));
  return applyOverrides(defaults, overrides);
}

/** Every cap this profile can put on the key bar, shown or hidden, one per combo. */
export function getBarChoices(
  profileId: AgentProfileId,
  overrides?: AgentProfileKeymapOverride,
): AppliedAgentAction[] {
  const rows = getProfileActions(profileId, overrides);
  const agentActions = rows.filter((item) => !isGenericAction(item));
  const kept = new Set(filterDuplicateGenericActions(agentActions, rows.filter(isGenericAction)));
  return rows.filter((item) => !isGenericAction(item) || kept.has(item));
}

export function getDrawerGroups(
  profileId: AgentProfileId,
  overrides?: AgentProfileKeymapOverride,
): { agentActions: AppliedAgentAction[]; genericActions: AppliedAgentAction[] } {
  const shown = getBarChoices(profileId, overrides).filter((item) => !item.hidden);
  return {
    agentActions: shown.filter((item) => !isGenericAction(item)),
    genericActions: shown.filter(isGenericAction),
  };
}

/** Forget the user's show/hide choices for a profile, keeping rebinds and custom keys. */
export function clearBarVisibility(
  overrides: AgentProfileKeymapOverride,
): AgentProfileKeymapOverride {
  const actions: NonNullable<AgentProfileKeymapOverride['actions']> = {};
  for (const [id, saved] of Object.entries(overrides.actions || {})) {
    const rest = { ...saved };
    delete rest.hidden;
    if (Object.keys(rest).length > 0) actions[id] = rest;
  }
  return { ...overrides, actions };
}
