import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { TerminalProvider, useTerminal } from '../context/TerminalContext';
import { TerminalView } from '../components/TerminalView';
import { isWheelOnlyInput } from '../protocol/scrollInput';
import { TerminalPointerController } from '../utils/touchMouseAdapter';
import type { Terminal } from '@xterm/xterm';
import type { MockTerminalInstance, MockWebSocket } from './setup';

const xtermInstances = (globalThis as unknown as { __xtermInstances: MockTerminalInstance[] })
  .__xtermInstances;
const webSocketInstances = (globalThis as unknown as { __webSocketInstances: MockWebSocket[] })
  .__webSocketInstances;

const ESC = '\x1b';

/** Replay what xterm hands its `onData` listener for a gesture or a keystroke. */
const emitTerminalData = (term: MockTerminalInstance, data: string) => {
  const onData = term.onData as unknown as { mock: { calls: Array<[(value: string) => void]> } };
  for (const [listener] of onData.mock.calls) listener(data);
};

const encode = (text: string) => {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 255;
  return bytes;
};

describe('Wheel-report recognition', () => {
  it('accepts every wheel encoding a terminal emits', () => {
    expect(isWheelOnlyInput(encode(`${ESC}[<64;12;5M`))).toBe(true);
    expect(isWheelOnlyInput(encode(`${ESC}[<65;1;1M`))).toBe(true);
    // Modifier bits (shift 4, alt 8, ctrl 16) ride along with the wheel.
    expect(isWheelOnlyInput(encode(`${ESC}[<93;200;60M`))).toBe(true);
    expect(isWheelOnlyInput(new Uint8Array([0x1b, 0x5b, 0x4d, 0x60, 0x30, 0x30]))).toBe(true);
    // A flick arrives as several notches in one frame.
    expect(isWheelOnlyInput(encode(`${ESC}[<65;12;5M${ESC}[<65;12;5M`))).toBe(true);
  });

  it('refuses typing, clicks, drags and anything smuggled alongside a wheel', () => {
    expect(isWheelOnlyInput(new Uint8Array())).toBe(false);
    expect(isWheelOnlyInput(encode('ls\r'))).toBe(false);
    expect(isWheelOnlyInput(encode('\x03'))).toBe(false);
    // Arrow keys scroll some apps, but a TUI forwards them to the shared agent.
    expect(isWheelOnlyInput(encode(`${ESC}[A`))).toBe(false);
    expect(isWheelOnlyInput(encode(`${ESC}OB`))).toBe(false);
    // Press, release and motion are not scrolling.
    expect(isWheelOnlyInput(encode(`${ESC}[<0;12;5M`))).toBe(false);
    expect(isWheelOnlyInput(encode(`${ESC}[<65;12;5m`))).toBe(false);
    expect(isWheelOnlyInput(encode(`${ESC}[<35;12;5M`))).toBe(false);
    expect(isWheelOnlyInput(encode(`${ESC}[<65;12;5M\x03`))).toBe(false);
  });
});

describe('A viewer scrolls its own stream without holding the control lease', () => {
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

  /** Bring the session up as the relay does for a second device. */
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

  const binaryFrames = () =>
    webSocketInstances[0].sent.filter((frame): frame is Uint8Array => typeof frame !== 'string');

  /** Connecting raises a success notice of its own; only refusals matter here. */
  const warnings = () => (terminalCtx?.toasts ?? []).filter((toast) => toast.type === 'warning');

  beforeEach(() => {
    localStorage.clear();
    xtermInstances.length = 0;
    webSocketInstances.length = 0;
    window.history.pushState({}, '', '/');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a wheel report but never a keystroke while read-only', async () => {
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    openAsViewer();

    const term = xtermInstances[0];
    expect(terminalCtx?.isController).toBe(false);
    const before = binaryFrames().length;

    // xterm emits the wheel report for a scroll in an alternate-screen app...
    act(() => emitTerminalData(term, `${ESC}[<65;12;5M`));
    const afterWheel = binaryFrames();
    expect(afterWheel.length).toBe(before + 1);
    expect(isWheelOnlyInput(afterWheel[afterWheel.length - 1])).toBe(true);
    // ...and scrolling must not be reported to the user as a refused action.
    // Every wheel notch used to raise one, which buried the terminal.
    expect(warnings()).toHaveLength(0);

    // A keystroke from the same read-only device is dropped, with a warning.
    act(() => emitTerminalData(term, 'x'));
    expect(binaryFrames().length).toBe(before + 1);
    await waitFor(() => expect(warnings()).toHaveLength(1));
  });

  it('lets a controller keep sending ordinary input', async () => {
    renderTerminal();
    await waitFor(() => expect(xtermInstances.length).toBe(1));
    act(() => {
      const socket = webSocketInstances[0];
      socket.simulateOpen();
      socket.simulateMessage(
        JSON.stringify({ type: 'ready', role: 'controller', controllerId: 'client-me', hostId: 'host-1', clientId: 'client-me' })
      );
    });

    const term = xtermInstances[0];
    const before = binaryFrames().length;
    act(() => emitTerminalData(term, 'x'));

    expect(binaryFrames().length).toBe(before + 1);
    expect(warnings()).toHaveLength(0);
  });
});

