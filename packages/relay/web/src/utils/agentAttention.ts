import type { ServerAgentStatusMessage } from '@protocol/messages';

/**
 * What on the workstation is waiting for a person: agents that stopped to ask
 * (blocked) and agents that finished (done). Working and idle agents need
 * nobody, so they never raise anything.
 */
export interface AttentionCounts {
  blocked: number;
  done: number;
}

export type AttentionLevel = 'blocked' | 'done';

export function attentionCounts(status: ServerAgentStatusMessage | null): AttentionCounts | null {
  if (!status) return null;
  return { blocked: status.counts?.blocked ?? 0, done: status.counts?.done ?? 0 };
}

/** The most urgent thing waiting, if anything is. */
export function attentionLevel(counts: AttentionCounts | null): AttentionLevel | null {
  if (!counts) return null;
  if (counts.blocked > 0) return 'blocked';
  if (counts.done > 0) return 'done';
  return null;
}

/**
 * A prefix for the tab title, `(2⚠ 1✓)`, so a background tab says there is
 * something to look at. Empty when nothing is waiting.
 */
export function formatAttentionPrefix(counts: AttentionCounts | null): string {
  if (!counts) return '';
  const parts: string[] = [];
  if (counts.blocked > 0) parts.push(`${counts.blocked}⚠`);
  if (counts.done > 0) parts.push(`${counts.done}✓`);
  return parts.length > 0 ? `(${parts.join(' ')})` : '';
}

/**
 * What became newly worth a person's attention between two reports, if
 * anything: an agent that has just stopped to ask beats one that has just
 * finished.
 *
 * With no earlier report there is nothing to compare against. The first report
 * after connecting describes how things already were, and announcing that
 * would alert on every reconnect.
 */
export function newAttention(
  previous: ServerAgentStatusMessage | null,
  next: ServerAgentStatusMessage | null,
): AttentionLevel | null {
  if (!previous || !next) return null;
  const before = new Map(previous.agents.map((agent) => [agent.paneId, agent.status]));
  let level: AttentionLevel | null = null;
  for (const agent of next.agents) {
    if (agent.status !== 'blocked' && agent.status !== 'done') continue;
    if (before.get(agent.paneId) === agent.status) continue;
    if (agent.status === 'blocked') return 'blocked';
    level = 'done';
  }
  // The host caps the agent list; a count that rose beyond it is still news.
  const was = attentionCounts(previous)!;
  const now = attentionCounts(next)!;
  if (now.blocked > was.blocked) return 'blocked';
  if (!level && now.done > was.done) level = 'done';
  return level;
}
