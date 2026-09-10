import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, waitFor, screen } from '@testing-library/react';
import { TerminalProvider, useTerminal } from '../context/TerminalContext';
import {
  TerminalView,
  PREDICTIVE_ECHO_AUTO_THRESHOLD_MS,
  shouldShowPredictiveEcho,
} from '../components/TerminalView';
import { PredictiveEcho } from '../utils/predictiveEcho';
import { PredictionOverlay } from '../utils/predictionOverlay';
import { saveSettings } from '../utils/storage';
import type { MockTerminalInstance, MockWebSocket } from './setup';

const xtermInstances = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] })
  .__xtermInstances;
const webSocketInstances = (globalThis as unknown as { __webSocketInstances: MockWebSocket[] })
  .__webSocketInstances;

const emitTerminalData = (term: MockTerminalInstance, data: string) => {
  const onData = term.onData as unknown as { mock: { calls: Array<[(value: string) => void]> } };
  for (const [listener] of onData.mock.calls) listener(data);
};

describe('Predictive Echo Integration & Setting Controls', () => {
  const renderTerminal = () => {
    return render(
      <TerminalProvider>
        <TerminalView isActive={true} />
      </TerminalProvider>
    );
  };

  const openAsController = () =>
    act(() => {
      const socket = webSocketInstances[0];
      socket.simulateOpen();
      socket.simulateMessage(
        JSON.stringify({
          type: 'ready',
          role: 'controller',
          controllerId: 'client-me',
          hostId: 'host-1',
          clientId: 'client-me',
        })
      );
    });

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

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    xtermInstances.length = 0;
    webSocketInstances.length = 0;
    window.history.pushState({}, '', '/');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('shouldShowPredictiveEcho logic helper', () => {
    it('always suppresses predictions when mode is "off"', () => {
      expect(shouldShowPredictiveEcho('off', null)).toBe(false);
      expect(shouldShowPredictiveEcho('off', 0)).toBe(false);
      expect(shouldShowPredictiveEcho('off', 30)).toBe(false);
      expect(shouldShowPredictiveEcho('off', 40)).toBe(false);
      expect(shouldShowPredictiveEcho('off', 150)).toBe(false);
    });

    it('always shows predictions when mode is "always"', () => {
      expect(shouldShowPredictiveEcho('always', null)).toBe(true);
      expect(shouldShowPredictiveEcho('always', 0)).toBe(true);
      expect(shouldShowPredictiveEcho('always', 20)).toBe(true);
      expect(shouldShowPredictiveEcho('always', 40)).toBe(true);
      expect(shouldShowPredictiveEcho('always', 150)).toBe(true);
    });

    it('in "auto" mode, suppresses predictions when srtt is null or <= threshold', () => {
      expect(shouldShowPredictiveEcho('auto', null)).toBe(false);
      expect(shouldShowPredictiveEcho('auto', 0)).toBe(false);
      expect(shouldShowPredictiveEcho('auto', 20)).toBe(false);
      expect(shouldShowPredictiveEcho('auto', PREDICTIVE_ECHO_AUTO_THRESHOLD_MS)).toBe(false);
    });

    it('in "auto" mode, enables predictions when srtt > threshold', () => {
      expect(shouldShowPredictiveEcho('auto', PREDICTIVE_ECHO_AUTO_THRESHOLD_MS + 1)).toBe(true);
      expect(shouldShowPredictiveEcho('auto', 80)).toBe(true);
      expect(shouldShowPredictiveEcho('auto', 200)).toBe(true);
    });
  });

  describe('Live terminal integration with modes', () => {
    it('off mode: does NOT render predictions even if typing occurs and keeps overlay cleared', async () => {
      saveSettings({ predictiveEcho: 'off' });
      const handleUserInputSpy = vi.spyOn(PredictiveEcho.prototype, 'handleUserInput');
      const syncSpy = vi.spyOn(PredictionOverlay.prototype, 'sync');
      const clearSpy = vi.spyOn(PredictionOverlay.prototype, 'clear');

      renderTerminal();
      await waitFor(() => expect(xtermInstances.length).toBe(1));
      openAsController();

      const term = xtermInstances[0];
      act(() => {
        emitTerminalData(term, 'hello');
      });

      expect(handleUserInputSpy).toHaveBeenCalledTimes(1);
      // Overlay sync must never be called under "off"
      expect(syncSpy).not.toHaveBeenCalled();
      expect(clearSpy).toHaveBeenCalled();
    });

    it('auto mode (default): suppresses overlay when srtt is null or <= 40ms', async () => {
      saveSettings({ predictiveEcho: 'auto' });
      const syncSpy = vi.spyOn(PredictionOverlay.prototype, 'sync');
      const clearSpy = vi.spyOn(PredictionOverlay.prototype, 'clear');

      // Case 1: srtt is null (unconfirmed)
      vi.spyOn(PredictiveEcho.prototype, 'getEchoSrttMs').mockReturnValue(null);

      renderTerminal();
      await waitFor(() => expect(xtermInstances.length).toBe(1));
      openAsController();

      const term = xtermInstances[0];
      act(() => {
        emitTerminalData(term, 'a');
      });

      expect(syncSpy).not.toHaveBeenCalled();
      expect(clearSpy).toHaveBeenCalled();

      // Case 2: srtt is low (e.g. 25ms <= 40ms threshold)
      syncSpy.mockClear();
      clearSpy.mockClear();
      vi.spyOn(PredictiveEcho.prototype, 'getEchoSrttMs').mockReturnValue(25);

      act(() => {
        emitTerminalData(term, 'b');
      });

      expect(syncSpy).not.toHaveBeenCalled();
      expect(clearSpy).toHaveBeenCalled();
    });

    it('auto mode: renders predictions when srtt > 40ms', async () => {
      saveSettings({ predictiveEcho: 'auto' });
      vi.spyOn(PredictiveEcho.prototype, 'getEchoSrttMs').mockReturnValue(120);
      const syncSpy = vi.spyOn(PredictionOverlay.prototype, 'sync');

      renderTerminal();
      await waitFor(() => expect(xtermInstances.length).toBe(1));
      openAsController();

      const term = xtermInstances[0];
      act(() => {
        emitTerminalData(term, 'abc');
      });

      expect(syncSpy).toHaveBeenCalled();

      // Server output also syncs visible predictions when above threshold
      syncSpy.mockClear();
      act(() => {
        term.emitWriteParsed?.();
      });
      expect(syncSpy).toHaveBeenCalled();
    });

    it('always mode: displays predictions regardless of srtt (even when null)', async () => {
      saveSettings({ predictiveEcho: 'always' });
      vi.spyOn(PredictiveEcho.prototype, 'getEchoSrttMs').mockReturnValue(null);
      const syncSpy = vi.spyOn(PredictionOverlay.prototype, 'sync');

      renderTerminal();
      await waitFor(() => expect(xtermInstances.length).toBe(1));
      openAsController();

      const term = xtermInstances[0];
      act(() => {
        emitTerminalData(term, 'xyz');
      });

      expect(syncSpy).toHaveBeenCalled();
    });

    it('immediately clears active prediction overlay when switched to "off"', async () => {
      saveSettings({ predictiveEcho: 'always' });
      const clearSpy = vi.spyOn(PredictionOverlay.prototype, 'clear');

      const TestHarness = () => {
        const { updateSettings } = useTerminal();
        return (
          <div>
            <button onClick={() => updateSettings({ predictiveEcho: 'off' })}>Turn Off</button>
            <TerminalView isActive={true} />
          </div>
        );
      };

      render(
        <TerminalProvider>
          <TestHarness />
        </TerminalProvider>
      );

      await waitFor(() => expect(xtermInstances.length).toBe(1));
      openAsController();

      clearSpy.mockClear();

      // Switch setting dynamically to 'off'
      act(() => {
        screen.getByText('Turn Off').click();
      });

      // Must be cleared immediately without waiting for next keystroke
      expect(clearSpy).toHaveBeenCalled();
    });

    it('does NOT predict keystrokes when in viewer mode (non-controller)', async () => {
      saveSettings({ predictiveEcho: 'always' });
      const handleUserInputSpy = vi.spyOn(PredictiveEcho.prototype, 'handleUserInput');
      const syncSpy = vi.spyOn(PredictionOverlay.prototype, 'sync');

      renderTerminal();
      await waitFor(() => expect(xtermInstances.length).toBe(1));
      openAsViewer();

      const term = xtermInstances[0];
      handleUserInputSpy.mockClear();
      syncSpy.mockClear();
      act(() => {
        emitTerminalData(term, 'echo test');
      });

      expect(handleUserInputSpy).not.toHaveBeenCalled();
      expect(syncSpy).not.toHaveBeenCalled();
    });

    it('resets predictor and clears overlay when scrolling occurs', async () => {
      saveSettings({ predictiveEcho: 'always' });
      const resetSpy = vi.spyOn(PredictiveEcho.prototype, 'reset');
      const clearSpy = vi.spyOn(PredictionOverlay.prototype, 'clear');

      renderTerminal();
      await waitFor(() => expect(xtermInstances.length).toBe(1));
      openAsController();

      const term = xtermInstances[0];
      const onScroll = term.onScroll as unknown as { mock: { calls: Array<[() => void]> } };
      expect(onScroll.mock.calls.length).toBeGreaterThan(0);

      act(() => {
        for (const [listener] of onScroll.mock.calls) listener();
      });

      expect(resetSpy).toHaveBeenCalledWith('scroll');
      expect(clearSpy).toHaveBeenCalled();
    });

    it('displays predictive echo mode in touch debug HUD', async () => {
      window.history.pushState({}, '', '/?debug=1');
      saveSettings({ predictiveEcho: 'always' });

      renderTerminal();
      await waitFor(() => expect(xtermInstances.length).toBe(1));
      openAsController();

      const debugPre = screen.getByTestId('terminal-touch-debug');
      expect(debugPre.textContent).toContain('mode: always');
    });
  });
});
