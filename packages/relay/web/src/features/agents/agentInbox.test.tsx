import type React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
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
