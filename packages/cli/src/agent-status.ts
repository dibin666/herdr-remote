/**
 * What the agents on this workstation are doing, small enough to put in a
 * status bar.
 *
 * The question a phone actually has is "does anything need me?", and the
 * terminal is a poor way to ask it: finding a blocked agent means navigating
 * Herdr's sidebar through a viewport the width of a hand. Herdr already knows
 * the answer — it classifies every pane as idle, working, blocked, done or
 * unknown — so this turns a session snapshot into the two-line version.
 *
 * Deliberately a pure function over a snapshot. The socket, the debounce and
 * the retry live in the host connector; what counts as "needs me" lives here,
 * where it can be tested without either.
 */

import type { AgentStatus, AgentStatusEntry } from 'herdr-remote-relay/protocol';

/** Herdr's own vocabulary, in the order a person cares about them. */
const AGENT_STATUSES: readonly AgentStatus[] = ['blocked', 'done', 'working', 'idle', 'unknown'];

/** The part of Herdr's `session.snapshot` answer read here; all of it untrusted. */
export interface HerdrSessionSnapshot {
  agents?: unknown;
  panes?: unknown;
  focused_pane_id?: unknown;
}

type SnapshotRecord = Record<string, unknown> | null | undefined;

export interface AgentSummary {
  focusedPaneId: string | null;
  focusedAgent: string | null;
  counts: Record<AgentStatus, number>;
  total: number;
  agents: (AgentStatusEntry & { status: AgentStatus })[];
}

/**
 * How many agents travel with the summary.
 *
 * The counts are always exact; this caps only the named list, which exists so a
 * future screen can say *which* agent is blocked. A workstation with more than
 * this many live agents is not going to be read off a phone anyway.
 */
const MAX_LISTED_AGENTS = 16;

/** Titles come from a remote program; keep them short and printable. */
const MAX_TITLE_LENGTH = 48;

function cleanText(value: unknown, limit = MAX_TITLE_LENGTH): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const collapsed = value
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!collapsed) return null;
  return collapsed.length > limit ? collapsed.slice(0, limit) : collapsed;
}

function normalizeStatus(value: unknown): AgentStatus {
  return (AGENT_STATUSES as readonly unknown[]).includes(value)
    ? (value as AgentStatus)
    : 'unknown';
}

function emptyCounts(): Record<AgentStatus, number> {
  return Object.fromEntries(AGENT_STATUSES.map((status) => [status, 0])) as Record<
    AgentStatus,
    number
  >;
}

/**
 * Turn `session.snapshot` into the summary the browser receives.
 *
 * Sorted by how much each status wants attention, so the capped list keeps the
 * agents worth naming rather than the first ones Herdr happened to report.
 * `focusedPaneId` and `focusedAgent` also track the live pane selection,
 * including shells and panes Herdr has not added to its agent summary.
 */
function summarizeAgents(snapshot: HerdrSessionSnapshot | null | undefined): AgentSummary {
  const entries: SnapshotRecord[] = Array.isArray(snapshot?.agents) ? snapshot.agents : [];
  const panes: SnapshotRecord[] = Array.isArray(snapshot?.panes) ? snapshot.panes : [];
  const reportedFocusId =
    typeof snapshot?.focused_pane_id === 'string' && snapshot.focused_pane_id
      ? snapshot.focused_pane_id
      : null;
  // `focused_pane_id` is the primary signal in Herdr snapshots. The focused
  // flags are a fallback for snapshots where that top-level field is absent.
  const focusedPane =
    (reportedFocusId
      ? panes.find((pane) => pane?.pane_id === reportedFocusId)
      : panes.find((pane) => pane?.focused === true)) || null;
  const focusedAgentEntry =
    (reportedFocusId
      ? entries.find((entry) => entry?.pane_id === reportedFocusId)
      : entries.find((entry) => entry?.focused === true)) || null;
  const focusedPaneId =
    reportedFocusId ||
    (typeof focusedPane?.pane_id === 'string' ? focusedPane.pane_id : null) ||
    (typeof focusedAgentEntry?.pane_id === 'string' ? focusedAgentEntry.pane_id : null);
  const focusedAgent =
    typeof focusedPane?.agent === 'string'
      ? focusedPane.agent
      : typeof focusedAgentEntry?.agent === 'string'
        ? focusedAgentEntry.agent
        : null;
  const counts = emptyCounts();
  const ranked: AgentSummary['agents'] = [];

  for (const entry of entries) {
    if (!entry || typeof entry.pane_id !== 'string') continue;
    const status = normalizeStatus(entry.agent_status);
    counts[status] += 1;
    ranked.push({
      paneId: entry.pane_id,
      workspaceId: typeof entry.workspace_id === 'string' ? entry.workspace_id : null,
      agent: cleanText(entry.display_agent || entry.agent, 24),
      title: cleanText(entry.terminal_title_stripped || entry.terminal_title),
      status,
      focused: entry.focused === true,
    });
  }

  ranked.sort(
    (left, right) => AGENT_STATUSES.indexOf(left.status) - AGENT_STATUSES.indexOf(right.status),
  );

  return {
    focusedPaneId,
    focusedAgent,
    counts,
    // Total rather than a sum the browser has to compute, and the one number a
    // collapsed chip can show on its own.
    total: ranked.length,
    agents: ranked.slice(0, MAX_LISTED_AGENTS),
  };
}

/** Whether two summaries say the same thing, so an unchanged one is not sent. */
function sameSummary(
  left: AgentSummary | null | undefined,
  right: AgentSummary | null | undefined,
): boolean {
  if (!left || !right) return left === right;
  if (left.focusedPaneId !== right.focusedPaneId || left.focusedAgent !== right.focusedAgent)
    return false;
  if (left.total !== right.total) return false;
  for (const status of AGENT_STATUSES) {
    if ((left.counts?.[status] || 0) !== (right.counts?.[status] || 0)) return false;
  }
  if (left.agents.length !== right.agents.length) return false;
  return left.agents.every((agent, index) => {
    const other = right.agents[index];
    return (
      other &&
      agent.paneId === other.paneId &&
      agent.status === other.status &&
      agent.agent === other.agent &&
      agent.title === other.title
    );
  });
}

/** The summary of a workstation with nothing to report, or nothing to ask. */
function emptySummary(): AgentSummary {
  return { focusedPaneId: null, focusedAgent: null, counts: emptyCounts(), total: 0, agents: [] };
}

export { AGENT_STATUSES, MAX_LISTED_AGENTS, emptySummary, sameSummary, summarizeAgents };
