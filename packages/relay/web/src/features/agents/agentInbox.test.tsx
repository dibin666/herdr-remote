import type React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent, within } from '@testing-library/react';
import { TerminalProvider, useTerminal } from '@/context/TerminalContext';
import { AgentInbox } from './AgentInbox';
import { saveSettings } from '@/features/settings/storage';

/**
 * The inbox is where "1 blocked" becomes "*which* agent". Pinned here: the
 * list is closed until asked, rows carry their status and title, and blocked
 * agents sit above the rest.
 */

const Probe: React.FC<{ onReady: (ctx: ReturnType<typeof useTerminal>) => void }> = ({
  onReady,
}) => {
  onReady(useTerminal());
  return null;
};

function mount(props: { compact?: boolean } = {}) {
  let ctx: ReturnType<typeof useTerminal> | undefined;
  render(
    <TerminalProvider>
      <Probe
        onReady={(value) => {
          ctx = value;
        }}
      />
      <AgentInbox {...props} />
    </TerminalProvider>,
  );
  return {
    ctx: () => {
      if (!ctx) throw new Error('TerminalContext never mounted');
      return ctx;
    },
    push: (message: Record<string, unknown>) => {
      act(() => {
        // @ts-expect-error test mock
        ctx?.adapter?.emit('agentStatus', { type: 'agent_status', ...message });
      });
    },
  };
}

const AGENTS = [
  { paneId: 'p3', workspaceId: 'qobuz', agent: 'pi', title: 'cleanup', status: 'idle' },
  {
    paneId: 'p1',
    workspaceId: 'demo',
    agent: 'claude',
    title: 'In src/routes…',
    status: 'blocked',
  },
  { paneId: 'p2', workspaceId: 'web', agent: 'pi', title: 'tests', status: 'working' },
];

describe('agent inbox', () => {
  beforeEach(() => {
    localStorage.clear();
    saveSettings({ language: 'en' });
  });

  it('stays closed until the chip is pressed', () => {
    const inbox = mount();
    inbox.push({ counts: { blocked: 1, working: 1, idle: 1 }, total: 3, agents: AGENTS });

    expect(screen.getByTestId('agent-inbox-trigger')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-inbox-list')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('agent-inbox-trigger'));
    expect(screen.getByTestId('agent-inbox-list')).toBeInTheDocument();
  });

  it('lists every agent with its status and title', () => {
    const inbox = mount();
    inbox.push({ counts: { blocked: 1, working: 1, idle: 1 }, total: 3, agents: AGENTS });
    fireEvent.click(screen.getByTestId('agent-inbox-trigger'));

    const rows = screen.getAllByTestId('agent-inbox-row');
    expect(rows).toHaveLength(3);
    // The host sorts by urgency; the blocked row comes first and is marked.
    expect(rows[0]).toHaveTextContent('demo · claude');
    expect(rows[0]).toHaveTextContent('blocked');
    expect(rows[0]).toHaveTextContent('In src/routes…');
    expect(rows[0].className).toContain('border-tui-warn');
    expect(rows[1]).toHaveTextContent('web · pi');
    expect(rows[2]).toHaveTextContent('qobuz · pi');
    expect(screen.getByTestId('agent-inbox-list')).toHaveTextContent('1 waiting');
  });

  it('closes on Escape and on the scrim', () => {
    const inbox = mount();
    inbox.push({ counts: { blocked: 1 }, total: 1, agents: [AGENTS[1]] });
    fireEvent.click(screen.getByTestId('agent-inbox-trigger'));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('agent-inbox-list')).not.toBeInTheDocument();
  });
});

describe('agent inbox actions', () => {
  const blockedAgent = AGENTS[1];

  it('sends the canned actions for a blocked agent, and a jump for any other', () => {
    const inbox = mount();
    const sendPaneAction = vi.spyOn(inbox.ctx().adapter!, 'sendPaneAction');
    act(() => {
      // @ts-expect-error test mock
      inbox.ctx().adapter.emit('controlGranted');
    });
    inbox.push({ counts: { blocked: 1, working: 1, idle: 1 }, total: 3, agents: AGENTS });
    fireEvent.click(screen.getByTestId('agent-inbox-trigger'));

    const rows = screen.getAllByTestId('agent-inbox-row');
    // Blocked: approve, reject, interrupt and jump; the rest only jump.
    expect(rows[0].querySelectorAll('button')).toHaveLength(4);
    expect(rows[1].querySelectorAll('button')).toHaveLength(1);
    expect(rows[2].querySelectorAll('button')).toHaveLength(1);

    fireEvent.click(within(rows[0]).getByTestId('agent-action-approve'));
    expect(sendPaneAction).toHaveBeenCalledWith('p1', 'approve');

    // Jump focuses the pane and closes the list.
    fireEvent.click(within(rows[1]).getByTestId('agent-action-focus'));
    expect(sendPaneAction).toHaveBeenCalledWith('p2', 'focus');
    expect(screen.queryByTestId('agent-inbox-list')).not.toBeInTheDocument();
  });

  it('keeps the list read-only for a viewer', () => {
    const inbox = mount();
    // Sessions open as viewer until the lease is granted; granted then the
    // role is pulled back, the buttons disappear again.
    act(() => {
      // @ts-expect-error test mock
      inbox.ctx().adapter.emit('controlGranted');
      // @ts-expect-error test mock
      inbox.ctx().adapter.emit('roleChange', 'viewer');
    });
    inbox.push({ counts: { blocked: 1 }, total: 1, agents: [blockedAgent] });
    fireEvent.click(screen.getByTestId('agent-inbox-trigger'));
    expect(screen.getAllByTestId('agent-inbox-row')[0].querySelectorAll('button')).toHaveLength(0);
  });

  it('keeps the list read-only when the host cannot act on panes', () => {
    const inbox = mount();
    act(() => {
      const adapter = inbox.ctx().adapter;
      // sessionRestarted, with paneActionsSupported = false like an old host.
      // @ts-expect-error test mock
      adapter.emit(
        'sessionRestarted',
        0,
        0,
        null,
        '',
        '',
        'posix',
        false,
        null,
        [],
        false,
        false,
        false,
      );
    });
    inbox.push({ counts: { blocked: 1 }, total: 1, agents: [blockedAgent] });
    fireEvent.click(screen.getByTestId('agent-inbox-trigger'));
    expect(screen.getAllByTestId('agent-inbox-row')[0].querySelectorAll('button')).toHaveLength(0);
  });

  it('offers no buttons for a row the host reported without a pane id', () => {
    const inbox = mount();
    act(() => {
      // @ts-expect-error test mock
      inbox.ctx().adapter.emit('controlGranted');
    });
    inbox.push({
      counts: { blocked: 1 },
      total: 1,
      agents: [{ ...blockedAgent, paneId: null }],
    });
    fireEvent.click(screen.getByTestId('agent-inbox-trigger'));
    expect(screen.getAllByTestId('agent-inbox-row')[0].querySelectorAll('button')).toHaveLength(0);
  });
});
