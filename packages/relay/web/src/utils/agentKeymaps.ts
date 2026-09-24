import { parseKeyCombo } from '../protocol/keyCombo';

export interface AgentActionDef {
  id: string;
  labelKey: string;
  combo: string;
  verified: boolean;
  /** Left off the key bar until the user ticks it in settings. */
  defaultHidden?: boolean;
}

export interface AgentProfileDef {
  id: string;
  name: string;
  shortName: string;
  configHint?: string;
  /** The few actions the key bar shows by default; the rest wait in settings. */
  bar?: readonly string[];
  actions: AgentActionDef[];
}

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

export interface AppliedAgentAction extends AgentActionDef {
  defaultCombo: string;
  combo: string;
  hidden: boolean;
  custom: boolean;
  customLabel?: string;
}

const action = (id: string, labelKey: string, combo: string, verified = true): AgentActionDef => ({
  id,
  labelKey,
  combo,
  verified,
});

const PROFILES = {
  claude: {
    id: 'claude', name: 'Claude Code', shortName: 'Claude', configHint: '~/.claude/keybindings.json',
    bar: ['mode', 'rewind', 'details', 'model'],
    actions: [
      action('mode', 'mode', 'shift+tab'), action('rewind', 'rewind', 'esc esc'),
      action('details', 'details', 'ctrl+o'), action('model', 'model', 'alt+p'),
      action('thinking', 'thinking', 'alt+t'), action('todos', 'todos', 'ctrl+t'),
      action('background', 'background', 'ctrl+b'), action('editor', 'editor', 'ctrl+g'),
      action('history', 'history', 'ctrl+r'), action('stash', 'stash', 'ctrl+s'),
      action('pasteImage', 'pasteImage', 'ctrl+v'), action('newline', 'newline', 'ctrl+j'),
      action('interrupt', 'interrupt', 'esc'),
    ],
  },
  codex: {
    id: 'codex', name: 'Codex', shortName: 'Codex', configHint: '~/.codex/config.toml [tui.keymap]',
    bar: ['mode', 'editPrevious', 'details'],
    actions: [
      action('mode', 'mode', 'shift+tab'), action('editPrevious', 'editPrevious', 'esc esc'),
      action('details', 'details', 'ctrl+t'), action('queue', 'queue', 'tab'),
      action('history', 'history', 'ctrl+r'), action('copy', 'copy', 'ctrl+o'),
      action('editor', 'editor', 'ctrl+g'), action('newline', 'newline', 'ctrl+j'),
      action('clear', 'clear', 'ctrl+l'), action('interrupt', 'interrupt', 'esc'),
    ],
  },
  gemini: {
    id: 'gemini', name: 'Gemini CLI', shortName: 'Gemini', configHint: '~/.gemini/keybindings.json',
    bar: ['mode', 'yolo', 'rewind'],
    actions: [
      action('mode', 'mode', 'shift+tab'), action('yolo', 'yolo', 'ctrl+y'),
      action('rewind', 'rewind', 'esc esc'), action('todos', 'todos', 'ctrl+t'),
      action('expand', 'expand', 'ctrl+o'), action('background', 'background', 'ctrl+b'),
      action('editor', 'editor', 'ctrl+g'), action('history', 'history', 'ctrl+r'),
      action('undo', 'undo', 'ctrl+z'), action('newline', 'newline', 'ctrl+j'),
      action('interrupt', 'interrupt', 'esc'),
    ],
  },
  qwen: {
    id: 'qwen', name: 'Qwen Code', shortName: 'Qwen', bar: ['mode', 'history'], actions: [
      action('mode', 'mode', 'shift+tab'), action('interrupt', 'interrupt', 'esc'),
      action('history', 'history', 'ctrl+r'), action('newline', 'newline', 'ctrl+j'),
      action('todos', 'todos', 'ctrl+t', false), action('rewind', 'rewind', 'esc esc', false),
    ],
  },
  opencode: {
    id: 'opencode', name: 'OpenCode', shortName: 'OpenCode', configHint: 'tui.json keybinds',
    bar: ['palette', 'model', 'sessions'],
    actions: [
      action('agent', 'agent', 'tab'), action('agentBack', 'agentBack', 'shift+tab'),
      action('interrupt', 'interrupt', 'esc'), action('palette', 'palette', 'ctrl+p'),
      action('model', 'model', 'ctrl+x m'), action('recentModel', 'recentModel', 'f2'),
      action('variant', 'variant', 'ctrl+t'), action('newSession', 'newSession', 'ctrl+x n'),
      action('sessions', 'sessions', 'ctrl+x l'), action('undo', 'undo', 'ctrl+x u'),
      action('editor', 'editor', 'ctrl+x e'), action('newline', 'newline', 'ctrl+j'),
    ],
  },
  kilo: {
    id: 'kilo', name: 'Kilo Code', shortName: 'Kilo', configHint: '~/.config/kilo/tui.jsonc',
    bar: ['palette', 'model', 'sessions'],
    actions: [
      action('agent', 'agent', 'tab', false), action('agentBack', 'agentBack', 'shift+tab', false),
      action('interrupt', 'interrupt', 'esc'), action('palette', 'palette', 'ctrl+p'),
      action('model', 'model', 'ctrl+x m'), action('recentModel', 'recentModel', 'f2'),
      action('variant', 'variant', 'ctrl+t'), action('newSession', 'newSession', 'ctrl+x n'),
      action('sessions', 'sessions', 'ctrl+x l'), action('undo', 'undo', 'ctrl+x u'),
      action('editor', 'editor', 'ctrl+x e'), action('newline', 'newline', 'ctrl+j'),
    ],
  },
  pi: {
    id: 'pi', name: 'Pi', shortName: 'Pi', configHint: '~/.pi/agent/keybindings.json',
    bar: ['thinkingMode', 'modelPicker', 'tools'],
    actions: [
      action('thinkingMode', 'thinkingMode', 'shift+tab'), action('interrupt', 'interrupt', 'esc'),
      action('nextModel', 'nextModel', 'ctrl+p'), action('modelPicker', 'modelPicker', 'ctrl+l'),
      action('tools', 'tools', 'ctrl+o'), action('thinkingBlocks', 'thinkingBlocks', 'ctrl+t'),
      action('editor', 'editor', 'ctrl+g'), action('followup', 'followup', 'alt+enter'),
      action('dequeue', 'dequeue', 'alt+up'), action('newline', 'newline', 'shift+enter'),
    ],
  },
  omp: {
    id: 'omp', name: 'Oh My Pi', shortName: 'OMP', configHint: '~/.omp/agent/keybindings.yml',
    bar: ['thinkingMode', 'plan', 'model'],
    actions: [
      action('thinkingMode', 'thinkingMode', 'shift+tab'), action('plan', 'plan', 'alt+shift+p'),
      action('model', 'model', 'alt+m'), action('temporaryModel', 'temporaryModel', 'alt+p'),
      action('nextModel', 'nextModel', 'ctrl+p'), action('tools', 'tools', 'ctrl+o'),
      action('thinking', 'thinking', 'ctrl+t'), action('history', 'history', 'ctrl+r'),
      action('editor', 'editor', 'ctrl+g'), action('followup', 'followup', 'ctrl+enter'),
      action('interrupt', 'interrupt', 'esc'),
    ],
  },
  copilot: {
    id: 'copilot', name: 'GitHub Copilot', shortName: 'Copilot',
    bar: ['mode', 'expand', 'reasoning'],
    actions: [
      action('mode', 'mode', 'shift+tab'), action('interrupt', 'interrupt', 'esc'),
      action('expand', 'expand', 'ctrl+o'), action('expandAll', 'expandAll', 'ctrl+e'),
      action('reasoning', 'reasoning', 'ctrl+t'), action('editor', 'editor', 'ctrl+g'),
      action('clear', 'clear', 'ctrl+l'),
    ],
  },
  cursor: {
    id: 'cursor', name: 'Cursor', shortName: 'Cursor', bar: ['mode', 'review'], actions: [
      action('mode', 'mode', 'shift+tab'), action('review', 'review', 'ctrl+r'),
      action('newline', 'newline', 'ctrl+j'), action('interrupt', 'interrupt', 'esc', false),
    ],
  },
  droid: {
    id: 'droid', name: 'Factory Droid', shortName: 'Droid', configHint: 'In-app settings',
    bar: ['specMode', 'autonomy'],
    actions: [
      action('specMode', 'specMode', 'shift+tab'), action('autonomy', 'autonomy', 'ctrl+l'),
      action('details', 'details', 'ctrl+o', false), action('queue', 'queue', 'ctrl+enter'),
      action('interrupt', 'interrupt', 'esc', false),
    ],
  },
  kimi: {
    id: 'kimi', name: 'Kimi Code', shortName: 'Kimi',
    bar: ['plan', 'undoPicker', 'expand'],
    actions: [
      action('plan', 'plan', 'shift+tab'), action('interrupt', 'interrupt', 'esc'),
      action('undoPicker', 'undoPicker', 'esc esc'), action('expand', 'expand', 'ctrl+o'),
      action('editor', 'editor', 'ctrl+g'), action('steer', 'steer', 'ctrl+s'),
      action('undo', 'undo', 'ctrl+-'), action('newline', 'newline', 'ctrl+j'),
      action('pasteImage', 'pasteImage', 'ctrl+v'),
    ],
  },
  amp: {
    id: 'amp', name: 'Amp', shortName: 'Amp', bar: ['palette', 'reasoning', 'mode'], actions: [
      action('palette', 'palette', 'ctrl+o'), action('reasoning', 'reasoning', 'alt+d'),
      action('mode', 'mode', 'ctrl+s', false), action('editor', 'editor', 'ctrl+g'),
      action('history', 'history', 'ctrl+r'), action('sidebar', 'sidebar', 'ctrl+backslash'),
      action('pasteImage', 'pasteImage', 'ctrl+v'), action('interrupt', 'interrupt', 'esc', false),
    ],
  },
  hermes: {
    id: 'hermes', name: 'Hermes', shortName: 'Hermes',
    bar: ['interrupt', 'agents', 'sessions'],
    actions: [
      action('interrupt', 'interrupt', 'ctrl+c'), action('newline', 'newline', 'ctrl+j'),
      action('editor', 'editor', 'ctrl+g'), action('agents', 'agents', 'ctrl+t'),
      action('sessions', 'sessions', 'ctrl+x'),
    ],
  },
  qodercli: {
    id: 'qodercli', name: 'Qoder CLI', shortName: 'Qoder', configHint: '/shortcuts in-app',
    bar: ['permissionMode', 'bypass', 'tasks', 'interrupt'],
    actions: [
      action('permissionMode', 'permissionMode', 'shift+tab'), action('bypass', 'bypass', 'ctrl+y'),
      action('tasks', 'tasks', 'ctrl+t'), action('editor', 'editor', 'ctrl+x'),
      action('history', 'history', 'ctrl+r'), action('queue', 'queue', 'ctrl+enter'),
      action('newline', 'newline', 'ctrl+j'), action('pasteImage', 'pasteImage', 'alt+v'),
      action('interrupt', 'interrupt', 'ctrl+c'),
    ],
  },
  devin: {
    id: 'devin', name: 'Devin', shortName: 'Devin', configHint: '~/.config/devin/config.json keymap',
    bar: ['mode', 'thinking', 'interrupt'],
    actions: [
      action('mode', 'mode', 'shift+tab'), action('interrupt', 'interrupt', 'ctrl+c'),
      action('thinking', 'thinking', 'alt+t'), action('newline', 'newline', 'ctrl+j'),
      action('pasteImage', 'pasteImage', 'ctrl+v'),
    ],
  },
  grok: {
    id: 'grok', name: 'Grok CLI', shortName: 'Grok',
    bar: ['mode', 'rewind', 'interrupt'],
    actions: [
      action('mode', 'mode', 'shift+tab'), action('interrupt', 'interrupt', 'ctrl+c'),
      action('rewind', 'rewind', 'esc esc'), action('interject', 'interject', 'ctrl+enter'),
      action('multiline', 'multiline', 'ctrl+m'), action('newline', 'newline', 'alt+enter'),
      action('shortcuts', 'shortcuts', 'ctrl+.'),
    ],
  },
  agy: {
    id: 'agy', name: 'Antigravity', shortName: 'Antigravity',
    configHint: '~/.gemini/antigravity-cli/keybindings.json',
    bar: ['mode', 'approve', 'interrupt'],
    actions: [
      action('mode', 'mode', 'shift+tab'), action('interrupt', 'interrupt', 'ctrl+c'),
      action('background', 'background', 'ctrl+b'), action('approve', 'approve', 'ctrl+k'),
      action('clear', 'clear', 'esc esc'),
    ],
  },
  mastracode: {
    id: 'mastracode', name: 'MastraCode', shortName: 'MastraCode',
    bar: ['interrupt', 'thinking', 'expand'],
    actions: [
      action('interrupt', 'interrupt', 'ctrl+c'), action('thinking', 'thinking', 'ctrl+t'),
      action('expand', 'expand', 'ctrl+e'), action('followup', 'followup', 'ctrl+f'),
    ],
  },
  letta: {
    id: 'letta', name: 'Letta Code', shortName: 'Letta', bar: ['permissionMode'], actions: [
      action('permissionMode', 'permissionMode', 'shift+tab'), action('interrupt', 'interrupt', 'esc', false),
    ],
  },
  kiro: {
    id: 'kiro', name: 'Kiro CLI', shortName: 'Kiro', configHint: 'kiro-cli settings chat.keybindings.*',
    bar: ['agentSwap', 'details', 'steer'],
    actions: [
      action('agentSwap', 'agentSwap', 'shift+tab'), action('interrupt', 'interrupt', 'esc'),
      action('details', 'details', 'ctrl+t'), action('steer', 'steer', 'ctrl+s'),
      action('expand', 'expand', 'ctrl+o'), action('activity', 'activity', 'ctrl+x'),
      action('newline', 'newline', 'ctrl+j'),
    ],
  },
  cline: {
    id: 'cline', name: 'Cline', shortName: 'Cline', bar: ['autoApprove'], actions: [
      action('planAct', 'planAct', 'tab'), action('autoApprove', 'autoApprove', 'shift+tab'),
      action('interrupt', 'interrupt', 'esc', false),
    ],
  },
  maki: {
    id: 'maki', name: 'Maki', shortName: 'Maki', bar: ['rewind', 'search'], actions: [
      action('rewind', 'rewind', 'esc esc'), action('search', 'search', 'ctrl+f'),
      action('interrupt', 'interrupt', 'esc', false),
    ],
  },
  muse: {
    id: 'muse', name: 'Muse', shortName: 'Muse', configHint: '/keymap in-app',
    bar: ['queue', 'interruptCtrl'],
    actions: [
      action('interrupt', 'interrupt', 'esc'), action('queue', 'queue', 'alt+enter'),
      action('interruptCtrl', 'interrupt', 'ctrl+c'),
    ],
  },
  shell: { id: 'shell', name: 'Shell', shortName: 'Shell', actions: [] },
} as const satisfies Record<string, AgentProfileDef>;

