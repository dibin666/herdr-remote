// Machine-wide status the host broadcasts to every window watching it: what
// its agents are doing, and whether the workstation's herdr-remote is behind
// the newest release. Both are facts about the machine, not about one
// terminal — hence broadcast rather than scoped to a stream.
//
// Browser-safe: types only.

export type AgentStatus = 'blocked' | 'done' | 'working' | 'idle' | 'unknown';

export interface AgentStatusEntry {
  paneId: string | null;
  workspaceId: string | null;
  agent: string | null;
  title: string | null;
  status: string | null;
  focused: boolean;
}

/**
 * What the workstation's agents are doing.
 *
 * Broadcast to every window watching this workstation rather than scoped to a
 * stream: it is a fact about the machine, not about one terminal. The host
 * reads it from Herdr's socket API.
 */
export interface ServerAgentStatusMessage {
  type: 'agent_status';
  focusedPaneId?: string | null;
  focusedAgent?: string | null;
  counts: Partial<Record<AgentStatus, number>>;
  total: number;
  agents: AgentStatusEntry[];
}

/**
 * Whether the workstation's herdr-remote is behind the newest release. Checked
 * by the host when a window opens and kept by the relay for later windows.
 */
export interface ServerUpdateStatusMessage {
  type: 'update_status';
  /** The version the workstation is running. */
  current: string;
  /** The version on disk; ahead of `current` when an update awaits a restart. */
  installed: string;
  latest: string;
  updateAvailable: boolean;
  restartPending: boolean;
  /** The workstation has `herdr-remote update`, which installs and restarts in one step. */
  updateCommand: boolean;
}
