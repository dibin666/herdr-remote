import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isMouseTrackingActive,
  createSyntheticMouseEvent,
  dispatchSyntheticMouseEvent,
  TerminalPointerController,
} from '../utils/touchMouseAdapter';
import { Terminal } from '@xterm/xterm';

// jsdom ships no `document.elementFromPoint`, so the adapter's hit test has to
// be installed explicitly to exercise it.
function stubElementFromPoint(hit: Element | null): void {
  Object.defineProperty(document, 'elementFromPoint', {
    value: () => hit,
    configurable: true,
    writable: true,
  });
}

function clearElementFromPoint(): void {
  delete (document as unknown as Record<string, unknown>).elementFromPoint;
}

const touch = (clientX: number, clientY: number) => ({ clientX, clientY }) as Touch;

const pointer = (
  type: string,
  init: { clientX?: number; clientY?: number; pointerType?: string; pointerId?: number; isPrimary?: boolean } = {}
): PointerEvent =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerType: 'touch',
    pointerId: 1,
    isPrimary: true,
    ...init,
  });

describe('TouchToMouseAdapter Unit Tests', () => {
  it('detects mouse tracking mode from xterm modes correctly', () => {
    expect(isMouseTrackingActive(null)).toBe(false);

    const mockTermNone = { modes: { mouseTrackingMode: 'none' } } as unknown as Terminal;
    expect(isMouseTrackingActive(mockTermNone)).toBe(false);

    const mockTermX10 = { modes: { mouseTrackingMode: 'x10' } } as unknown as Terminal;
    expect(isMouseTrackingActive(mockTermX10)).toBe(true);

    const mockTermAny = { modes: { mouseTrackingMode: 'any-event' } } as unknown as Terminal;
    expect(isMouseTrackingActive(mockTermAny)).toBe(true);

    const mockTermCore = {
      _core: { coreMouseService: { areMouseEventsActive: true } },
    } as unknown as Terminal;
    expect(isMouseTrackingActive(mockTermCore)).toBe(true);
  });

  it('creates synthetic MouseEvents with correct coordinates and button flags', () => {
    const downEvent = createSyntheticMouseEvent('mousedown', {
      clientX: 120,
      clientY: 85,
      button: 0,
      buttons: 1,
    });
    expect(downEvent.type).toBe('mousedown');
    expect(downEvent.clientX).toBe(120);
    expect(downEvent.clientY).toBe(85);
    expect(downEvent.button).toBe(0);
    expect(downEvent.buttons).toBe(1);
    expect(downEvent.bubbles).toBe(true);
    expect(downEvent.cancelable).toBe(true);

    const upEvent = createSyntheticMouseEvent('mouseup', {
      clientX: 120,
      clientY: 85,
      button: 0,
      buttons: 0,
    });
    expect(upEvent.type).toBe('mouseup');
    expect(upEvent.button).toBe(0);
    expect(upEvent.buttons).toBe(0);
  });

  it('dispatches synthetic MouseEvents to target element', () => {
    const target = document.createElement('div');
    const listener = vi.fn();
    target.addEventListener('mousedown', listener);

    dispatchSyntheticMouseEvent(target, 'mousedown', {
      clientX: 50,
      clientY: 60,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    const ev = listener.mock.calls[0][0] as MouseEvent;
    expect(ev.clientX).toBe(50);
    expect(ev.clientY).toBe(60);
  });

  describe('TerminalPointerController gestures', () => {
    let mockContainer: HTMLDivElement;
    let mockScreen: HTMLDivElement;
    let mockTerm: {
      modes: { mouseTrackingMode: string };
      buffer: {
        active: { cursorX: number; cursorY: number; viewportY: number; baseY: number };
      };
      focus: ReturnType<typeof vi.fn>;
      scrollLines: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockContainer = document.createElement('div');
      mockScreen = document.createElement('div');
      mockScreen.className = 'xterm-screen';
      mockContainer.appendChild(mockScreen);
      document.body.appendChild(mockContainer);

      mockTerm = {
        modes: { mouseTrackingMode: 'any-event' },
        buffer: { active: { cursorX: 0, cursorY: 8, viewportY: 0, baseY: 0 } },
        focus: vi.fn(),
        scrollLines: vi.fn(),
      };
    });

    afterEach(() => {
      clearElementFromPoint();
      mockContainer.remove();
    });

    const makeController = (overrides = {}) =>
      new TerminalPointerController({
        getTerminal: () => mockTerm as unknown as Terminal,
        getIsController: () => true,
        getSurfaceElement: () => mockContainer,
        dragThresholdPx: 5,
        ...overrides,
      });

    it('replays a pointer tap as a mousedown/mouseup pair on the xterm element', () => {
      const seen: string[] = [];
      mockScreen.addEventListener('mousedown', () => seen.push('mousedown'));
      mockScreen.addEventListener('mouseup', () => seen.push('mouseup'));

      const focusSpy = vi.fn();
      const controller = makeController({ onFocus: focusSpy });

      expect(
        controller.handlePointerDown(pointer('pointerdown', { clientX: 100, clientY: 150 }), mockContainer)
      ).toBe(true);
      expect(controller.getState()).toBe('pending');

      const up = pointer('pointerup', { clientX: 100, clientY: 150 });
      const preventDefault = vi.spyOn(up, 'preventDefault');
      controller.handlePointerUp(up);

      expect(seen).toEqual(['mousedown', 'mouseup']);
      expect(preventDefault).not.toHaveBeenCalled();
      // A tap is the explicit terminal-input gesture; only a drag is kept
      // away from xterm focus so it can scroll without opening the keyboard.
      expect(mockTerm.focus).not.toHaveBeenCalled();
      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(controller.getState()).toBe('idle');
    });

    it('does not request terminal focus for a viewer tap', () => {
      const focusSpy = vi.fn();
      const controller = makeController({
        getIsController: () => false,
        onFocus: focusSpy,
      });

      controller.handlePointerDown(pointer('pointerdown', { clientX: 35, clientY: 45 }), mockContainer);
      controller.handlePointerUp(pointer('pointerup', { clientX: 35, clientY: 45 }));

      expect(focusSpy).not.toHaveBeenCalled();
    });

    it('uses xterm core mouse reports for a tap without focusing the helper textarea', () => {
      const triggerMouseEvent = vi.fn(() => true);
      Object.defineProperty(mockScreen, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ left: 0, top: 0, width: 200, height: 200 }),
      });
      const coreTerm = {
        ...mockTerm,
        cols: 20,
        rows: 10,
        _core: {
          coreMouseService: { triggerMouseEvent },
          _renderService: {
            dimensions: { css: { cell: { width: 10, height: 20 } } },
          },
        },
      } as unknown as Terminal;
      const controller = new TerminalPointerController({
        getTerminal: () => coreTerm,
        getIsController: () => true,
        getSurfaceElement: () => mockContainer,
      });

      controller.handlePointerDown(pointer('pointerdown', { clientX: 35, clientY: 45 }), mockContainer);
      controller.handlePointerUp(pointer('pointerup', { clientX: 35, clientY: 45 }));

      expect(triggerMouseEvent).toHaveBeenCalledTimes(2);
      const reports = (triggerMouseEvent.mock.calls as unknown as Array<[{
        action: number;
        col: number;
        row: number;
        x: number;
        y: number;
      }]>).map(([event]) => event);
      expect(reports.map((event) => event.action)).toEqual([1, 0]);
      expect(reports[0]).toMatchObject({ col: 3, row: 2, x: 35, y: 45 });
      expect(mockTerm.focus).not.toHaveBeenCalled();
    });

    it('does not capture touch pointers before native vertical panning', () => {
      const controller = makeController();
      const down = pointer('pointerdown', { clientX: 50, clientY: 50, pointerId: 7 });

      controller.handlePointerDown(down, mockContainer);
      expect(mockContainer.hasPointerCapture(7)).toBe(false);

      controller.handlePointerMove(pointer('pointermove', { clientX: 50, clientY: 75, pointerId: 7 }));
      expect(controller.getState()).toBe('scrolling');

      controller.handlePointerUp(pointer('pointerup', { clientX: 50, clientY: 75, pointerId: 7 }));
      expect(mockContainer.hasPointerCapture(7)).toBe(false);
    });

    it('captures a non-touch pointer for an application drag', () => {
      const controller = makeController();
      const down = pointer('pointerdown', { clientX: 50, clientY: 50, pointerId: 8, pointerType: 'pen' });

      controller.handlePointerDown(down, mockContainer);
      expect(mockContainer.hasPointerCapture(8)).toBe(true);
      controller.handlePointerCancel(pointer('pointercancel', { clientX: 50, clientY: 50, pointerId: 8, pointerType: 'pen' }));
      expect(mockContainer.hasPointerCapture(8)).toBe(false);
    });

    it('reports a horizontal drag to the PTY as mousedown, mousemove and mouseup in logical coords', () => {
      const seen: { type: string; x: number; y: number }[] = [];
      for (const type of ['mousedown', 'mousemove', 'mouseup'] as const) {
        mockScreen.addEventListener(type, (e) =>
          seen.push({ type, x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY })
        );
      }

      const controller = makeController();
      controller.handlePointerDown(pointer('pointerdown', { clientX: 50, clientY: 50 }), mockContainer);
      controller.handlePointerMove(pointer('pointermove', { clientX: 75, clientY: 50 }));
      controller.handlePointerMove(pointer('pointermove', { clientX: 90, clientY: 50 }));
      controller.handlePointerUp(pointer('pointerup', { clientX: 90, clientY: 50 }));

      expect(seen.map((e) => e.type)).toEqual(['mousedown', 'mousemove', 'mousemove', 'mouseup']);
      expect(seen[0]).toEqual({ type: 'mousedown', x: 50, y: 50 });
      expect(seen[3]).toEqual({ type: 'mouseup', x: 90, y: 50 });
    });

    it('declines real mouse input so xterm keeps its native click and selection', () => {
      const seen: string[] = [];
      mockScreen.addEventListener('mousedown', () => seen.push('mousedown'));

      const controller = makeController();
      expect(
        controller.handlePointerDown(
          pointer('pointerdown', { clientX: 10, clientY: 10, pointerType: 'mouse' }),
          mockContainer
        )
      ).toBe(false);

      controller.handlePointerUp(pointer('pointerup', { clientX: 10, clientY: 10, pointerType: 'mouse' }));
      expect(seen).toEqual([]);
      expect(controller.getState()).toBe('idle');
    });

    it('scrolls the scrollback with one finger when mouse reporting is off', () => {
      mockTerm.modes.mouseTrackingMode = 'none';
      const controller = makeController({ scrollLineHeightPx: 10 });

      controller.handlePointerDown(pointer('pointerdown', { clientX: 100, clientY: 100 }), mockContainer);
      // The content follows the finger: swiping up 30px moves 3 rows down,
      // towards newer output, exactly like every other mobile scroller.
      controller.handlePointerMove(pointer('pointermove', { clientX: 100, clientY: 70 }));

      expect(mockTerm.scrollLines).toHaveBeenCalledWith(3);
    });

    it('drags older history back into view when the finger moves down', () => {
      mockTerm.modes.mouseTrackingMode = 'none';
      const controller = makeController({ scrollLineHeightPx: 10 });

      controller.handlePointerDown(pointer('pointerdown', { clientX: 100, clientY: 100 }), mockContainer);
      controller.handlePointerMove(pointer('pointermove', { clientX: 100, clientY: 130 }));

      expect(mockTerm.scrollLines).toHaveBeenCalledWith(-3);
    });

    it('scrolls the scrollback even when the foreground app has mouse reporting on', () => {
      mockTerm.modes.mouseTrackingMode = 'any-event';
      const controller = makeController({ scrollLineHeightPx: 10 });

      controller.handlePointerDown(pointer('pointerdown', { clientX: 100, clientY: 100 }), mockContainer);
      controller.handlePointerMove(pointer('pointermove', { clientX: 100, clientY: 70 }));

      expect(controller.getState()).toBe('scrolling');
      expect(mockTerm.scrollLines).toHaveBeenCalledWith(3);
    });

    it('replays an alternate-screen swipe as one line-mode wheel event per row', () => {
      const xtermRoot = document.createElement('div');
      xtermRoot.className = 'xterm';
      mockContainer.replaceChildren(xtermRoot);
      xtermRoot.appendChild(mockScreen);
      const wheelEvents: WheelEvent[] = [];
      xtermRoot.addEventListener('wheel', (event) => wheelEvents.push(event as WheelEvent));

      const active = { ...mockTerm.buffer.active, type: 'alternate' as const };
      const altTerm = {
        ...mockTerm,
        cols: 20,
        rows: 10,
        buffer: { active },
        _core: {
          _renderService: {
            dimensions: { css: { cell: { width: 10, height: 10 } } },
          },
        },
      } as unknown as Terminal;

      const controller = new TerminalPointerController({
        getTerminal: () => altTerm,
        getIsController: () => true,
        getSurfaceElement: () => mockContainer,
        scrollLineHeightPx: 10,
      });
      controller.handlePointerDown(
        pointer('pointerdown', { clientX: 100, clientY: 100 }),
        mockContainer
      );
      controller.handlePointerMove(pointer('pointermove', { clientX: 100, clientY: 70 }));

      // xterm emits one mouse report per wheel event no matter how many rows
      // that event carries, so a 3-row swipe has to be 3 events or the agent
      // scrolls a single line per gesture.
      expect(wheelEvents).toHaveLength(3);
      expect(wheelEvents.every((wheel) => wheel.deltaY === 1 && wheel.deltaMode === 1)).toBe(true);
      expect(mockTerm.scrollLines).not.toHaveBeenCalled();
    });

    it('sends wheel reports to an alternate-screen app for a finger swipe', () => {
      const triggerMouseEvent = vi.fn(() => true);
      const active = { ...mockTerm.buffer.active, type: 'alternate' as const };
      const altTerm = {
        ...mockTerm,
        cols: 20,
        rows: 10,
        buffer: { active },
        coreMouseService: { triggerMouseEvent },
        _core: {
          _renderService: {
            dimensions: { css: { cell: { width: 10, height: 10 } } },
          },
        },
      } as unknown as Terminal;
      Object.defineProperty(mockScreen, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ left: 0, top: 0, width: 200, height: 200 }),
      });

      const controller = new TerminalPointerController({
        getTerminal: () => altTerm,
        getIsController: () => true,
        getSurfaceElement: () => mockContainer,
        scrollLineHeightPx: 10,
      });
      controller.handlePointerDown(
        pointer('pointerdown', { clientX: 100, clientY: 100 }),
        mockContainer
      );
      controller.handlePointerMove(pointer('pointermove', { clientX: 100, clientY: 70 }));

      const reports = triggerMouseEvent.mock.calls as unknown as Array<[{ button: number; action: number }]>;
      expect(reports).toHaveLength(3);
      // Swiping up scrolls down: CoreMouseButton.WHEEL with CoreMouseAction.DOWN.
      expect(reports.every(([event]) => event.button === 4 && event.action === 1)).toBe(true);
      expect(mockTerm.scrollLines).not.toHaveBeenCalled();
    });

    it('sends cursor-key scroll input to an alternate-screen app without mouse reporting', () => {
      const triggerDataEvent = vi.fn();
      const active = { ...mockTerm.buffer.active, type: 'alternate' as const };
      const altTerm = {
        ...mockTerm,
        buffer: { active },
        coreService: {
          triggerDataEvent,
          decPrivateModes: { applicationCursorKeys: false },
        },
        modes: { mouseTrackingMode: 'none' },
      } as unknown as Terminal;

      const controller = new TerminalPointerController({
        getTerminal: () => altTerm,
        getIsController: () => true,
        getSurfaceElement: () => mockContainer,
        scrollLineHeightPx: 10,
      });
      controller.handlePointerDown(
        pointer('pointerdown', { clientX: 100, clientY: 100 }),
        mockContainer
      );
      controller.handlePointerMove(pointer('pointermove', { clientX: 100, clientY: 70 }));

      expect(triggerDataEvent).toHaveBeenCalledWith('\u001b[B\u001b[B\u001b[B', true);
      expect(mockTerm.scrollLines).not.toHaveBeenCalled();
    });

    it('uses xterm scrollLines even when the viewport has measurable overflow', () => {
      const surface = document.createElement('div');
      const viewport = document.createElement('div');
      viewport.className = 'xterm-viewport';
      const screen = document.createElement('div');
      screen.className = 'xterm-screen';
      surface.append(viewport, screen);
      mockContainer.appendChild(surface);
      Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1000 });
      Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 });
      viewport.scrollTop = 500;

      const controller = makeController({
        getSurfaceElement: () => surface,
        scrollLineHeightPx: 10,
      });
      const move = pointer('pointermove', { clientX: 100, clientY: 70 });
      const preventDefault = vi.spyOn(move, 'preventDefault');
      controller.handlePointerDown(pointer('pointerdown', { clientX: 100, clientY: 100 }), mockContainer);
      controller.handlePointerMove(move);

      expect(mockTerm.scrollLines).toHaveBeenCalledWith(3);
      expect(viewport.scrollTop).toBe(500);
      expect(preventDefault).toHaveBeenCalled();
    });

    it('dispatches into the xterm root even when the touch lands on the terminal background', () => {
      // A tap below the last row resolves to an *ancestor* of `.xterm`, and
      // xterm's mousedown listener is bound to `.xterm` itself — an event
      // dispatched from there would bubble away from the terminal.
      const surface = document.createElement('div');
      const xtermRoot = document.createElement('div');
      xtermRoot.className = 'xterm';
      const screenEl = document.createElement('div');
      screenEl.className = 'xterm-screen';
      xtermRoot.appendChild(screenEl);
      surface.appendChild(xtermRoot);
      mockContainer.appendChild(surface);

      const background = document.createElement('div');
      mockContainer.appendChild(background);
      stubElementFromPoint(background);

      const seen: string[] = [];
      xtermRoot.addEventListener('mousedown', () => seen.push('mousedown'));
      xtermRoot.addEventListener('mouseup', () => seen.push('mouseup'));

      const controller = makeController({ getSurfaceElement: () => surface });
      controller.handlePointerDown(pointer('pointerdown', { clientX: 10, clientY: 900 }), mockContainer);
      controller.handlePointerUp(pointer('pointerup', { clientX: 10, clientY: 900 }));

      expect(seen).toEqual(['mousedown', 'mouseup']);
    });

    it('does not use a stale helper textarea box as the mobile input hit target', () => {
      const surface = document.createElement('div');
      const xtermRoot = document.createElement('div');
      xtermRoot.className = 'xterm';
      const screen = document.createElement('div');
      screen.className = 'xterm-screen';
      const helper = document.createElement('textarea');
      helper.className = 'xterm-helper-textarea';
      xtermRoot.append(screen, helper);
      surface.appendChild(xtermRoot);
      mockContainer.appendChild(surface);
      Object.defineProperty(screen, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ left: 0, top: 0, width: 200, height: 200 }),
      });
      Object.defineProperty(helper, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ left: 0, top: 0, width: 200, height: 20, bottom: 20 }),
      });

      const focusSpy = vi.fn();
      const controller = makeController({
        getSurfaceElement: () => surface,
        onFocus: focusSpy,
      });
      // The live cursor is on row 8; the stale helper is incorrectly reported
      // at row 0. A tap on row 0 must remain a safe output/history tap.
      controller.handlePointerDown(
        pointer('pointerdown', { clientX: 20, clientY: 10 }),
        mockContainer
      );
      controller.handlePointerUp(pointer('pointerup', { clientX: 20, clientY: 10 }));

      expect(focusSpy).not.toHaveBeenCalled();
    });

    it('keeps using the precise hit target when it is inside the xterm root', () => {
      const surface = document.createElement('div');
      const xtermRoot = document.createElement('div');
      xtermRoot.className = 'xterm';
      const screenEl = document.createElement('div');
      screenEl.className = 'xterm-screen';
      const helper = document.createElement('textarea');
      xtermRoot.append(screenEl, helper);
      surface.appendChild(xtermRoot);
      mockContainer.appendChild(surface);
      stubElementFromPoint(helper);

      const targets: EventTarget[] = [];
      xtermRoot.addEventListener('mousedown', (e) => targets.push(e.target as EventTarget));

      const controller = makeController({ getSurfaceElement: () => surface });
      controller.handlePointerDown(pointer('pointerdown', { clientX: 10, clientY: 10 }), mockContainer);
      controller.handlePointerUp(pointer('pointerup', { clientX: 10, clientY: 10 }));

      expect(targets).toEqual([helper]);
    });

    it('consumes a long press so an ordinary tap cannot open native selection and copy', async () => {
      const mousedownSpy = vi.fn();
      mockScreen.addEventListener('mousedown', mousedownSpy);

      const controller = makeController({ longPressDelayMs: 50 });
      const down = pointer('pointerdown', { clientX: 100, clientY: 100, pointerId: 3 });
      controller.handlePointerDown(down, mockContainer);

      await new Promise((r) => setTimeout(r, 70));
      expect(controller.getState()).toBe('longpress');
      // Touch pointers are never captured, so the browser can still own
      // vertical panning if the gesture is reclassified by the platform.
      expect(mockContainer.hasPointerCapture(3)).toBe(false);

      controller.handlePointerUp(pointer('pointerup', { clientX: 100, clientY: 100, pointerId: 3 }));
      expect(mousedownSpy).not.toHaveBeenCalled();
    });

    it('releases the button on pointercancel so the PTY is not left dragging', () => {
      const mouseupSpy = vi.fn();
      mockScreen.addEventListener('mouseup', mouseupSpy);

      const controller = makeController();
      controller.handlePointerDown(pointer('pointerdown', { clientX: 50, clientY: 50 }), mockContainer);
      controller.handlePointerMove(pointer('pointermove', { clientX: 70, clientY: 50 }));
      expect(controller.getState()).toBe('dragging');

      controller.handlePointerCancel(pointer('pointercancel', { clientX: 70, clientY: 50 }));
      expect(mouseupSpy).toHaveBeenCalled();
      expect(controller.getState()).toBe('idle');
    });

    it('does not synthesize DOM mouse events when the mobile fallback is disabled', () => {
      const seen: string[] = [];
      mockScreen.addEventListener('mousedown', () => seen.push('mousedown'));
      mockScreen.addEventListener('mouseup', () => seen.push('mouseup'));

      const controller = makeController({ allowSyntheticMouseFallback: false });
      controller.handlePointerDown(
        pointer('pointerdown', { clientX: 100, clientY: 150 }),
        mockContainer
      );
      controller.handlePointerUp(pointer('pointerup', { clientX: 100, clientY: 150 }));

      expect(seen).toEqual([]);
    });

    it('still works through touch events on engines without PointerEvent', () => {
      const seen: string[] = [];
      mockScreen.addEventListener('mousedown', () => seen.push('mousedown'));
      mockScreen.addEventListener('mouseup', () => seen.push('mouseup'));

      const controller = makeController();
      controller.handleTouchStart(
        new TouchEvent('touchstart', { touches: [touch(100, 150)] }),
        mockContainer
      );
      expect(controller.getState()).toBe('pending');

      const end = new TouchEvent('touchend', { touches: [], cancelable: true });
      const preventDefault = vi.spyOn(end, 'preventDefault');
      controller.handleTouchEnd(end);
      expect(seen).toEqual(['mousedown', 'mouseup']);
      expect(preventDefault).toHaveBeenCalled();
      expect(mockTerm.focus).not.toHaveBeenCalled();
    });

    it('drops the gesture when a second finger joins', () => {
      const controller = makeController();
      controller.handlePointerDown(pointer('pointerdown', { clientX: 50, clientY: 50 }), mockContainer);
      expect(controller.getState()).toBe('pending');

      controller.handlePointerDown(
        pointer('pointerdown', { clientX: 200, clientY: 200, pointerId: 2, isPrimary: false }),
        mockContainer
      );
      expect(controller.getState()).toBe('idle');
    });
  });
});