export const AGENT_PROFILES = PROFILES;
export type AgentProfileId = keyof typeof PROFILES;
export type AgentProfilePin = 'auto' | AgentProfileId;
export const AGENT_PROFILE_IDS = Object.keys(PROFILES) as AgentProfileId[];

/** Canonical IDs follow `Agent::agent_label()` in Herdr 0.9.1. */
export const HERDR_AGENT_IDS = [
  'pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline', 'omp', 'mastracode',
  'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp', 'grok', 'hermes', 'kilo', 'qodercli',
  'qwen', 'letta', 'maki', 'muse',
] as const;

/** Process names and display labels accepted by Herdr's detector. */
export const AGENT_ID_ALIASES: Record<string, AgentProfileId> = {
  pi: 'pi', claude: 'claude', 'claude-code': 'claude', codex: 'codex', gemini: 'gemini',
  cursor: 'cursor', 'cursor-agent': 'cursor', devin: 'devin', 'devin-cli': 'devin', 'devin cli': 'devin',
  agy: 'agy', antigravity: 'agy', 'antigravity-cli': 'agy', cline: 'cline', '.cline': 'cline',
  omp: 'omp', mastracode: 'mastracode', 'mastra-code': 'mastracode', 'mastra code': 'mastracode',
  opencode: 'opencode', opencode2: 'opencode', 'open-code': 'opencode', copilot: 'copilot',
  'github-copilot': 'copilot', ghcs: 'copilot', kimi: 'kimi', 'kimi-code': 'kimi', 'kimi code': 'kimi',
  kiro: 'kiro', 'kiro-cli': 'kiro', droid: 'droid', amp: 'amp', 'amp-local': 'amp', grok: 'grok',
  'grok-build': 'grok', hermes: 'hermes', 'hermes-agent': 'hermes', kilo: 'kilo', 'kilo-code': 'kilo',
  'kilo code': 'kilo', qodercli: 'qodercli', qoderclicn: 'qodercli', qoder: 'qodercli', qodercn: 'qodercli',
  qwen: 'qwen', 'qwen-code': 'qwen', 'qwen code': 'qwen', letta: 'letta', 'letta-code': 'letta',
  'letta code': 'letta', maki: 'maki', muse: 'muse', 'muse-code': 'muse', 'muse-cli': 'muse', shell: 'shell',
};

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

