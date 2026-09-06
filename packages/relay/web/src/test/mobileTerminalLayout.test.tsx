import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import { TerminalProvider, useTerminal } from '../context/TerminalContext';
import { TerminalView, RESIZE_NOTIFY_DEBOUNCE_MS } from '../components/TerminalView';
import { App } from '../App';
import { computeContainerGridFit } from '../utils/terminalFit';
import { saveSettings } from '../utils/storage';
import type { MockTerminalInstance, MockWebSocket } from './setup';

const xtermInstances = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] })
  .__xtermInstances;
const webSocketInstances = (globalThis as unknown as { __webSocketInstances: MockWebSocket[] })
  .__webSocketInstances;

const PHONE = { width: 390, height: 780 };
const DESKTOP = { width: 1024, height: 768 };

const originalMatchMedia = window.matchMedia;
const originalMaxTouchPoints = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');
const originalWidth = window.innerWidth;
const originalHeight = window.innerHeight;

function setViewport({ width, height }: { width: number; height: number }): void {
  Object.defineProperty(window, 'innerWidth', { value: width, writable: true, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, writable: true, configurable: true });
}

/** Drives `isCoarsePointerDevice()`, which selects the renderer and input path. */
function setPointerKind(kind: 'coarse' | 'fine'): void {
  window.matchMedia = ((query: string) => ({
    matches: kind === 'coarse' && /pointer:\s*coarse|hover:\s*none/.test(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
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

/** Put this client in Control mode, as the relay does after a claim. */
const grantControl = () =>
  act(() => {
    // @ts-expect-error emit is private; exercised directly in tests
    terminalCtx?.adapter?.emit('controlGranted');
  });

const elements = () => ({
  container: document.querySelector('#terminal-container') as HTMLElement,
  frame: document.querySelector('#terminal-frame') as HTMLElement,
  surface: document.querySelector('#terminal-surface') as HTMLElement,
});

/**
 * The cell the mocked render service reports (see `setup.ts`). The fitted grid
 * is derived from what the renderer measures, not from the estimate used to
 * seed the very first frame, so this is what a settled layout produces.
 */
const renderedCell = { cellWidth: 9, cellHeight: 18 };
/** The grid the measured box produces for the renderer's own cell. */
const expectedGrid = (box: { width: number; height: number }) =>
  computeContainerGridFit({
    width: box.width,
    height: box.height,
    cellWidth: renderedCell.cellWidth,
    cellHeight: renderedCell.cellHeight,
  });

describe('Mobile terminal geometry', () => {
  beforeEach(() => {
    localStorage.clear();
    xtermInstances.length = 0;
    webSocketInstances.length = 0;
    setPointerKind('coarse');
    setViewport(PHONE);
  });

  afterEach(() => {
    setViewport({ width: originalWidth, height: originalHeight });
    window.matchMedia = originalMatchMedia;
    if (originalMaxTouchPoints) {
      Object.defineProperty(navigator, 'maxTouchPoints', originalMaxTouchPoints);
    } else {
      delete (navigator as unknown as Record<string, unknown>).maxTouchPoints;
    }
  });

  it('fills the available box edge to edge with no scale and no letterbox', async () => {
    // Regression for the screenshot: the surface used to carry a
    // `transform: scale()` and a fixed logical pixel box, which rendered as a
    // narrow terminal strip with a large empty area beside and below it.
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    await settle();

    const { container, frame, surface } = elements();

    expect(frame.style.width).toBe('100%');
    expect(frame.style.height).toBe('100%');
    expect(surface.style.width).toBe('100%');
    expect(surface.style.height).toBe('100%');

    // Unscaled and anchored top-left: the surface's own box is the coordinate
    // space xterm measures in, so there is nothing to invert on input.
    expect(surface.style.transform).toBe('none');
    expect(surface.style.transformOrigin).toBe('top left');

    // Terminal background paints every level, so no page-coloured band can
    // show through a rounding remainder.
    expect(container.style.backgroundColor).toBeTruthy();
    expect(frame.style.backgroundColor).toBe(container.style.backgroundColor);
  });

  it('derives the grid from the measured mobile box at a legible font size', async () => {
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    await settle();

    const term = xtermInstances[0];
    const expected = expectedGrid(PHONE);

    expect({ cols: term.cols, rows: term.rows }).toEqual(expected);

    // The font stays in the readable mobile band rather than being shrunk to
    // squeeze a desktop-width grid onto a phone.
    expect(term.options.fontSize).toBeGreaterThanOrEqual(12);
    expect(term.options.fontSize).toBeLessThanOrEqual(15);

    // ...and the grid covers the box: under one cell of remainder in each axis.
    expect(PHONE.width - term.cols * renderedCell.cellWidth).toBeLessThan(renderedCell.cellWidth);
    expect(PHONE.height - term.rows * renderedCell.cellHeight).toBeLessThan(renderedCell.cellHeight);
  });

  it('lets the touch controller own vertical panning on phones', async () => {
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));

    expect(elements().container.style.touchAction).toBe('none');
  });

  it('reports the grid to the PTY exactly once for a settled layout', async () => {
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    await waitFor(() => expect(webSocketInstances.length).toBe(1));

    act(() => webSocketInstances[0].simulateOpen());
    // Longer than the resize debounce, so the coalesced notification lands.
    await settle(RESIZE_NOTIFY_DEBOUNCE_MS + 150);

    const expected = expectedGrid(PHONE);
    const resizes = webSocketInstances[0].sent
      .map((frame) => JSON.parse(frame as string))
      .filter((msg) => msg.type === 'resize');

    // Debounced and change-gated: a burst of fits is one message, not many.
    expect(resizes).toHaveLength(1);
    expect(resizes[0]).toMatchObject({ cols: expected.cols, rows: expected.rows });
  });
});

describe('Terminal geometry across view navigation', () => {
  beforeEach(() => {
    localStorage.clear();
    xtermInstances.length = 0;
    webSocketInstances.length = 0;
    window.history.pushState({}, '', '/');
    saveSettings({ token: 'test-token-geometry' });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ version: '0.1.0', clients: [], hosts: [], ptys: [] }),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    setViewport({ width: originalWidth, height: originalHeight });
    window.matchMedia = originalMatchMedia;
  });

  it('re-measures instead of restoring stale desktop geometry after Admin', async () => {
    // The terminal layer stays mounted across navigation, so whatever box it
    // was last fitted to survives unless the restore path re-measures. A
    // desktop-sized grid left behind on a phone is exactly the narrow strip in
    // the screenshot.
    setPointerKind('fine');
    setViewport(DESKTOP);

    render(<App />);
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    await settle();

    const term = xtermInstances[0];
    expect({ cols: term.cols, rows: term.rows }).toEqual(expectedGrid(DESKTOP));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Admin$/i }));
    });
    expect(await screen.findByText(/System Administration/i)).toBeInTheDocument();

    // Rotate/resize into a phone viewport while the terminal is off screen.
    setPointerKind('coarse');
    setViewport(PHONE);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Terminal$/i }));
    });
    await settle();

    expect(xtermInstances.length).toBe(1);
    expect({ cols: term.cols, rows: term.rows }).toEqual(expectedGrid(PHONE));

    const { frame, surface } = elements();
    expect(frame.style.width).toBe('100%');
    expect(surface.style.transform).toBe('none');
  });
});