describe('Touch scrolling in viewer mode', () => {
  let container: HTMLDivElement;
  let screenEl: HTMLDivElement;
  let xtermRoot: HTMLDivElement;

  const pointer = (type: string, clientY: number) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerType: 'touch',
      pointerId: 1,
      isPrimary: true,
      clientX: 100,
      clientY,
    });

  const altScreenTerminal = (mouseTrackingMode: string) =>
    ({
      cols: 20,
      rows: 10,
      modes: { mouseTrackingMode },
      buffer: { active: { type: 'alternate', cursorX: 0, cursorY: 8, viewportY: 0, baseY: 0 } },
      focus: vi.fn(),
      scrollLines: vi.fn(),
      _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 10 } } } } },
    }) as unknown as Terminal;

  beforeEach(() => {
    container = document.createElement('div');
    xtermRoot = document.createElement('div');
    xtermRoot.className = 'xterm';
    screenEl = document.createElement('div');
    screenEl.className = 'xterm-screen';
    Object.defineProperty(screenEl, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 200, height: 200 }),
    });
    xtermRoot.appendChild(screenEl);
    container.appendChild(xtermRoot);
    document.body.appendChild(container);
  });

  afterEach(() => container.remove());

  it('drives the wheel for a viewer, exactly as it does for the controller', () => {
    const wheels: WheelEvent[] = [];
    xtermRoot.addEventListener('wheel', (event) => wheels.push(event as WheelEvent));

    const controller = new TerminalPointerController({
      getTerminal: () => altScreenTerminal('any-event'),
      getIsController: () => false,
      getSurfaceElement: () => container,
      scrollLineHeightPx: 10,
    });
    controller.handlePointerDown(pointer('pointerdown', 100), container);
    controller.handlePointerMove(pointer('pointermove', 70));

    expect(wheels).toHaveLength(3);
    expect(wheels.every((wheel) => wheel.deltaY === 1 && wheel.deltaMode === 1)).toBe(true);
  });

  it('stays silent for a viewer when the app would receive cursor keys instead', () => {
    // Without mouse reporting xterm turns a wheel into arrow keys, which are
    // real input the shared agent would act on. A viewer cannot send those, so
    // there is nothing to dispatch rather than something to be refused.
    const wheels: WheelEvent[] = [];
    xtermRoot.addEventListener('wheel', (event) => wheels.push(event as WheelEvent));
    const triggerDataEvent = vi.fn();
    const term = altScreenTerminal('none');
    (term as unknown as { coreService: unknown }).coreService = {
      triggerDataEvent,
      decPrivateModes: { applicationCursorKeys: false },
    };

    const controller = new TerminalPointerController({
      getTerminal: () => term,
      getIsController: () => false,
      getSurfaceElement: () => container,
      scrollLineHeightPx: 10,
    });
    controller.handlePointerDown(pointer('pointerdown', 100), container);
    controller.handlePointerMove(pointer('pointermove', 70));

    expect(wheels).toHaveLength(0);
    expect(triggerDataEvent).not.toHaveBeenCalled();
  });
});
