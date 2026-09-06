import { describe, it, expect, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { TerminalProvider, useTerminal } from '../context/TerminalContext';
import { TerminalView } from '../components/TerminalView';
import type { MockTerminalInstance, MockWebSocket } from './setup';

const xtermInstances = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] })
  .__xtermInstances;
const webSocketInstances = (globalThis as unknown as { __webSocketInstances: MockWebSocket[] })
  .__webSocketInstances;

const emitTerminalData = (term: MockTerminalInstance, data: string) => {
  const onData = term.onData as unknown as { mock: { calls: Array<[(value: string) => void]> } };
  for (const [listener] of onData.mock.calls) listener(data);
};

/**
 * Read-only is a mode, not an event.
 *
 * Every refused keystroke used to raise its own toast, and each repeat restarted
 * the dismissal timer, so holding a key or pasting a line pinned a `×28` warning
 * on top of the terminal until the user stopped touching the keyboard. The
 * warning now speaks once per stretch of viewer role.
 */
describe('The read-only warning does not flood the screen', () => {
  let terminalCtx: ReturnType<typeof useTerminal> | undefined;

  const CaptureContext: React.FC = () => {
    terminalCtx = useTerminal();
    return null;
  };

  const renderTerminal = () => {
    terminalCtx = undefined;
    return render(
      <TerminalProvider>
        <CaptureContext />
        <TerminalView isActive={true} />
      </TerminalProvider>
    );
  };

  const openAsViewer = () =>
    act(() => {
      const socket = webSocketInstances[0];
      socket.simulateOpen();
      socket.simulateMessage(
        JSON.stringify({
          type: 'ready',
          role: 'viewer',
          controllerId: 'client-other',
          hostId: 'host-1',
          clientId: 'client-me',
        })
      );
    });

  const warnings = () => (terminalCtx?.toasts ?? []).filter((toast) => toast.type === 'warning');

  beforeEach(() => {
    localStorage.clear();
    xtermInstances.length = 0;
    webSocketInstances.length = 0;
    window.history.pushState({}, '', '/');
  });

  it('warns once for a burst of refused keystrokes and never counts up', async () => {
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    openAsViewer();

    const term = xtermInstances[0];
    act(() => {
      for (let i = 0; i < 30; i += 1) emitTerminalData(term, 'a');
    });

    await waitFor(() => expect(warnings()).toHaveLength(1));
    expect(warnings()[0].count).toBe(1);
  });

  it('shares one warning across the terminal, the key bar and sendKey', async () => {
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    openAsViewer();

    const term = xtermInstances[0];
    act(() => emitTerminalData(term, 'x'));
    await waitFor(() => expect(warnings()).toHaveLength(1));

    // A different entry point must not restate what the user was just told.
    act(() => terminalCtx?.sendKey('\r'));
    act(() => terminalCtx?.sendKey('\t'));
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].count).toBe(1);
  });

  it('speaks again the next time control is lost', async () => {
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    openAsViewer();

    act(() => terminalCtx?.sendKey('x'));
    await waitFor(() => expect(warnings()).toHaveLength(1));
    const firstId = warnings()[0].id;
    act(() => terminalCtx?.removeToast(firstId));
    expect(warnings()).toHaveLength(0);

    // Take control, then have the host hand it to another device.
    act(() => {
      webSocketInstances[0].simulateMessage(JSON.stringify({ type: 'control_granted' }));
    });
    await waitFor(() => expect(terminalCtx?.isController).toBe(true));
    act(() => {
      webSocketInstances[0].simulateMessage(
        JSON.stringify({ type: 'control_revoked', reason: 'taken over' })
      );
    });
    await waitFor(() => expect(terminalCtx?.isController).toBe(false));

    const revocationWarnings = warnings().length;
    act(() => terminalCtx?.sendKey('x'));
    await waitFor(() => expect(warnings()).toHaveLength(revocationWarnings + 1));
  });
});