describe('Terminal input reaches the PTY', () => {
  beforeEach(() => {
    localStorage.clear();
    xtermInstances.length = 0;
    webSocketInstances.length = 0;
    setPointerKind('coarse');
    setViewport(PHONE);
  });

  afterEach(() => {
    setViewport({ width: originalWidth, height: originalHeight });
    window.matchMedia = originalMatchMedia;
    if (originalMaxTouchPoints) {
      Object.defineProperty(navigator, 'maxTouchPoints', originalMaxTouchPoints);
    } else {
      delete (navigator as unknown as Record<string, unknown>).maxTouchPoints;
    }
  });

  const pointerEvent = (type: string, clientX: number, clientY: number) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerType: 'touch',
      pointerId: 1,
      isPrimary: true,
      clientX,
      clientY,
    });

  it('focuses the terminal on a tap so the explicit terminal input opens', async () => {
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    await settle();

    const term = xtermInstances[0];
    const { container } = elements();
    term.buffer.active.cursorY = 11;
    grantControl();
    const focusesBefore = term.focusCount;

    act(() => {
      container.dispatchEvent(pointerEvent('pointerdown', 120, 200));
      container.dispatchEvent(pointerEvent('pointerup', 120, 200));
    });

    expect(term.focusCount).toBe(focusesBefore + 1);
  });

  it('does not focus an output row outside the live input line', async () => {
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    await settle();

    const term = xtermInstances[0];
    const { container } = elements();
    term.buffer.active.cursorY = 11;
    grantControl();
    const focusesBefore = term.focusCount;

    act(() => {
      container.dispatchEvent(pointerEvent('pointerdown', 120, 100));
      container.dispatchEvent(pointerEvent('pointerup', 120, 100));
    });

    expect(term.focusCount).toBe(focusesBefore);
  });

  it('configures xterm’s helper as the mobile terminal input', async () => {
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));

    const textarea = xtermInstances[0].textarea;
    expect(textarea.readOnly).toBe(false);
    expect(textarea.tabIndex).toBe(0);
    expect(textarea.inputMode).toBe('text');
  });

  it('scrolls the scrollback with one finger while mouse reporting is off', async () => {
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    await settle();

    const term = xtermInstances[0];
    term.modes.mouseTrackingMode = 'none';
    const { container } = elements();
    const focusesBefore = term.focusCount;

    act(() => {
      container.dispatchEvent(pointerEvent('pointerdown', 120, 300));
      container.dispatchEvent(pointerEvent('pointermove', 120, 264));
      container.dispatchEvent(pointerEvent('pointerup', 120, 264));
    });

    // 36px of finger travel over an 18px line step moves two rows, and the
    // content follows the finger: swiping up reveals newer output.
    expect(term.scrollLines).toHaveBeenCalledWith(2);
    expect(term.focusCount).toBe(focusesBefore);
  });

  it('consumes the parallel touch stream so only the pointer gesture scrolls', async () => {
    // Android Chrome delivers a full-rate pointermove stream but throttles
    // touchmove to about one event per gesture, so the pointer stream drives
    // scrolling. The touch stream still reaches xterm's own viewport scrolling
    // and synthesizes a click, so it has to be swallowed rather than acted on.
    Object.defineProperty(navigator, 'maxTouchPoints', {
      configurable: true,
      value: 1,
    });

    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    await settle();

    const term = xtermInstances[0];
    term.modes.mouseTrackingMode = 'none';
    const { container } = elements();
    const point = (y: number) => ({
      clientX: 120,
      clientY: y,
      pageX: 120,
      pageY: y,
    }) as Touch;
    const touchEvent = (type: 'touchstart' | 'touchmove' | 'touchend', y: number) =>
      new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: type === 'touchend' ? [] : [point(y)],
        changedTouches: [point(y)],
        targetTouches: type === 'touchend' ? [] : [point(y)],
      });
    const focusesBefore = term.focusCount;
    const touches = [
      touchEvent('touchstart', 300),
      touchEvent('touchmove', 264),
      touchEvent('touchend', 264),
    ];

    // The touch stream on its own moves nothing and is cancelled...
    act(() => {
      for (const event of touches) container.dispatchEvent(event);
    });
    expect(term.scrollLines).not.toHaveBeenCalled();
    expect(touches.every((event) => event.defaultPrevented)).toBe(true);

    // ...while the pointer stream for the same drag scrolls the buffer once.
    act(() => {
      container.dispatchEvent(pointerEvent('pointerdown', 120, 300));
      container.dispatchEvent(pointerEvent('pointermove', 120, 264));
      container.dispatchEvent(pointerEvent('pointerup', 120, 264));
    });

    expect(term.scrollLines).toHaveBeenCalledTimes(1);
    expect(term.scrollLines).toHaveBeenCalledWith(2);
    expect(term.focusCount).toBe(focusesBefore);
  });

  it('focuses xterm once for a tap that carries both a pointer and a touch stream', async () => {
    Object.defineProperty(navigator, 'maxTouchPoints', {
      configurable: true,
      value: 1,
    });

    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    const term = xtermInstances[0];
    const { container } = elements();
    term.buffer.active.cursorY = 16;
    grantControl();
    const point = (y: number) => ({
      clientX: 120,
      clientY: y,
      pageX: 120,
      pageY: y,
    }) as Touch;
    const touchEvent = (type: 'touchstart' | 'touchend', y: number) =>
      new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: type === 'touchend' ? [] : [point(y)],
        changedTouches: [point(y)],
        targetTouches: type === 'touchend' ? [] : [point(y)],
      });

    // A real Android tap delivers both streams, interleaved as the browser
    // orders them. Exactly one focus must come out of that.
    act(() => {
      container.dispatchEvent(pointerEvent('pointerdown', 120, 300));
      container.dispatchEvent(touchEvent('touchstart', 300));
      container.dispatchEvent(pointerEvent('pointerup', 120, 300));
      container.dispatchEvent(touchEvent('touchend', 300));
    });

    expect(term.focusCount).toBe(1);
  });

  it('keeps mouse reporting intact through xterm core events without DOM focus', async () => {
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    await settle();

    const term = xtermInstances[0];
    // An application such as vim or htop has turned mouse tracking on, and
    // this client holds the control lease. Horizontal gestures remain available
    // for application drag interactions; vertical gestures belong to scrollback.
    term.modes.mouseTrackingMode = 'any-event';
    const triggerMouseEvent = vi.fn(() => true);
    (term._core as { coreMouseService?: { triggerMouseEvent: typeof triggerMouseEvent } }).coreMouseService = {
      triggerMouseEvent,
    };
    grantControl();

    const { container, surface } = elements();
    const xtermRoot = document.createElement('div');
    xtermRoot.className = 'xterm';
    const screenEl = document.createElement('div');
    screenEl.className = 'xterm-screen';
    xtermRoot.appendChild(screenEl);
    surface.appendChild(xtermRoot);

    const seen: string[] = [];
    xtermRoot.addEventListener('mousedown', () => seen.push('mousedown'));

    act(() => {
      container.dispatchEvent(pointerEvent('pointerdown', 90, 180));
      container.dispatchEvent(pointerEvent('pointermove', 130, 180));
      container.dispatchEvent(pointerEvent('pointerup', 130, 180));
    });

    expect(triggerMouseEvent).toHaveBeenCalledTimes(3);
    const reports = triggerMouseEvent.mock.calls as unknown as Array<[{ action: number }]>;
    expect(reports.map(([event]) => event.action)).toEqual([1, 32, 0]);
    // Mobile input never falls back to a DOM mousedown, which would focus the
    // hidden textarea and summon the keyboard during a drag.
    expect(seen).toEqual([]);
    expect(term.scrollLines).not.toHaveBeenCalled();
  });
});

