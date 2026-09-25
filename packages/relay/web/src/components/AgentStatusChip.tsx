import type React from 'react';
import { useTerminal } from '../context/TerminalContext';
import { cn } from '../utils/cn';
import { StatusDot } from './tui';
import type { ServerAgentStatusMessage } from '../types/protocol';

/**
 * Whether anything on the workstation needs a person, in one line.
 *
 * The question a phone has that a terminal answers badly. Finding a blocked
 * agent in Herdr's own sidebar means driving a TUI through a viewport the width
 * of a hand; Herdr already classifies every pane, so the host reads that over
 * the socket API and this says it in the space of a status bar.
 *
 * Deliberately not a notification. The relay is plain HTTP on a LAN, where the
 * Notification API does not exist at all, and a badge that is simply *there*
 * beats an alert per state change — which is the flood this replaces. The
 * opt-in alerts in useAgentAlerts.ts fire on a change only, one per window.
 */

/** Only what a person would act on. Idle and unknown are the resting state. */
const REPORTED: ReadonlyArray<{
  status: 'blocked' | 'done' | 'working';
  level: 'warn' | 'ok' | 'accent';
}> = [
  { status: 'blocked', level: 'warn' },
  { status: 'done', level: 'ok' },
  { status: 'working', level: 'accent' },
];

/**
 * Whether the chip draws anything. The status line puts a separator between
 * the segments it is given, so it has to know before adding this one: an
 * element that renders nothing still earned a `·` either side of it.
 */
export function agentStatusHasContent(agentStatus: ServerAgentStatusMessage | null): boolean {
  if (!agentStatus) return false;
  return (
    agentStatus.total > 0 || REPORTED.some(({ status }) => (agentStatus.counts?.[status] ?? 0) > 0)
  );
}

export interface AgentStatusChipProps {
  className?: string;
  /**
   * Show only the most urgent status. A phone's status bar already carries the
   * host and the latency; three counts alongside them is what makes that row
   * wrap, and "1 blocked" is the part a person acts on anyway.
   */
  compact?: boolean;
}

export const AgentStatusChip: React.FC<AgentStatusChipProps> = ({ className, compact = false }) => {
  const { agentStatus, t } = useTerminal();

  // Null is "the workstation has not said", which is not the same as "nothing
  // is running" — so the chip is absent rather than reporting a zero.
  if (!agentStatus) return null;

  const present = REPORTED.map(({ status, level }) => ({
    status,
    level,
    count: agentStatus.counts?.[status] ?? 0,
  })).filter((part) => part.count > 0);
  // REPORTED is ordered by urgency, so the first survivor is the one to keep.
  const parts = compact ? present.slice(0, 1) : present;

  if (parts.length === 0) {
    if (agentStatus.total === 0) return null;
    return (
      <span
        data-testid="agent-status-chip"
        className={cn('flex shrink-0 items-center gap-1 px-1 text-tui-muted', className)}
        title={t('agents.title')}
      >
        <StatusDot level="idle" />
        <span className="text-tui-faint">{t('agents.allIdle')}</span>
      </span>
    );
  }

  return (
    <span
      data-testid="agent-status-chip"
      className={cn('flex shrink-0 items-center gap-2 px-1', className)}
      title={t('agents.title')}
    >
      {parts.map(({ status, level, count }) => (
        <span key={status} className="flex items-center gap-1 text-tui-muted">
          <StatusDot level={level} />
          <span className="text-tui-text">{count}</span>
          <span className="text-tui-faint">{t(`agents.${status}`)}</span>
        </span>
      ))}
    </span>
  );
};
