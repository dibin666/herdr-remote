// The agent inbox: which of the workstation's agents is waiting on a person,
// listed so the blocked ones surface first — and, when the host can act,
// acted on from here.
//
// The status bar chip is its handle. On a phone the list is a bottom sheet
// the thumb reaches; on a desktop it is a popover above the chip. Rows carry
// the canned actions of `pane_action`: jump focuses the pane in Herdr, and
// approve / reject / interrupt focus it and press the key it is waiting on.

import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import type { AgentStatusEntry, ServerAgentStatusMessage } from '@protocol/messages';
import { useConnection, useSettings } from '@/context/TerminalContext';
import { useMobileShell } from '@/features/mobile/mobileShell';
import { cn } from '@/shared/lib/cn';
import { GLYPH, type StatusLevel, TONE } from '@/shared/ui';
import type { TranslationKey } from '@/shared/i18n';
import { AgentStatusChip, agentStatusHasContent } from './AgentStatusChip';

const STATUS_TONE: Record<string, { level: StatusLevel; glyph: string; key: TranslationKey }> = {
  blocked: { level: 'warn', glyph: GLYPH.cross, key: 'agents.blocked' },
  done: { level: 'ok', glyph: GLYPH.check, key: 'agents.done' },
  working: { level: 'accent', glyph: '◐', key: 'agents.working' },
  idle: { level: 'idle', glyph: GLYPH.off, key: 'agents.idle' },
  unknown: { level: 'idle', glyph: '?', key: 'agents.unknown' },
};

type PaneAction = 'focus' | 'approve' | 'reject' | 'interrupt';

const actionClass =
  'tui-focusable select-none border border-tui-border bg-tui-mantle px-1.5 py-0.5 text-tui-sm transition-colors hover:border-tui-accent hover:text-tui-accent active:bg-tui-selection';

function ActionButton({
  action,
  label,
  hint,
  onAction,
}: {
  action: PaneAction;
  label: string;
  hint: string;
  onAction: (action: PaneAction) => void;
}) {
  return (
    <button
      type="button"
      data-testid={`agent-action-${action}`}
      onClick={() => onAction(action)}
      className={actionClass}
      title={hint}
      aria-label={hint}
    >
      {label}
    </button>
  );
}

