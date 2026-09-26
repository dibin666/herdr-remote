// Which agent profile a pane's agent name means.

import type { AgentProfileId } from './agentProfiles';

/** Canonical IDs follow `Agent::agent_label()` in Herdr 0.9.1. */
export const HERDR_AGENT_IDS = [
  'pi',
  'claude',
  'codex',
  'gemini',
  'cursor',
  'devin',
  'agy',
  'cline',
  'omp',
  'mastracode',
  'opencode',
  'copilot',
  'kimi',
  'kiro',
  'droid',
  'amp',
  'grok',
  'hermes',
  'kilo',
  'qodercli',
  'qwen',
  'letta',
  'maki',
  'muse',
] as const;

/** Process names and display labels accepted by Herdr's detector. */
export const AGENT_ID_ALIASES: Record<string, AgentProfileId> = {
  pi: 'pi',
  claude: 'claude',
  'claude-code': 'claude',
  codex: 'codex',
  gemini: 'gemini',
  cursor: 'cursor',
  'cursor-agent': 'cursor',
  devin: 'devin',
  'devin-cli': 'devin',
  'devin cli': 'devin',
  agy: 'agy',
  antigravity: 'agy',
  'antigravity-cli': 'agy',
  cline: 'cline',
  '.cline': 'cline',
  omp: 'omp',
  mastracode: 'mastracode',
  'mastra-code': 'mastracode',
  'mastra code': 'mastracode',
  opencode: 'opencode',
  opencode2: 'opencode',
  'open-code': 'opencode',
  copilot: 'copilot',
  'github-copilot': 'copilot',
  ghcs: 'copilot',
  kimi: 'kimi',
  'kimi-code': 'kimi',
  'kimi code': 'kimi',
  kiro: 'kiro',
  'kiro-cli': 'kiro',
  droid: 'droid',
  amp: 'amp',
  'amp-local': 'amp',
  grok: 'grok',
  'grok-build': 'grok',
  hermes: 'hermes',
  'hermes-agent': 'hermes',
  kilo: 'kilo',
  'kilo-code': 'kilo',
  'kilo code': 'kilo',
  qodercli: 'qodercli',
  qoderclicn: 'qodercli',
  qoder: 'qodercli',
  qodercn: 'qodercli',
  qwen: 'qwen',
  'qwen-code': 'qwen',
  'qwen code': 'qwen',
  letta: 'letta',
  'letta-code': 'letta',
  'letta code': 'letta',
  maki: 'maki',
  muse: 'muse',
  'muse-code': 'muse',
  'muse-cli': 'muse',
  shell: 'shell',
};

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
