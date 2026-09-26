import type React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { TerminalProvider, useTerminal } from '@/context/TerminalContext';
import { AgentStatusChip } from './AgentStatusChip';
import { saveSettings } from '@/features/settings/storage';

/**
 * "Does anything need me?" answered in a status bar.
 *
 * The three things worth pinning: silence before the workstation has reported
 * (an absent chip is honest, a zero is not), the compact form a phone's bar can
 * fit, and no toast — a notification per state change is the flood this exists
 * to replace.
 */

const Probe: React.FC<{ onReady: (ctx: ReturnType<typeof useTerminal>) => void }> = ({
  onReady,
}) => {
  onReady(useTerminal());
  return null;
};

function mountChip(props: { compact?: boolean } = {}) {
  let ctx: ReturnType<typeof useTerminal> | undefined;
  render(
    <TerminalProvider>
      <Probe
        onReady={(value) => {
          ctx = value;
        }}
      />
      <AgentStatusChip {...props} />
    </TerminalProvider>,
  );
  return {
    push: (message: Record<string, unknown>) => {
      act(() => {
        // @ts-expect-error test mock
        ctx?.adapter?.emit('agentStatus', { type: 'agent_status', ...message });
      });
    },
    drop: () => {
      act(() => {
        // @ts-expect-error test mock
        ctx?.adapter?.emit('stateChange', 'reconnecting', undefined, undefined);
      });
    },
    get toasts() {
      return ctx?.toasts ?? [];
    },
  };
}

describe('Agent status chip', () => {
  beforeEach(() => {
    localStorage.clear();
    saveSettings({ language: 'en' });
  });

  it('says nothing until the workstation has reported', () => {
    mountChip();

    expect(screen.queryByTestId('agent-status-chip')).not.toBeInTheDocument();
  });

  it('reports what wants attention, and leaves idle agents out of it', () => {
    const chip = mountChip();

    chip.push({ counts: { blocked: 1, working: 2, idle: 5 }, total: 8, agents: [] });

    const rendered = screen.getByTestId('agent-status-chip');
    expect(rendered).toHaveTextContent('1');
    expect(rendered).toHaveTextContent('blocked');
    expect(rendered).toHaveTextContent('2');
    expect(rendered).toHaveTextContent('working');
    expect(rendered).not.toHaveTextContent('idle');
  });

  it('keeps only the most urgent status where a phone bar has no room', () => {
    const chip = mountChip({ compact: true });

    chip.push({ counts: { blocked: 1, done: 2, working: 3 }, total: 6, agents: [] });

    const rendered = screen.getByTestId('agent-status-chip');
    expect(rendered).toHaveTextContent('blocked');
    expect(rendered).not.toHaveTextContent('working');
    expect(rendered).not.toHaveTextContent('done');
  });

  it('says agents are idle rather than going blank when nothing wants anything', () => {
    const chip = mountChip();

    chip.push({ counts: { idle: 3 }, total: 3, agents: [] });

    expect(screen.getByTestId('agent-status-chip')).toHaveTextContent('agents idle');
  });

  it('shows nothing at all on a workstation running no agents', () => {
    const chip = mountChip();

    chip.push({ counts: {}, total: 0, agents: [] });

    expect(screen.queryByTestId('agent-status-chip')).not.toBeInTheDocument();
  });

  it('never raises a toast, however often the status changes', () => {
    const chip = mountChip();

    chip.push({ counts: { working: 1 }, total: 1, agents: [] });
    chip.push({ counts: { blocked: 1 }, total: 1, agents: [] });
    chip.push({ counts: { done: 1 }, total: 1, agents: [] });

    expect(chip.toasts).toHaveLength(0);
  });

  it('drops a count that belongs to a workstation this window has lost', async () => {
    const chip = mountChip();
    chip.push({ counts: { blocked: 1 }, total: 1, agents: [] });
    expect(screen.getByTestId('agent-status-chip')).toBeInTheDocument();

    chip.drop();

    await waitFor(() => expect(screen.queryByTestId('agent-status-chip')).not.toBeInTheDocument());
  });
});
