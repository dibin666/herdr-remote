import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { KeyToolbar } from '../components/KeyToolbar';
import { SettingsModal } from '../components/SettingsModal';
import { TerminalProvider, useTerminal } from '../context/TerminalContext';
import { TerminalView } from '../components/TerminalView';
import { LOCAL_STORAGE_KEY, loadSettings, saveSettings } from '../utils/storage';
import type { MockTerminalInstance, MockWebSocket } from './setup';

const xtermInstances = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] }).__xtermInstances;
const webSocketInstances = (globalThis as unknown as { __webSocketInstances: MockWebSocket[] }).__webSocketInstances;

const ContextProbe: React.FC<{ onValue: (value: ReturnType<typeof useTerminal>) => void }> = ({ onValue }) => {
  onValue(useTerminal());
  return null;
};

const SettingsAndToolbar: React.FC<{ onContext: (value: ReturnType<typeof useTerminal>) => void }> = ({ onContext }) => {
  const [settingsOpen, setSettingsOpen] = useState(true);
  return (
    <>
      <ContextProbe onValue={onContext} />
      <TerminalView isActive={true} />
      <KeyToolbar />
      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {!settingsOpen && <button type="button" onClick={() => setSettingsOpen(true)}>Open settings</button>}
    </>
  );
};

describe('Agent keymap settings', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    xtermInstances.length = 0;
    webSocketInstances.length = 0;
  });

  it('opens tab 3, validates shortcut edits, and stores a rebind globally', async () => {
    render(
      <TerminalProvider>
        <SettingsModal isOpen={true} onClose={() => {}} />
      </TerminalProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Agent Keys|智能体按键/i }));
    expect(screen.getByText(/Agent profile|智能体方案/i)).toBeInTheDocument();

    const profile = screen.getByRole('combobox', { name: /Agent profile|智能体方案/i });
    fireEvent.change(profile, { target: { value: 'claude' } });
    const details = screen.getByRole('textbox', { name: /Shortcut Details|快捷键 详情/i });
    fireEvent.change(details, { target: { value: 'ctrl+e' } });

    expect(screen.getByTestId('agent-setting-row-details')).toHaveTextContent('^E');
    expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '{}').agentKeymaps.claude.actions.details.keys)
      .toBe('ctrl+e');
    sessionStorage.clear();
    expect(loadSettings().agentKeymaps.claude.actions?.details?.keys).toBe('ctrl+e');

    fireEvent.change(details, { target: { value: 'ctrl+unknown' } });
    expect(details).toHaveAttribute('aria-invalid', 'true');
    expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '{}').agentKeymaps.claude.actions.details.keys)
      .toBe('ctrl+e');
    expect(screen.getAllByRole('alert').some((alert) => /does not support|不支持按键/i.test(alert.textContent || '')))
      .toBe(true);

    fireEvent.blur(details);
    expect(details).toHaveValue('ctrl+e');
  });

  it('shows typed combo errors in Chinese', () => {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ language: 'zh' }));
    render(
      <TerminalProvider>
        <SettingsModal isOpen={true} onClose={() => {}} />
      </TerminalProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /智能体按键/i }));
    fireEvent.change(screen.getByRole('combobox', { name: /智能体方案/i }), { target: { value: 'claude' } });
    fireEvent.change(screen.getByRole('textbox', { name: /快捷键 详情/i }), {
      target: { value: 'ctrl+unknown' },
    });

    expect(screen.getByRole('alert')).toHaveTextContent(/第 1 步不支持按键“unknown”/);
  });

  it('adds custom keys with a caption preview and can restore the profile defaults', async () => {
    render(
      <TerminalProvider>
        <SettingsModal isOpen={true} onClose={() => {}} />
      </TerminalProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Agent Keys|智能体按键/i }));
    fireEvent.change(screen.getByRole('combobox', { name: /Agent profile|智能体方案/i }), {
      target: { value: 'claude' },
    });
    fireEvent.change(screen.getByLabelText(/Function name|功能名称/i), { target: { value: 'Run tests' } });
    fireEvent.change(screen.getByLabelText(/Key combo|按键组合/i), { target: { value: 'alt+enter' } });
    fireEvent.click(screen.getByRole('button', { name: /Add custom key|添加自定义按键/i }));

    expect(await screen.findByText('Run tests')).toBeInTheDocument();
    expect(screen.getByText('Alt+⏎')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Restore this agent defaults|恢复此智能体默认设置/i }));
    await waitFor(() => expect(loadSettings().agentKeymaps.claude).toBeUndefined());
  });

  it('keeps the last valid drawer shortcut while an unfinished edit is open', async () => {
    saveSettings({ language: 'en', toolbarVisible: true });
    let context: ReturnType<typeof useTerminal> | undefined;
    render(
      <TerminalProvider>
        <SettingsAndToolbar onContext={(value) => { context = value; }} />
      </TerminalProvider>,
    );
    await waitFor(() => expect(webSocketInstances).toHaveLength(1));
    act(() => {
      webSocketInstances[0].simulateOpen();
      webSocketInstances[0].simulateMessage(JSON.stringify({
        type: 'ready', role: 'controller', controllerId: 'me', hostId: 'host-1', clientId: 'me',
      }));
      webSocketInstances[0].simulateMessage(JSON.stringify({
        type: 'agent_status', focusedPaneId: 'w1:p1', focusedAgent: 'claude',
        counts: {}, total: 0, agents: [],
      }));
    });
    const sendInput = vi.spyOn(context!.adapter!, 'sendInput');

    fireEvent.click(screen.getByRole('button', { name: /Agent Keys/i }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent profile' }), { target: { value: 'claude' } });
    const details = screen.getByRole('textbox', { name: 'Shortcut Details' });
    fireEvent.change(details, { target: { value: 'ctrl+e' } });
    fireEvent.change(details, { target: { value: 'ctrl+' } });

    expect(loadSettings().agentKeymaps.claude.actions?.details?.keys).toBe('ctrl+e');
    expect(details).toHaveValue('ctrl+');
    fireEvent.blur(details);
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    fireEvent.click(screen.getByRole('button', { name: /Agent Keys/i }));

    expect(screen.getByRole('textbox', { name: 'Shortcut Details' })).toHaveValue('ctrl+e');
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    fireEvent.click(screen.getByTestId('agent-key-drawer-toggle'));
    fireEvent.click(screen.getByTestId('agent-key-details'));
    await waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
    expect(new TextDecoder().decode(sendInput.mock.calls[0][0] as Uint8Array)).toBe('\x05');
  });
});
