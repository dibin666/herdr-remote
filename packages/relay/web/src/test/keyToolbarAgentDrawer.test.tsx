import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { KeyToolbar } from '../components/KeyToolbar';
import { TerminalView } from '../components/TerminalView';
import { TerminalProvider, useTerminal } from '../context/TerminalContext';
import { saveSettings } from '../utils/storage';
import type { MockTerminalInstance, MockWebSocket } from './setup';

const xtermInstances = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] })
  .__xtermInstances;
const webSocketInstances = (globalThis as unknown as { __webSocketInstances: MockWebSocket[] })
  .__webSocketInstances;

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
      <ContextProbe
        onValue={(value) => {
          context = value;
        }}
      />
      <TerminalView isActive={true} />
      <KeyToolbar />
    </TerminalProvider>,
  );
  await waitFor(() => expect(webSocketInstances.length).toBe(1));
  act(() => {
    webSocketInstances[0].simulateOpen();
    webSocketInstances[0].simulateMessage(
      JSON.stringify({
        type: 'ready',
        role,
        controllerId: role === 'controller' ? 'me' : 'other',
        hostId: 'host-1',
        clientId: 'me',
      }),
    );
  });
  return () => context!;
}

function reportFocus(agent: string) {
  act(() =>
    webSocketInstances[0].simulateMessage(
      JSON.stringify({
        type: 'agent_status',
        focusedPaneId: 'w1:p1',
        focusedAgent: agent,
        counts: {},
        total: 0,
        agents: [],
      }),
    ),
  );
}

describe('Agent-aware key toolbar', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    xtermInstances.length = 0;
    webSocketInstances.length = 0;
  });

  it('shows focus-aware shortcuts inline in the bottom key row', async () => {
    await mount();
    reportFocus('claude');

    const strip = screen.getByTestId('key-toolbar-scroll');
    expect(screen.getByTestId('key-toolbar-row').className).toContain('flex-nowrap');
    expect(strip.className).toContain('overflow-x-auto');
    expect(screen.getByTestId('agent-key-actions').parentElement).toBe(strip);
    expect(screen.getByTestId('agent-key-mode')).toBeInTheDocument();
    expect(screen.getByTestId('agent-key-rewind')).toBeInTheDocument();
    expect(screen.getByTestId('agent-key-genericCtrlC')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-key-drawer')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Keymap' })).not.toBeInTheDocument();
  });

  it('keeps only a few common shortcuts on the bar by default', async () => {
    await mount();
    reportFocus('claude');

    const ids = Array.from(
      screen.getByTestId('agent-key-actions').querySelectorAll('[data-testid^="agent-key-"]'),
    ).map((node) => node.getAttribute('data-testid'));
    expect(ids).toEqual([
      'agent-key-mode',
      'agent-key-rewind',
      'agent-key-details',
      'agent-key-model',
      'agent-key-genericCtrlC',
    ]);

    reportFocus('shell');
    expect(screen.getByTestId('agent-key-genericCtrlD')).toBeInTheDocument();
    expect(screen.getByTestId('agent-key-genericCtrlL')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-key-genericCtrlK')).not.toBeInTheDocument();
  });

  it('shows a less common shortcut once the user ticks it in settings', async () => {
    saveSettings({ agentKeymaps: { claude: { actions: { background: { hidden: false } } } } });
    await mount();
    reportFocus('claude');

    expect(screen.getByTestId('agent-key-background')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-key-stash')).not.toBeInTheDocument();
  });

  it('automatically switches shortcuts with focus and falls back to Shell', async () => {
    sessionStorage.setItem('herdr_remote_agent_profile_pin_v1', 'codex');
    const getContext = await mount();
    expect(getContext().agentProfile).toBe('shell');

    reportFocus('claude');
    expect(getContext().agentProfile).toBe('claude');
    expect(screen.getByTestId('agent-key-rewind')).toBeInTheDocument();

    reportFocus('pi');
    expect(getContext().agentProfile).toBe('pi');
    expect(screen.getByTestId('agent-key-tools')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-key-rewind')).not.toBeInTheDocument();

    reportFocus('shell');
    expect(getContext().agentProfile).toBe('shell');
    expect(screen.getByTestId('agent-key-genericCtrlC')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-key-tools')).not.toBeInTheDocument();
  });

  it('retains red interrupt and amber suspend tones inline', async () => {
    const getContext = await mount();
    reportFocus('claude');

    expect(screen.getByTestId('agent-key-genericCtrlC').className).toContain('border-tui-bad');
    act(() => {
      getContext().updateSettings({
        agentKeymaps: { claude: { actions: { genericCtrlZ: { hidden: false } } } },
      });
    });
    expect(screen.getByTestId('agent-key-genericCtrlZ').className).toContain('border-tui-warn');
  });

  it('sends Esc Esc as two separate adapter input calls', async () => {
    const getContext = await mount();
    reportFocus('claude');
    const sendInput = vi.spyOn(getContext().adapter!, 'sendInput');

    fireEvent.click(screen.getByTestId('agent-key-rewind'));
    await waitFor(() => expect(sendInput).toHaveBeenCalledTimes(2));
    expect(
      sendInput.mock.calls.map(([bytes]) => new TextDecoder().decode(bytes as Uint8Array)),
    ).toEqual(['\x1b', '\x1b']);
  });

  it('shows the read-only warning when a viewer taps an inline agent shortcut', async () => {
    const getContext = await mount('viewer');
    reportFocus('claude');
    const sendInput = vi.spyOn(getContext().adapter!, 'sendInput');

    fireEvent.click(screen.getByTestId('agent-key-mode'));
    await waitFor(() =>
      expect(getContext().toasts.some((toast) => /viewer mode/i.test(toast.message))).toBe(true),
    );
    expect(sendInput).not.toHaveBeenCalled();
  });
});
