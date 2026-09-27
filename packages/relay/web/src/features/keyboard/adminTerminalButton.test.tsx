import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { KeyToolbar } from './KeyToolbar';
import { TerminalProvider } from '@/context/TerminalContext';
import { saveSettings } from '@/features/settings/storage';
import { TerminalView } from '@/features/terminal/TerminalView';
import type { MockTerminalInstance, MockWebSocket } from '@/test/setup';

const xtermInstances = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] })
  .__xtermInstances;
const webSocketInstances = (globalThis as unknown as { __webSocketInstances: MockWebSocket[] })
  .__webSocketInstances;

async function mount(ready: Record<string, unknown>) {
  saveSettings({ language: 'en', toolbarVisible: true });
  render(
    <TerminalProvider>
      <TerminalView isActive={true} />
      <KeyToolbar />
    </TerminalProvider>,
  );
  await waitFor(() => expect(webSocketInstances.length).toBe(1));
  act(() => {
    webSocketInstances[0].simulateOpen();
    webSocketInstances[0].simulateMessage(
      JSON.stringify({ type: 'ready', role: 'controller', hostId: 'host-1', ...ready }),
    );
  });
  return webSocketInstances[0];
}

const sentTypes = (socket: MockWebSocket) =>
  socket.sent
    .filter((data): data is string => typeof data === 'string')
    .map((data) => JSON.parse(data).type);

describe('Admin terminal button', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    xtermInstances.length = 0;
    webSocketInstances.length = 0;
  });

  it('asks the Windows host for an admin tab instead of opening a browser window', async () => {
    const opened: unknown[] = [];
    window.open = (...args: unknown[]) => {
      opened.push(args);
      return null;
    };
    const socket = await mount({ platform: 'win32', adminTerminalSupported: true });

    fireEvent.click(screen.getByTestId('new-admin-terminal'));

    expect(sentTypes(socket)).toContain('admin_tab_open');
    expect(opened).toEqual([]);
  });

  it('is disabled when the relay or host cannot open one', async () => {
    const socket = await mount({ platform: 'win32', adminTerminalSupported: false });
    const button = screen.getByTestId('new-admin-terminal');

    expect(button).toHaveProperty('disabled', true);
    fireEvent.click(button);
    expect(sentTypes(socket)).not.toContain('admin_tab_open');
  });

  it('is absent on other platforms', async () => {
    await mount({ platform: 'linux', adminTerminalSupported: false });
    expect(screen.queryByTestId('new-admin-terminal')).toBeNull();
  });
});
