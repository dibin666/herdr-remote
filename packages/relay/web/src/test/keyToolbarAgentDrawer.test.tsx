import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { KeyToolbar } from '../components/KeyToolbar';
import { TerminalView } from '../components/TerminalView';
import {
  AGENT_PROFILE_PIN_SESSION_KEY,
  TerminalProvider,
  useTerminal,
} from '../context/TerminalContext';
import { LOCAL_STORAGE_KEY, saveSettings } from '../utils/storage';
import type { MockTerminalInstance, MockWebSocket } from './setup';

const xtermInstances = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] }).__xtermInstances;
const webSocketInstances = (globalThis as unknown as { __webSocketInstances: MockWebSocket[] }).__webSocketInstances;

type TerminalValue = ReturnType<typeof useTerminal>;
const ContextProbe: React.FC<{ onValue: (value: TerminalValue) => void }> = ({ onValue }) => {
  onValue(useTerminal());
  return null;
};

async function mount(role: 'controller' | 'viewer' = 'controller') {
  let context: TerminalValue | undefined;
  saveSettings({ language: 'en', toolbarVisible: true });
  render(
    <TerminalProvider>
      <ContextProbe onValue={(value) => { context = value; }} />
      <TerminalView isActive={true} />
      <KeyToolbar />
    </TerminalProvider>,
  );
  await waitFor(() => expect(webSocketInstances.length).toBe(1));
  act(() => {
    webSocketInstances[0].simulateOpen();
    webSocketInstances[0].simulateMessage(JSON.stringify({
      type: 'ready', role, controllerId: role === 'controller' ? 'me' : 'other',
      hostId: 'host-1', clientId: 'me',
    }));
  });
  return () => context!;
}

function reportFocus(agent: string) {
  act(() => webSocketInstances[0].simulateMessage(JSON.stringify({
    type: 'agent_status', focusedPaneId: 'w1:p1', focusedAgent: agent,
    counts: {}, total: 0, agents: [],
  })));
}

describe('Agent-aware key drawer', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    xtermInstances.length = 0;
    webSocketInstances.length = 0;
  });

  it('labels the drawer with the agent in the focused pane', async () => {
    await mount();
    reportFocus('claude');

    const toggle = screen.getByTestId('agent-key-drawer-toggle');
    expect(toggle).toHaveTextContent('Claude');
    expect(toggle).toHaveTextContent('▴');
    expect(toggle).not.toHaveTextContent('•');

    fireEvent.click(toggle);
    expect(screen.getByTestId('agent-key-drawer-title')).toHaveTextContent('Auto · Claude Code');
    expect(screen.getByTestId('agent-key-mode')).toHaveTextContent('⇧TAB');
    expect(toggle.className).toContain('h-9');
    expect(screen.getByRole('combobox', { name: 'Keymap' }).className).toContain('h-8');
    expect(screen.getByTestId('agent-key-mode').className).toContain('h-8');
  });

  it('keeps the pin visible and in this window when pane focus changes', async () => {
    await mount();
    reportFocus('claude');
    fireEvent.click(screen.getByTestId('agent-key-drawer-toggle'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Keymap' }), { target: { value: 'codex' } });
    reportFocus('pi');

    const toggle = screen.getByTestId('agent-key-drawer-toggle');
    expect(toggle).toHaveTextContent('Codex');
    expect(toggle).toHaveTextContent('•');
    expect(screen.getByTestId('agent-key-drawer-title')).toHaveTextContent('Pinned · Codex');
    expect(sessionStorage.getItem(AGENT_PROFILE_PIN_SESSION_KEY)).toBe('codex');
    expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '{}').agentProfilePin).toBeUndefined();
  });

  it('retains red interrupt and amber suspend tones in the general group', async () => {
    await mount();
    reportFocus('claude');
    fireEvent.click(screen.getByTestId('agent-key-drawer-toggle'));

    expect(screen.getByTestId('agent-key-genericCtrlC').className).toContain('border-tui-bad');
    expect(screen.getByTestId('agent-key-genericCtrlZ').className).toContain('border-tui-warn');
  });

  it('sends Esc Esc as two separate adapter input calls', async () => {
    const getContext = await mount();
    reportFocus('claude');
    fireEvent.click(screen.getByTestId('agent-key-drawer-toggle'));
    const sendInput = vi.spyOn(getContext().adapter!, 'sendInput');

    fireEvent.click(screen.getByTestId('agent-key-rewind'));
    await waitFor(() => expect(sendInput).toHaveBeenCalledTimes(2));
    expect(sendInput.mock.calls.map(([bytes]) => new TextDecoder().decode(bytes as Uint8Array)))
      .toEqual(['\x1b', '\x1b']);
  });

  it('shows the read-only warning when a viewer taps an agent shortcut', async () => {
    const getContext = await mount('viewer');
    reportFocus('claude');
    fireEvent.click(screen.getByTestId('agent-key-drawer-toggle'));
    const sendInput = vi.spyOn(getContext().adapter!, 'sendInput');

    fireEvent.click(screen.getByTestId('agent-key-mode'));
    await waitFor(() => expect(getContext().toasts.some((toast) => /viewer mode/i.test(toast.message))).toBe(true));
    expect(sendInput).not.toHaveBeenCalled();
  });
});
