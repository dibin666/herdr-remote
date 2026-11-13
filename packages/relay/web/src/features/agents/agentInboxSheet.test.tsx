import type React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, within } from '@testing-library/react';
import { TerminalProvider, useTerminal } from '@/context/TerminalContext';
import { AgentInbox } from './AgentInbox';

/**
 * On the phone shell the inbox is a bottom sheet, and a bottom sheet lets go
 * the way a thumb expects: grabbed by its handle and pulled down, or Escape
 * for a hardware keyboard. Pinned here so the sheet does not regress into a
 * list that can only be closed from its own trigger.
 */

const Probe: React.FC<{ onReady: (ctx: ReturnType<typeof useTerminal>) => void }> = ({
  onReady,
}) => {
  onReady(useTerminal());
  return null;
};

const originalMatchMedia = window.matchMedia;
const originalWidth = window.innerWidth;
const originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');

function mount(focusedPaneId?: string): ReturnType<typeof useTerminal> | undefined {
  let ctx: ReturnType<typeof useTerminal> | undefined;
  render(
    <TerminalProvider>
      <Probe
        onReady={(value) => {
          ctx = value;
        }}
      />
      <AgentInbox compact />
    </TerminalProvider>,
  );
  act(() => {
    // @ts-expect-error test mock
    ctx?.adapter?.emit('agentStatus', {
      type: 'agent_status',
      focusedPaneId,
      counts: { blocked: 1 },
      total: 1,
      agents: [
        {
          paneId: 'p1',
          workspaceId: 'demo',
          agent: 'claude',
          status: 'blocked',
          title: 'In src/routes…',
          focused: false,
        },
      ],
    });
  });
  return ctx;
}

const touchEvent = (target: Element, type: string, y: number) =>
  fireEvent(
    target,
    Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      touches: [{ clientY: y }],
    }),
  );

describe('agent inbox phone sheet', () => {
  beforeEach(() => {
    localStorage.clear();
    // jsdom reports innerWidth but no visualViewport and a fine pointer;
    // the phone shell asks for a narrow viewport, so width alone decides.
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    Object.defineProperty(window, 'visualViewport', {
      value: undefined,
      writable: true,
      configurable: true,
    });
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true });
    Object.defineProperty(window, 'visualViewport', originalVisualViewport ?? { value: undefined });
    vi.restoreAllMocks();
  });

  it('highlights the displayed agent and keeps Jump at the right edge on phones', () => {
    const ctx = mount('p1');
    act(() => {
      // @ts-expect-error test mock
      ctx?.adapter?.emit('controlGranted');
    });
    fireEvent.click(screen.getByTestId('agent-inbox-trigger'));

    const sheet = screen.getByTestId('agent-inbox-sheet');
    const row = within(sheet).getByTestId('agent-inbox-row');
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(row.className).toContain('bg-tui-accent/10');
    expect(row.lastElementChild).toBe(within(row).getByTestId('agent-action-focus'));
  });

  it('opens as a sheet and closes on Escape like the session sheet', () => {
    mount();
    fireEvent.click(screen.getByTestId('agent-inbox-trigger'));
    expect(screen.getByTestId('agent-inbox-sheet')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('agent-inbox-sheet')).not.toBeInTheDocument();
  });

  it('lets go when its handle is pulled down', () => {
    mount();
    fireEvent.click(screen.getByTestId('agent-inbox-trigger'));
    const handle = screen.getByTestId('agent-inbox-handle');

    // A short pull snaps back; a long one lets the sheet go.
    touchEvent(handle, 'touchstart', 700);
    touchEvent(handle, 'touchmove', 730);
    touchEvent(handle, 'touchend', 730);
    expect(screen.getByTestId('agent-inbox-sheet')).toBeInTheDocument();

    touchEvent(handle, 'touchstart', 700);
    touchEvent(handle, 'touchmove', 800);
    touchEvent(handle, 'touchend', 800);
    expect(screen.queryByTestId('agent-inbox-sheet')).not.toBeInTheDocument();
  });

  it('closes on the scrim', () => {
    mount();
    fireEvent.click(screen.getByTestId('agent-inbox-trigger'));
    fireEvent.click(screen.getByTestId('agent-inbox-scrim'));
    expect(screen.queryByTestId('agent-inbox-sheet')).not.toBeInTheDocument();
  });
});
