import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { TerminalProvider, useTerminal } from '../context/TerminalContext';
import { TerminalView } from '../components/TerminalView';
import { RESIZE_NOTIFY_DEBOUNCE_MS } from '../components/TerminalView';
import { App } from '../App';
import type { MockTerminalInstance, MockWebSocket } from './setup';

const xtermInstances = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] })
  .__xtermInstances;
const webSocketInstances = (globalThis as unknown as { __webSocketInstances: MockWebSocket[] })
  .__webSocketInstances;

const DESKTOP = { width: 1024, height: 768 };

const originalWidth = window.innerWidth;
const originalHeight = window.innerHeight;
const originalDpr = window.devicePixelRatio;

function setViewport({ width, height }: { width: number; height: number }): void {
  Object.defineProperty(window, 'innerWidth', { value: width, writable: true, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, writable: true, configurable: true });
}

function setDpr(dpr: number): void {
  Object.defineProperty(window, 'devicePixelRatio', { value: dpr, writable: true, configurable: true });
}

const settle = (ms = 60) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

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

describe('Visual-only font zoom vs PTY geometry isolation & Context Menu', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    xtermInstances.length = 0;
    webSocketInstances.length = 0;
    setDpr(1.0);
    setViewport(DESKTOP);
  });

  afterEach(() => {
    setViewport({ width: originalWidth, height: originalHeight });
    setDpr(originalDpr);
  });

  it('changing visual font size does NOT send a resize to PTY', async () => {
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    await waitFor(() => expect(webSocketInstances.length).toBe(1));

    act(() => webSocketInstances[0].simulateOpen());
    await settle(RESIZE_NOTIFY_DEBOUNCE_MS + 100);

    const term = xtermInstances[0];
    const initialCols = term.cols;
    const initialRows = term.rows;

    // Count initial resize messages
    const getSentResizes = () =>
      webSocketInstances[0].sent
        .map((frame) => (typeof frame === 'string' ? JSON.parse(frame) : {}))
        .filter((msg) => msg.type === 'resize');

    const initialResizeCount = getSentResizes().length;

    // User zooms in font from default (15px) to large (24px)
    act(() => {
      terminalCtx?.updateSettings({ fontSize: 24 });
    });
    await settle(RESIZE_NOTIFY_DEBOUNCE_MS + 100);

    // Visual font size updated on xterm options
    expect(term.options.fontSize).toBe(24);

    // PTY logical columns and rows remain stable and untouched
    expect(term.cols).toBe(initialCols);
    expect(term.rows).toBe(initialRows);

    // ZERO new resize messages dispatched over WebSocket
    const afterResizeCount = getSentResizes().length;
    expect(afterResizeCount).toBe(initialResizeCount);

    // User zooms out to compact font (10px)
    act(() => {
      terminalCtx?.updateSettings({ fontSize: 10 });
    });
    await settle(RESIZE_NOTIFY_DEBOUNCE_MS + 100);

    expect(term.options.fontSize).toBe(10);
    expect(term.cols).toBe(initialCols);
    expect(term.rows).toBe(initialRows);
    expect(getSentResizes().length).toBe(initialResizeCount);
  });

  it('initial fontSize 10 and 24 produce the exact same hello resize grid', async () => {
    // Session 1 with fontSize = 10
    sessionStorage.setItem('herdr_remote_session_view_v1', JSON.stringify({ fontSize: 10 }));
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    await waitFor(() => expect(webSocketInstances.length).toBe(1));

    act(() => webSocketInstances[0].simulateOpen());
    const helloSmall = JSON.parse(webSocketInstances[0].sent[0] as string);
    expect(helloSmall.type).toBe('hello');
    const colsSmall = helloSmall.cols;
    const rowsSmall = helloSmall.rows;

    // Reset instances for session 2
    xtermInstances.length = 0;
    webSocketInstances.length = 0;
    sessionStorage.setItem('herdr_remote_session_view_v1', JSON.stringify({ fontSize: 24 }));
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    await waitFor(() => expect(webSocketInstances.length).toBe(1));

    act(() => webSocketInstances[0].simulateOpen());
    const helloLarge = JSON.parse(webSocketInstances[0].sent[0] as string);
    expect(helloLarge.type).toBe('hello');

    // Both sessions announce the exact same stable PTY baseline grid
    expect(helloLarge.cols).toBe(colsSmall);
    expect(helloLarge.rows).toBe(rowsSmall);
  });

  it('native browser Ctrl+/- zoom (DPR change) is ignored by PTY geometry', async () => {
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    await waitFor(() => expect(webSocketInstances.length).toBe(1));

    act(() => webSocketInstances[0].simulateOpen());
    await settle(RESIZE_NOTIFY_DEBOUNCE_MS + 100);

    const term = xtermInstances[0];
    const initialCols = term.cols;
    const initialRows = term.rows;

    const getSentResizes = () =>
      webSocketInstances[0].sent
        .map((frame) => (typeof frame === 'string' ? JSON.parse(frame) : {}))
        .filter((msg) => msg.type === 'resize');

    const initialResizeCount = getSentResizes().length;

    // Simulate Ctrl + (DPR increases to 1.25, CSS px scales down inversely so physical display px is constant)
    setDpr(1.25);
    setViewport({ width: Math.round(1024 / 1.25), height: Math.round(768 / 1.25) });

    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    await settle(RESIZE_NOTIFY_DEBOUNCE_MS + 100);

    // PTY geometry stays completely stable
    expect(term.cols).toBe(initialCols);
    expect(term.rows).toBe(initialRows);
    expect(getSentResizes().length).toBe(initialResizeCount);
  });

  it('mobile pinch zoom (visualViewport scale change) is ignored by PTY geometry', async () => {
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    await waitFor(() => expect(webSocketInstances.length).toBe(1));

    act(() => webSocketInstances[0].simulateOpen());
    await settle(RESIZE_NOTIFY_DEBOUNCE_MS + 100);

    const term = xtermInstances[0];
    const initialCols = term.cols;
    const initialRows = term.rows;

    const getSentResizes = () =>
      webSocketInstances[0].sent
        .map((frame) => (typeof frame === 'string' ? JSON.parse(frame) : {}))
        .filter((msg) => msg.type === 'resize');

    const initialResizeCount = getSentResizes().length;

    // Simulate pinch-to-zoom (visualViewport scale changes to 1.5)
    if (window.visualViewport) {
      Object.defineProperty(window.visualViewport, 'scale', { value: 1.5, writable: true, configurable: true });
      act(() => {
        window.visualViewport?.dispatchEvent(new Event('resize'));
      });
      await settle(RESIZE_NOTIFY_DEBOUNCE_MS + 100);

      expect(term.cols).toBe(initialCols);
      expect(term.rows).toBe(initialRows);
      expect(getSentResizes().length).toBe(initialResizeCount);
    }
  });

  it('genuine window resize DOES update PTY geometry and dispatches resize frame', async () => {
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    await waitFor(() => expect(webSocketInstances.length).toBe(1));

    act(() => webSocketInstances[0].simulateOpen());
    await settle(RESIZE_NOTIFY_DEBOUNCE_MS + 100);

    const term = xtermInstances[0];
    const initialCols = term.cols;

    const getSentResizes = () =>
      webSocketInstances[0].sent
        .map((frame) => (typeof frame === 'string' ? JSON.parse(frame) : {}))
        .filter((msg) => msg.type === 'resize');

    const initialResizeCount = getSentResizes().length;

    // User actually widens the desktop window (1024 -> 1440 px with constant DPR = 1.0)
    setViewport({ width: 1440, height: 768 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    await settle(RESIZE_NOTIFY_DEBOUNCE_MS + 100);

    // PTY cols expanded to fit wider physical container
    expect(term.cols).toBeGreaterThan(initialCols);
    expect(getSentResizes().length).toBeGreaterThan(initialResizeCount);
  });

  it('leaves a right-click press with xterm so Herdr receives the button report', async () => {
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));

    const container = document.querySelector('#terminal-container') as HTMLElement;
    expect(container).toBeInTheDocument();

    // Herdr draws its own menu when the button-2 report reaches it, so nothing
    // here may swallow the press on its way to xterm's mouse tracking.
    const rightMouseDown = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    const preventDefaultSpy = vi.spyOn(rightMouseDown, 'preventDefault');
    const stopPropagationSpy = vi.spyOn(rightMouseDown, 'stopPropagation');

    container.dispatchEvent(rightMouseDown);

    expect(stopPropagationSpy).not.toHaveBeenCalled();
    expect(preventDefaultSpy).not.toHaveBeenCalled();
  });

  it('suppresses only the browser menu and renders no menu of its own', async () => {
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));

    const container = document.querySelector('#terminal-container') as HTMLElement;

    const contextMenuEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 250,
      clientY: 180,
    });
    const preventDefaultSpy = vi.spyOn(contextMenuEvent, 'preventDefault');

    act(() => {
      container.dispatchEvent(contextMenuEvent);
    });

    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('right click on App shell / Header / Toolbar suppresses browser native context menu', async () => {
    localStorage.setItem('herdr_remote_settings_v1', JSON.stringify({ token: 'test-token' }));
    render(<App />);
    await waitFor(() => expect(xtermInstances.length).toBe(1));

    const appShell = screen.getByTestId('app-shell');
    expect(appShell).toBeInTheDocument();

    const evt = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    const preventDefaultSpy = vi.spyOn(evt, 'preventDefault');
    const stopPropagationSpy = vi.spyOn(evt, 'stopPropagation');

    act(() => {
      appShell.dispatchEvent(evt);
    });

    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(stopPropagationSpy).toHaveBeenCalled();
  });
});