function AgentRow({
  agent,
  actionable,
  onAction,
  t,
}: {
  agent: AgentStatusEntry;
  actionable: boolean;
  onAction: (paneId: string, action: PaneAction) => void;
  t: (k: TranslationKey) => string;
}) {
  const tone = STATUS_TONE[agent.status ?? 'unknown'] ?? STATUS_TONE.unknown;
  const blocked = agent.status === 'blocked';
  return (
    <div
      data-testid="agent-inbox-row"
      className={cn('border border-tui-border px-2 py-1.5 text-tui', blocked && 'border-tui-warn')}
    >
      <div className="flex items-center gap-1.5">
        <span aria-hidden="true" className={cn('shrink-0', TONE[tone.level].text)}>
          {tone.glyph}
        </span>
        <span className={cn('shrink-0 text-tui-sm', TONE[tone.level].text)}>{t(tone.key)}</span>
        <span className="min-w-0 truncate text-tui-text">
          {[agent.workspaceId, agent.agent].filter(Boolean).join(' · ') || t('agents.unnamed')}
        </span>
        {agent.focused ? (
          <span aria-hidden="true" className="ml-auto shrink-0 text-tui-sm text-tui-accent">
            {GLYPH.cursor}
          </span>
        ) : null}
      </div>
      {agent.title ? (
        <div className="truncate pl-4 text-tui-sm text-tui-muted" title={agent.title}>
          {agent.title}
        </div>
      ) : null}
      {actionable ? (
        <div className="mt-1 flex flex-wrap items-center gap-1 pl-4">
          {blocked ? (
            <>
              <ActionButton
                action="approve"
                label={`${t('agents.approve')} ⏎`}
                hint={t('agents.approveHint')}
                onAction={(action) => onAction(agent.paneId as string, action)}
              />
              <ActionButton
                action="reject"
                label={`${t('agents.reject')} Esc`}
                hint={t('agents.rejectHint')}
                onAction={(action) => onAction(agent.paneId as string, action)}
              />
              <ActionButton
                action="interrupt"
                label={`${t('agents.interrupt')} ^C`}
                hint={t('agents.interruptHint')}
                onAction={(action) => onAction(agent.paneId as string, action)}
              />
            </>
          ) : null}
          <ActionButton
            action="focus"
            label={`${t('agents.jumpTo')} ›`}
            hint={t('agents.jumpToHint')}
            onAction={(action) => onAction(agent.paneId as string, action)}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The rows, shared by the sheet and the popover. The host already sorts by
 * urgency, so the list only groups the waiting count for its heading.
 */
const URGENCY = ['blocked', 'done', 'working', 'idle', 'unknown'];

function AgentInboxList({
  status,
  actionable,
  onAction,
}: {
  status: ServerAgentStatusMessage;
  actionable: boolean;
  onAction: (paneId: string, action: PaneAction) => void;
}) {
  const { t } = useSettings();
  const blocked = status.counts?.blocked ?? 0;
  const done = status.counts?.done ?? 0;
  /* The host already sorts by urgency; sort again cheaply so an unsorted or
     older report cannot bury the agent that needs someone at the bottom. */
  const urgencyOf = (value: string | null) => {
    const index = URGENCY.indexOf(value ?? 'unknown');
    return index === -1 ? URGENCY.length : index;
  };
  const agents = [...status.agents].sort((a, b) => urgencyOf(a.status) - urgencyOf(b.status));
  return (
    <div data-testid="agent-inbox-list" className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 px-0.5">
        <span
          className={cn(
            'font-bold uppercase',
            blocked > 0 ? 'text-tui-warn' : done > 0 ? 'text-tui-ok' : 'text-tui-muted',
          )}
        >
          {t('agents.inboxPending', { count: blocked + done })}
        </span>
        <span className="text-tui-sm text-tui-faint">
          {t('agents.inboxTotal', { count: status.total })}
        </span>
      </div>
      {agents.length === 0 ? (
        <p className="px-0.5 py-1 text-tui-sm text-tui-muted">{t('agents.inboxEmpty')}</p>
      ) : (
        agents.map((agent) => (
          <AgentRow
            key={agent.paneId ?? agent.title}
            agent={agent}
            actionable={actionable && agent.paneId !== null}
            onAction={onAction}
            t={t}
          />
        ))
      )}
    </div>
  );
}

export const AgentInbox: React.FC<{ compact?: boolean; className?: string }> = ({
  compact = false,
  className,
}) => {
  const { t } = useSettings();
  const { agentStatus, adapter, isController, paneActionsSupported } = useConnection();
  // The canned actions need three things: a host new enough to run them, a
  // pane id from its own report, and this window holding input. Until then
  // the list stays read-only.
  const actionable = paneActionsSupported !== false && isController;
  const onAction = (paneId: string, action: PaneAction) => {
    adapter?.sendPaneAction(paneId, action);
    if (action === 'focus') setOpen(false);
  };
  const isMobileShell = useMobileShell();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open || isMobileShell) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, isMobileShell]);

  // Nothing to list until the workstation has reported — the chip hides then
  // too, so the affordance and the panel appear together.
  if (!agentStatusHasContent(agentStatus)) return null;

  const chip = <AgentStatusChip compact={compact} />;
  const blocked = agentStatus?.counts?.blocked ?? 0;

  return (
    <span ref={rootRef} className={cn('relative inline-flex min-w-0 items-center', className)}>
      <button
        type="button"
        data-testid="agent-inbox-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t('agents.title')}
        title={t('agents.title')}
        className={cn(
          'tui-focusable min-w-0 text-left',
          blocked > 0 && 'font-bold',
          open && 'text-tui-accent',
        )}
      >
        {chip}
      </button>

      {/* Phone: a bottom sheet; the chip sits in the status bar, so the list
          rises to meet the thumb. */}
      {open && isMobileShell && (
        <>
          <div
            data-testid="agent-inbox-scrim"
            className="fixed inset-0 z-40 bg-tui-crust/70"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('agents.title')}
            data-testid="agent-inbox-sheet"
            className="herdr-sheet fixed inset-x-0 bottom-0 z-50 max-h-[70%] overflow-y-auto border-t border-tui-border bg-tui-base px-3 pb-4 pt-2"
          >
            <div aria-hidden="true" className="mx-auto mb-2 h-1 w-9 bg-tui-border-bright" />
            <AgentInboxList status={agentStatus!} actionable={actionable} onAction={onAction} />
          </div>
        </>
      )}

      {/* Desktop: a popover above the status line, aligned to the chip. */}
      {open && !isMobileShell && (
        <div
          role="dialog"
          aria-label={t('agents.title')}
          data-testid="agent-inbox-panel"
          className="absolute bottom-full right-0 z-[100] mb-1 max-h-[60vh] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto border border-tui-border bg-tui-base p-2 shadow-lg"
        >
          <AgentInboxList status={agentStatus!} actionable={actionable} onAction={onAction} />
        </div>
      )}
    </span>
  );
};
