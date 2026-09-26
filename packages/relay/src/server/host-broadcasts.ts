// Facts about a workstation that every window on it shows: its agents, its
// update status and its terminal font. Each is checked on the way through and
// kept on the host record, so a window that joins later gets the latest one.

import type {
  AgentStatusEntry,
  HostAgentStatusMessage,
  HostTerminalFontMessage,
  HostUpdateStatusMessage,
  ServerAgentStatusMessage,
  ServerUpdateStatusMessage,
} from '../protocol/messages.js';
import { sanitizeTerminalFont } from '../protocol/terminal.js';
import { text } from './sockets.js';
import { broadcastToClients } from './transport.js';
import type { RelayContext, RelayHost } from './types.js';

/** A message as the host sent it: the right keys, but values not yet checked. */
type Unchecked<T> = { [K in keyof T]?: unknown };

/** A release version as npm writes it; anything else is not forwarded. */
const RELEASE_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/;

/** Matches the host's own cap; the relay re-applies it rather than trusting it. */
const MAX_AGENT_STATUS_ENTRIES = 16;

/**
 * Pass on what the workstation's agents are doing.
 *
 * Sanitised rather than forwarded: the host is trusted, but this is the one
 * message whose contents come from terminal titles, and it lands in a status
 * bar on every attached window. The counts are numbers and the list is
 * bounded, so a workstation cannot grow a browser's memory by naming things
 * carefully.
 */
export function broadcastAgentStatus(
  relay: RelayContext,
  host: RelayHost,
  message: Unchecked<HostAgentStatusMessage>,
): void {
  const counts: Record<string, number> = {};
  if (message.counts && typeof message.counts === 'object') {
    for (const [status, value] of Object.entries(message.counts)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        counts[status.slice(0, 32)] = Math.max(0, Math.min(9999, Math.trunc(value)));
      }
    }
  }
  const agents: AgentStatusEntry[] = (Array.isArray(message.agents) ? message.agents : [])
    .slice(0, MAX_AGENT_STATUS_ENTRIES)
    .map((agent) => ({
      paneId: text(agent?.paneId, 64),
      workspaceId: text(agent?.workspaceId, 64),
      agent: text(agent?.agent, 32),
      title: text(agent?.title, 64),
      status: text(agent?.status, 16),
      focused: agent?.focused === true,
    }));
  const payload: ServerAgentStatusMessage = {
    type: 'agent_status',
    focusedPaneId: text(message.focusedPaneId, 64),
    focusedAgent: text(message.focusedAgent, 32),
    counts,
    total:
      typeof message.total === 'number' && Number.isFinite(message.total)
        ? Math.max(0, Math.trunc(message.total))
        : agents.length,
    agents,
  };
  host.agentStatus = payload;
  broadcastToClients(relay, host, () => payload);
}

/**
 * Whether the workstation runs the newest herdr-remote, for every window on
 * it. Only version strings and two flags pass: this ends up as text in the
 * browser, and the host is not the relay's to trust.
 */
export function broadcastUpdateStatus(
  relay: RelayContext,
  host: RelayHost,
  message: Unchecked<HostUpdateStatusMessage>,
): void {
  const version = (value: unknown) =>
    typeof value === 'string' && RELEASE_VERSION.test(value) ? value : null;
  const current = version(message.current);
  const latest = version(message.latest);
  if (!current || !latest) return;
  const payload: ServerUpdateStatusMessage = {
    type: 'update_status',
    current,
    installed: version(message.installed) || current,
    latest,
    updateAvailable: message.updateAvailable === true,
    restartPending: message.restartPending === true,
  };
  host.updateStatus = payload;
  broadcastToClients(relay, host, () => payload);
}

/** The workstation re-read its terminal font; every window draws with it. */
export function broadcastTerminalFont(
  relay: RelayContext,
  host: RelayHost,
  message: Unchecked<HostTerminalFontMessage>,
): void {
  host.terminalFont = sanitizeTerminalFont(message.terminalFont);
  const payload = { type: 'terminal_font', terminalFont: host.terminalFont || null };
  broadcastToClients(relay, host, () => payload);
}
