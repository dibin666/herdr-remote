import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { TerminalProvider, useTerminal } from '@/context/TerminalContext';
import { createConnectionProfile } from '@/features/pairing/connectionProfiles';
import { saveSettings } from '@/features/settings/storage';
import type { MockTerminalInstance, MockWebSocket } from '@/test/setup';
import { RESIZE_NOTIFY_DEBOUNCE_MS, TerminalView } from './TerminalView';

const xtermInstances = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] })
  .__xtermInstances;
const webSocketInstances = (globalThis as unknown as { __webSocketInstances: MockWebSocket[] })
  .__webSocketInstances;

let ctx: ReturnType<typeof useTerminal> | undefined;
const Capture: React.FC = () => {
  ctx = useTerminal();
  return null;
};

const settle = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

const office = createConnectionProfile({
  id: 'profile-office',
  wsUrl: '/ws/client',
  token: 'office-device-token-123456',
  hostId: 'host-office',
});
const home = createConnectionProfile({
  id: 'profile-home',
  wsUrl: '/ws/client',
  token: 'home-device-token-123456',
  hostId: 'host-home',
});

describe('Switching to an instance with another font size', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    xtermInstances.length = 0;
    webSocketInstances.length = 0;
    ctx = undefined;
  });

  it("starts the new session at the grid of the new instance's font", async () => {
    saveSettings({
      profiles: [office, home],
      activeProfileId: home.id,
      wsUrl: home.wsUrl,
      token: home.token,
    });
    saveSettings({ fontSize: 20, fontSizeFollowsHost: false });
    saveSettings({ activeProfileId: office.id, wsUrl: office.wsUrl, token: office.token });

    render(
      <TerminalProvider>
        <Capture />
        <TerminalView isActive={true} />
      </TerminalProvider>,
    );
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    await waitFor(() => expect(webSocketInstances.length).toBe(1));
    act(() => webSocketInstances[0].simulateOpen());
    await settle(RESIZE_NOTIFY_DEBOUNCE_MS + 100);

    // The renderer's cell follows the font, as a real one does.
    const term = xtermInstances[0];
    let fontSize = term.options.fontSize;
    Object.defineProperty(term.options, 'fontSize', {
      configurable: true,
      get: () => fontSize,
      set: (value) => {
        fontSize = value;
        term.cellSize = value === 20 ? { width: 12, height: 24 } : { width: 9, height: 18 };
      },
    });
    const officeCols = term.cols;
    const officeRows = term.rows;

    act(() => ctx?.switchProfile(home.id));
    const socket = webSocketInstances[webSocketInstances.length - 1];
    expect(socket).not.toBe(webSocketInstances[0]);
    act(() => socket.simulateOpen());

    // The session used to start at the old instance's grid, and was corrected
    // only after the resize debounce: Herdr painted a frame the wrong size first.
    const hello = JSON.parse(socket.sent[0] as string);
    expect(hello.type).toBe('hello');
    expect(hello.cols).toBeLessThan(officeCols);
    expect(hello.rows).toBeLessThan(officeRows);
    expect({ cols: hello.cols, rows: hello.rows }).toEqual({ cols: term.cols, rows: term.rows });
  });
});
