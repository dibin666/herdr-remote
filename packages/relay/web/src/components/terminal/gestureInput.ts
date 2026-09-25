// Pointer and touch input on the terminal: taps become terminal clicks and
// focus, drags scroll, long presses select. One gesture stream drives it, and
// the browser's own handling of the other is suppressed.

import type { Terminal } from '@xterm/xterm';
import { TerminalPointerController } from '../../utils/touchMouseAdapter';
import type { TouchDebugUpdate } from './touchDebug';

type Point = { clientX: number; clientY: number };

export interface GestureSelection {
  hasOpenMenu(): boolean;
  clearSelection(): void;
  openMenuAtGesture(): void;
  handleLongPress(point: Point): void;
  handleSelectionExtend(point: Point): void;
}

/** Wire gestures on `container` to `term`; returns what detaches them again. */
export function attachGestureInput({
  container,
  term,
  isTouchDevice,
  debug,
  getTerminal,
  getIsController,
  getScale,
  getSurfaceElement,
  getSelection,
  onFocus,
}: {
  container: HTMLElement;
  term: Terminal;
  isTouchDevice: boolean;
  debug: TouchDebugUpdate;
  getTerminal: () => Terminal | null;
  getIsController: () => boolean;
  getScale: () => number;
  getSurfaceElement: () => HTMLElement | null;
  /** Read at event time, so the handlers of the latest render run. */
  getSelection: () => GestureSelection;
  onFocus: () => void;
}): () => void {
  const pointerController = new TerminalPointerController({
    getTerminal,
    getIsController,
    getScale,
    getSurfaceElement,
    // Never synthesize DOM mousedown events from this controller. xterm's
    // native mousedown handler focuses its hidden textarea for every row;
    // the core mouse service reports terminal clicks without opening the
    // IME before the gesture has been classified. Keeping this disabled for
    // the lifetime of the mounted terminal also covers a desktop-to-phone
    // rotation without rebuilding the xterm instance.
    allowSyntheticMouseFallback: false,
    onFocus: () => {
      // A tap is the explicit terminal-input gesture. Vertical drags never
      // reach this callback, so scrolling history cannot summon the IME.
      try {
        term.focus();
      } catch {
        // ignore
      }
      debug?.((previous) => ({
        ...previous,
        focused: document.activeElement === term.textarea,
      }));
      onFocus();
    },
    onGestureStateChange: (state) => {
      debug?.((previous) => ({ ...previous, state }));
    },
    onGestureScroll: ({
      deltaY,
      lines,
      viewportY,
      scrollTop,
      scrollHeight,
      clientHeight,
      moved,
      bufferType,
      baseY,
      cursorY,
      hasScrollback,
      mouseTracking,
      scrollMode,
    }) => {
      debug?.((previous) => ({
        ...previous,
        deltaY,
        lines,
        viewportY,
        scrollTop,
        scrollHeight,
        clientHeight,
        moved,
        focused: document.activeElement === term.textarea,
        bufferType,
        baseY,
        cursorY,
        hasScrollback,
        mouseTracking,
        scrollMode,
        scrollCalls: previous.scrollCalls + (lines !== 0 ? 1 : 0),
        lastScrollLines: lines,
      }));
    },
    longPressDelayMs: 500,
    dragThresholdPx: 8,
    scrollLineHeightPx: 18,
    onLongPress: isTouchDevice ? (p) => getSelection().handleLongPress(p) : undefined,
    onSelectionExtend: isTouchDevice ? (p) => getSelection().handleSelectionExtend(p) : undefined,
  });

  // The gesture is driven from PointerEvent wherever it exists. Measured on
  // Android Chrome, one drag delivers a full-rate pointermove stream but only
  // a single touchmove, so a touch-driven scroll threw most of the finger
  // movement away and crawled. TouchEvent remains the fallback for engines
  // with no PointerEvent at all.
  const usePointerEvents = typeof window !== 'undefined' && 'PointerEvent' in window;
  const hasTouchEvents = typeof TouchEvent !== 'undefined';
  const detachInput: Array<() => void> = [];
  const listenerOptions = { passive: false, capture: true } as const;
  const listen = <K extends keyof DocumentEventMap>(
    name: K,
    handler: (event: DocumentEventMap[K]) => void,
  ) => {
    document.addEventListener(name, handler, listenerOptions);
    detachInput.push(() => document.removeEventListener(name, handler, listenerOptions));
  };
  const eventIsInTerminal = (event: Event, allowActiveOutside = false): boolean => {
    const target = event.target;
    const inside = target instanceof Node && container.contains(target);
    return inside || (allowActiveOutside && pointerController.getState() !== 'idle');
  };
  const countEvent = (field: 'pointerEvents' | 'touchEvents', name: string) => {
    debug?.((previous) => ({
      ...previous,
      [field]: previous[field] + 1,
      lastInputEvent: name,
    }));
  };
  /**
   * A touch while the selection menu is up only closes it. Returns whether
   * that is what this touch did.
   */
  const dismissOpenMenu = (e: Event): boolean => {
    const selection = getSelection();
    if (!selection.hasOpenMenu()) return false;
    selection.clearSelection();
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    return true;
  };
  /** Open the menu on a long press, which has to be read before the controller resets. */
  const openMenuIfLongPress = () => {
    if (pointerController.getState() === 'longpress') getSelection().openMenuAtGesture();
  };

  if (usePointerEvents) {
    listen('pointerdown', (e) => {
      if (!eventIsInTerminal(e)) return;
      countEvent('pointerEvents', 'pointerdown');
      if (dismissOpenMenu(e)) return;
      const handled = pointerController.handlePointerDown(e, container);
      if (handled) e.stopPropagation();
    });
    listen('pointermove', (e) => {
      if (!eventIsInTerminal(e, true)) return;
      countEvent('pointerEvents', 'pointermove');
      pointerController.handlePointerMove(e);
      if (e.pointerType !== 'mouse') e.stopPropagation();
    });
    listen('pointerup', (e) => {
      if (!eventIsInTerminal(e, true)) return;
      countEvent('pointerEvents', 'pointerup');
      // CRITICAL: Inspect longpress state BEFORE calling handlePointerUp(e).
      // Calling handlePointerUp resets controller state to 'idle'.
      openMenuIfLongPress();
      pointerController.handlePointerUp(e);
      if (e.pointerType !== 'mouse') e.stopPropagation();
    });
    listen('pointercancel', (e) => {
      if (!eventIsInTerminal(e, true)) return;
      countEvent('pointerEvents', 'pointercancel');
      // Interrupted gesture: clear menu, selection and highlight without opening menu
      getSelection().clearSelection();
      pointerController.handlePointerCancel(e);
      if (e.pointerType !== 'mouse') e.stopPropagation();
    });

    if (hasTouchEvents) {
      // The pointer stream owns the gesture, but the parallel touch stream
      // still reaches xterm, whose own touchstart/touchmove handlers scroll
      // the nested viewport and whose synthesized click focuses the hidden
      // textarea. Consume that stream here so only one thing moves the
      // terminal and a history swipe cannot summon the IME.
      const suppressNativeTouch = (e: TouchEvent) => {
        if (!eventIsInTerminal(e, true)) return;
        debug?.((previous) => ({ ...previous, touchEvents: previous.touchEvents + 1 }));
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
      };
      for (const name of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) {
        listen(name, suppressNativeTouch);
      }
    }
  } else {
    listen('touchstart', (e) => {
      if (!eventIsInTerminal(e)) return;
      countEvent('touchEvents', 'touchstart');
      if (dismissOpenMenu(e)) return;
      if (e.touches.length === 1) e.stopPropagation();
      pointerController.handleTouchStart(e, container);
    });
    listen('touchmove', (e) => {
      if (!eventIsInTerminal(e, true)) return;
      countEvent('touchEvents', 'touchmove');
      if (e.touches.length === 1) e.stopPropagation();
      pointerController.handleTouchMove(e);
    });
    listen('touchend', (e) => {
      if (!eventIsInTerminal(e, true)) return;
      countEvent('touchEvents', 'touchend');
      // CRITICAL: Determine whether this gesture was a longpress BEFORE pointerController.handleTouchEnd(e).
      openMenuIfLongPress();
      e.stopPropagation();
      pointerController.handleTouchEnd(e);
    });
    listen('touchcancel', (e) => {
      if (!eventIsInTerminal(e, true)) return;
      countEvent('touchEvents', 'touchcancel');
      // Cancellation: clear menu, selection and highlight without opening menu
      getSelection().clearSelection();
      e.stopPropagation();
      pointerController.handleTouchCancel();
    });
  }

  // Right-click belongs to whatever is running in the terminal: Herdr draws
  // its own menu when it receives the button-2 report, so xterm's mouse
  // tracking is left to forward it. Only the browser's own menu is
  // suppressed, and preventDefault on `contextmenu` alone does that without
  // touching the button press xterm reports from.
  const onContextMenuNative = (e: MouseEvent) => {
    e.preventDefault();
  };
  container.addEventListener('contextmenu', onContextMenuNative);
  detachInput.push(() => container.removeEventListener('contextmenu', onContextMenuNative));

  return () => {
    pointerController.handlePointerCancel();
    for (const detach of detachInput) detach();
  };
}