export function normalizeAgentId(agent: string | null | undefined): string {
  if (!agent) return '';
  return agent.trim().toLowerCase().replace(/\\/g, '/').split('/').at(-1) || '';
}

export function resolveAgentId(agent: string | null | undefined): AgentProfileId | null {
  const normalized = normalizeAgentId(agent);
  if (AGENT_ID_ALIASES[normalized]) return AGENT_ID_ALIASES[normalized];
  if (/^muse-bin-\d/.test(normalized)) return 'muse';
  return null;
}

/** Resolve a browser window's pin, or follow the focused Herdr pane. */
export function resolveProfile(
  focusedAgent: string | null | undefined,
  pin: string | null | undefined = 'auto',
): AgentProfileId {
  if (pin && pin !== 'auto') return resolveAgentId(pin) || 'shell';
  return resolveAgentId(focusedAgent) || 'shell';
}

/** Apply saved labels, key combos, visibility and order without mutating defaults. */
export function applyOverrides(
  defaults: AgentActionDef[],
  overrides?: AgentProfileKeymapOverride,
): AppliedAgentAction[] {
  const rows: AppliedAgentAction[] = defaults.map((definition) => {
    const saved = overrides?.actions?.[definition.id];
    let combo = typeof saved?.keys === 'string' ? saved.keys : definition.combo;
    try { parseKeyCombo(combo); } catch { combo = definition.combo; }
    return {
      ...definition,
      defaultCombo: definition.combo,
      combo,
      hidden: typeof saved?.hidden === 'boolean' ? saved.hidden : definition.defaultHidden === true,
      custom: false,
    };
  });

  const ids = new Set(rows.map((row) => row.id));
  for (const custom of overrides?.custom || []) {
    if (!custom || typeof custom.id !== 'string' || ids.has(custom.id)) continue;
    let combo = custom.keys;
    try { parseKeyCombo(combo); } catch { continue; }
    rows.push({
      id: custom.id,
      labelKey: 'custom',
      defaultCombo: combo,
      combo,
      verified: true,
      hidden: false,
      custom: true,
      customLabel: custom.label,
    });
    ids.add(custom.id);
  }

  if (Array.isArray(overrides?.order)) {
    const rank = new Map(overrides.order.map((id, index) => [id, index]));
    rows.sort((left, right) => (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER));
  }
  return rows;
}