describe('Renderer selection', () => {
  beforeEach(() => {
    localStorage.clear();
    xtermInstances.length = 0;
    vi.mocked(WebglAddon).mockClear();
    vi.mocked(CanvasAddon).mockClear();
  });

  afterEach(() => {
    setViewport({ width: originalWidth, height: originalHeight });
    window.matchMedia = originalMatchMedia;
  });

  it('uses DOM rows on a coarse-pointer device rather than a GPU surface', async () => {
    // WebGL and canvas both fail blank rather than throwing on the mobile
    // drivers that refuse them, and DOM rows are what lets the platform run its
    // own touch selection over the terminal.
    setPointerKind('coarse');
    setViewport(PHONE);

    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));

    expect(WebglAddon).not.toHaveBeenCalled();
    expect(CanvasAddon).not.toHaveBeenCalled();
    expect(elements().container.dataset.renderer).toBe('dom');
  });

  it('keeps WebGL on a precise-pointer device for desktop throughput', async () => {
    setPointerKind('fine');
    setViewport(DESKTOP);

    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));

    expect(WebglAddon).toHaveBeenCalledTimes(1);
    expect(elements().container.dataset.renderer).toBe('webgl');
  });

  it('falls back to canvas when WebGL cannot be constructed', async () => {
    setPointerKind('fine');
    setViewport(DESKTOP);
    vi.mocked(WebglAddon).mockImplementationOnce(() => {
      throw new Error('WebGL unavailable');
    });

    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));

    expect(CanvasAddon).toHaveBeenCalledTimes(1);
    expect(elements().container.dataset.renderer).toBe('canvas');
  });

  it('falls back to DOM rows when neither GPU renderer can be constructed', async () => {
    setPointerKind('fine');
    setViewport(DESKTOP);
    vi.mocked(WebglAddon).mockImplementationOnce(() => {
      throw new Error('WebGL unavailable');
    });
    vi.mocked(CanvasAddon).mockImplementationOnce(() => {
      throw new Error('canvas unavailable');
    });

    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));

    expect(elements().container.dataset.renderer).toBe('dom');
  });
});