/** Hide a common shell cap if the agent already exposes that same combo. */
export function filterDuplicateGenericActions(
  agentActions: AppliedAgentAction[],
  genericActions: AppliedAgentAction[],
): AppliedAgentAction[] {
  const agentCombos = new Set(agentActions.filter((item) => !item.hidden).map((item) => item.combo.trim().toLowerCase()));
  return genericActions.filter((item) => !agentCombos.has(item.combo.trim().toLowerCase()));
}

export function getProfileActions(
  profileId: AgentProfileId,
  overrides?: AgentProfileKeymapOverride,
): AppliedAgentAction[] {
  const profile: AgentProfileDef = AGENT_PROFILES[profileId];
  const bar = new Set([
    ...(profile.bar || []),
    ...(profileId === 'shell' ? SHELL_GENERIC_BAR : AGENT_GENERIC_BAR),
  ]);
  const defaults = [...profile.actions, ...GENERIC_SHELL_ACTIONS]
    .map((definition) => ({ ...definition, defaultHidden: !bar.has(definition.id) }));
  return applyOverrides(defaults, overrides);
}

export function getDrawerGroups(
  profileId: AgentProfileId,
  overrides?: AgentProfileKeymapOverride,
): { agentActions: AppliedAgentAction[]; genericActions: AppliedAgentAction[] } {
  const rows = getProfileActions(profileId, overrides);
  const agentActions = rows.filter((item) => !item.id.startsWith('generic'));
  const genericActions = rows.filter((item) => item.id.startsWith('generic'));
  return {
    agentActions: agentActions.filter((item) => !item.hidden),
    genericActions: filterDuplicateGenericActions(agentActions, genericActions).filter((item) => !item.hidden),
  };
}
