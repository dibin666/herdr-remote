/**
 * Pointer/touch input layer for xterm.js.
 *
 * xterm's own touch support is incomplete and its touch scrolling has
 * regressed more than once (xtermjs/xterm.js#5377, #5489), so finger input is
 * driven here instead of being left to the terminal:
 *
 *  - a tap is replayed as a mousedown/mouseup pair through xterm's mouse
 *    service when an application has mouse reporting on, then focuses xterm;
 *    this is the explicit terminal-input gesture that may open the soft keyboard;
 *  - a vertical drag scrolls xterm's normal-buffer scrollback, or becomes an
 *    application wheel/arrow gesture when the foreground app owns an
 *    alternate-screen buffer;
 *  - a long press is consumed rather than becoming an accidental text
 *    selection/copy gesture. Keyboard input is an explicit UI action on touch
 *    devices.
 *
 * Touch/pen gestures are handled by the controller so a vertical swipe can be
 * scrolled deterministically. Touch pointers are never captured, because
 * capture can disable the browser's gesture pipeline; non-touch pen drags may
 * still use capture. Real mouse input is never intercepted — it goes straight
 * to xterm.
 */

import { PointerDelivery, type PointerDeliveryOptions } from './pointerDelivery';
import { measureCellDimensions } from '@/features/terminal/terminalFit';
import {
  blurTerminal,
  type CancellableEvent,
  dispatchSyntheticMouseEvent,
  type GesturePoint,
  getActiveBuffer,
  getViewportY,
  isMouseTrackingActive,
  type ScrollMode,
} from './xtermInternals';

export interface TouchMouseOptions extends PointerDeliveryOptions {
  onLongPress?: (point: { clientX: number; clientY: number }) => void;
  onSelectionExtend?: (point: { clientX: number; clientY: number }) => void;
  onFocus?: () => void;
  /** Optional diagnostics hook used only by the debug query parameter. */
  onGestureStateChange?: (state: TouchGestureState) => void;
  /** Optional diagnostics for real-device scroll delivery. */
  onGestureScroll?: (details: {
    deltaY: number;
    lines: number;
    viewportY: number | null;
    scrollTop: number | null;
    scrollHeight: number | null;
    clientHeight: number | null;
    moved: boolean;
    bufferType: 'normal' | 'alternate' | null;
    baseY: number | null;
    cursorY: number | null;
    hasScrollback: boolean | null;
    mouseTracking: boolean;
    scrollMode: 'buffer' | 'application-mouse' | 'application-keys' | 'none';
  }) => void;
  longPressDelayMs?: number;
  dragThresholdPx?: number;
  scrollLineHeightPx?: number;
}

export type TouchGestureState = 'idle' | 'pending' | 'dragging' | 'scrolling' | 'longpress';

/**
 * TerminalPointerController turns finger gestures on the terminal container
 * into the mouse events, scrollback motion and focus that xterm expects.
 */
export class TerminalPointerController {
  private options: TouchMouseOptions;
  private state: TouchGestureState = 'idle';
  private startX = 0;
  private startY = 0;
  private lastX = 0;
  private lastY = 0;
  private activeTarget: EventTarget | null = null;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private capturedPointerId: number | null = null;
  private captureElement: HTMLElement | null = null;
  private scrollRemainderY = 0;
  private readonly delivery: PointerDelivery;

  constructor(options: TouchMouseOptions) {
    this.options = {
      longPressDelayMs: 500,
      dragThresholdPx: 8,
      scrollLineHeightPx: 18,
      ...options,
    };
    this.delivery = new PointerDelivery(this.options);
  }

  public getState(): TouchGestureState {
    return this.state;
  }

  private setGestureState(state: TouchGestureState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onGestureStateChange?.(state);
  }

  // ---------------------------------------------------------------- gestures

  private beginGesture(point: GesturePoint, container: HTMLElement): void {
    this.startX = point.clientX;
    this.startY = point.clientY;
    this.lastX = point.clientX;
    this.lastY = point.clientY;
    this.setGestureState('pending');
    this.scrollRemainderY = 0;
    this.activeTarget = this.delivery.resolveDispatchTarget(point, container);

    this.clearLongPressTimer();
    this.longPressTimer = setTimeout(() => {
      if (this.state === 'pending') {
        this.setGestureState('longpress');
        this.options.onLongPress?.({ clientX: this.startX, clientY: this.startY });
        // The pointer-down handler already canceled the browser's default
        // selection gesture. Keep the capture so a long press cannot turn into
        // a synthetic click when the finger is finally released.
      }
    }, this.options.longPressDelayMs);
  }

  private moveGesture(point: GesturePoint, event?: CancellableEvent): void {
    if (this.state === 'longpress') {
      this.options.onSelectionExtend?.({ clientX: point.clientX, clientY: point.clientY });
      if (event?.cancelable) event.preventDefault?.();
      return;
    }
    if (this.state === 'idle') return;

    const dx = point.clientX - this.startX;
    const dy = point.clientY - this.startY;
    const distance = Math.hypot(dx, dy);

    if (this.state === 'scrolling') {
      this.scrollGesture(point, event);
      return;
    }

    const term = this.options.getTerminal();
    const isController = this.options.getIsController();
    const mouseActive = isMouseTrackingActive(term);

    if (distance <= (this.options.dragThresholdPx || 8)) return;

    this.clearLongPressTimer();

    // A vertical finger movement is a viewport gesture, not an application
    // mouse drag. This is intentionally checked before mouse reporting: full
    // screen terminal UIs commonly enable mouse mode, but users still expect a
    // vertical swipe to reveal terminal history.
    if (Math.abs(dy) >= Math.abs(dx) || !mouseActive || !isController) {
      this.setGestureState('scrolling');
      if (term) blurTerminal(term);
      this.lastX = point.clientX;
      this.lastY = this.startY;
      this.scrollRemainderY = 0;
      this.scrollGesture(point, event);
      return;
    }

    if (mouseActive && isController) {
      if (this.state === 'pending') {
        // Transition to dragging and send initial mousedown with logical coords
        this.setGestureState('dragging');
        this.delivery.emitMouse(
          'mousedown',
          { clientX: this.startX, clientY: this.startY },
          event,
          this.activeTarget,
        );
      }

      if (this.state === 'dragging') {
        this.lastX = point.clientX;
        this.lastY = point.clientY;
        this.delivery.emitMouse('mousemove', point, event, this.activeTarget);
        // Prevent browser pull-to-refresh / rubberbanding during active remote terminal drag
        if (event?.cancelable) event.preventDefault?.();
      }
      return;
    }

    this.lastX = point.clientX;
    this.lastY = point.clientY;
  }

  /**
   * Scroll xterm's buffer in response to a finger movement. The browser's
   * native scroller is unreliable here because the viewport is an
   * absolutely-positioned child of an overflow-hidden terminal layer, so the
   * touch handler owns the scroll and cancels the competing default gesture.
   */
  private scrollGesture(point: GesturePoint, event?: CancellableEvent): void {
    const term = this.options.getTerminal();
    if (!term) return;

    const deltaY = point.clientY - this.lastY;
    this.lastX = point.clientX;
    this.lastY = point.clientY;

    // Sub-cell movement is carried over until a whole row is available, so a
    // slow drag still tracks the finger instead of being rounded away.
    const measuredCell = measureCellDimensions(term);
    const step = measuredCell.measured
      ? measuredCell.cellHeight
      : this.options.scrollLineHeightPx || measuredCell.cellHeight || 18;
    this.scrollRemainderY += deltaY;
    const rows = Math.trunc(this.scrollRemainderY / step);
    // Direct manipulation, the way every mobile surface behaves: the content
    // follows the finger. Dragging *down* pulls older rows into view, which is
    // a negative row delta for xterm, and dragging up reveals newer output.
    const lines = -rows;
    let moved = false;
    let scrollMode: ScrollMode = 'none';
    const active = getActiveBuffer(term);
    const mouseTracking = isMouseTrackingActive(term);

    if (lines !== 0) {
      if (active?.type === 'alternate') {
        // A TUI/agent in the alternate screen has no xterm scrollback. Its
        // visible history is owned by the application, so route a finger
        // swipe through the same wheel protocol xterm uses for mouse input.
        scrollMode = this.delivery.scrollAlternateBuffer(point, lines, term, event);
        moved = scrollMode !== 'none';
      } else {
        const beforeViewportY = getViewportY(term);
        term.scrollLines(lines);
        const afterViewportY = getViewportY(term);
        scrollMode = 'buffer';
        moved =
          beforeViewportY === null || afterViewportY === null || beforeViewportY !== afterViewportY;
      }
      this.scrollRemainderY -= rows * step;
    }

    const viewport = this.delivery.getViewportElement(term);
    this.options.onGestureScroll?.({
      deltaY,
      lines,
      viewportY: getViewportY(term),
      scrollTop: viewport?.scrollTop ?? null,
      scrollHeight: viewport?.scrollHeight ?? null,
      clientHeight: viewport?.clientHeight ?? null,
      moved,
      bufferType: active?.type || null,
      baseY: typeof active?.baseY === 'number' ? active.baseY : null,
      cursorY: typeof active?.cursorY === 'number' ? active.cursorY : null,
      hasScrollback: typeof active?.hasScrollback === 'boolean' ? active.hasScrollback : null,
      mouseTracking,
      scrollMode,
    });
    if (event?.cancelable) event.preventDefault?.();
  }

  private endGesture(point: GesturePoint | null, event?: CancellableEvent): void {
    this.clearLongPressTimer();

    const term = this.options.getTerminal();
    const isController = this.options.getIsController();
    const mouseActive = isMouseTrackingActive(term);

    if (this.state === 'pending') {
      // Single tap
      if (mouseActive && isController) {
        const tap = { clientX: this.startX, clientY: this.startY };
        this.delivery.emitMouse('mousedown', tap, event, this.activeTarget);
        this.delivery.emitMouse('mouseup', tap, event, this.activeTarget);
      }
      // A tap on the live cursor row is the terminal input gesture. Output
      // and history rows remain safe to inspect without summoning the IME.
      const tap = { clientX: this.startX, clientY: this.startY };
      if (isController && term && this.delivery.isInputLineHit(tap, term)) {
        this.options.onFocus?.();
      }
    } else if (this.state === 'dragging') {
      if (mouseActive && isController) {
        const end = point ?? { clientX: this.lastX, clientY: this.lastY };
        this.delivery.emitMouse('mouseup', end, event, this.activeTarget);
        if (event?.cancelable) event.preventDefault?.();
      }
    }

    this.reset();
  }

  // ------------------------------------------------------------ pointer path

  /**
   * @returns whether the gesture was taken over. Mouse input is deliberately
   * declined so xterm keeps its native click, drag-select and hover behaviour.
   */
  public handlePointerDown(e: PointerEvent, container: HTMLElement): boolean {
    if (e.pointerType === 'mouse') return false;
    if (!e.isPrimary) {
      // A second finger means pinch/scroll: drop the gesture entirely.
      this.releasePointerCapture();
      this.reset();
      return false;
    }

    // The controller owns touch scrolling and the compatibility mouse event
    // must not reach xterm's native mousedown handler (which focuses the
    // hidden textarea for every row). Focus is requested only after a tap is
    // classified and lands on the live input row.
    if (e.cancelable) e.preventDefault();
    this.beginGesture(e, container);

    // Do not capture touch pointers: capture can prevent Android's compositor
    // from handing a vertical gesture to the native xterm viewport. The touch
    // event path is preferred on phones; this pointer path remains a fallback
    // for browsers without TouchEvent. Non-touch pointers may still be
    // captured so an application mouse drag can finish outside the terminal.
    if (e.pointerType !== 'touch') {
      try {
        if (typeof container.setPointerCapture === 'function') {
          container.setPointerCapture(e.pointerId);
          this.capturedPointerId = e.pointerId;
          this.captureElement = container;
        }
      } catch {
        // Capture is best effort; the gesture still works without it.
      }
    }
    return true;
  }

  public handlePointerMove(e: PointerEvent): void {
    if (e.pointerType === 'mouse' || this.state === 'idle') return;
    this.moveGesture(e, e);
  }

  public handlePointerUp(e: PointerEvent): void {
    if (e.pointerType === 'mouse' || this.state === 'idle') return;
    this.releasePointerCapture();
    this.endGesture(e, e);
  }

  public handlePointerCancel(e?: PointerEvent): void {
    if (e && e.pointerType === 'mouse') return;
    this.releasePointerCapture();
    this.cancelGesture();
  }

  // -------------------------------------------------------------- touch path

  public handleTouchStart(e: TouchEvent, container: HTMLElement): void {
    if (e.touches.length !== 1) {
      this.reset();
      return;
    }
    // Own the full touch sequence. This suppresses xterm's compatibility
    // mousedown focus and leaves the controller as the only path that can
    // focus the helper textarea after a live-input-row tap.
    if (e.cancelable) e.preventDefault();
    this.beginGesture(e.touches[0], container);
  }

  public handleTouchMove(e: TouchEvent): void {
    if (e.touches.length !== 1) return;
    this.moveGesture(e.touches[0], e);
  }

  public handleTouchEnd(e: TouchEvent): void {
    // Prevent the compatibility click that mobile browsers synthesize after
    // touchend. That click would reach xterm's native handler and focus its
    // helper textarea even when this gesture was a history swipe.
    if (e.cancelable) e.preventDefault();
    this.endGesture(null, e);
  }

  public handleTouchCancel(): void {
    this.cancelGesture();
  }

  // ------------------------------------------------------------------ shared

  private cancelGesture(): void {
    this.clearLongPressTimer();
    const term = this.options.getTerminal();
    const isController = this.options.getIsController();
    const mouseActive = isMouseTrackingActive(term);

    if (this.state === 'dragging' && mouseActive && isController && this.activeTarget) {
      const cancelCoords = this.delivery.getLogicalCoordinates(this.lastX, this.lastY);
      dispatchSyntheticMouseEvent(this.activeTarget, 'mouseup', {
        clientX: cancelCoords.clientX,
        clientY: cancelCoords.clientY,
        button: 0,
        buttons: 0,
      });
    }

    this.reset();
  }

  private releasePointerCapture(): void {
    const element = this.captureElement;
    const pointerId = this.capturedPointerId;
    this.captureElement = null;
    this.capturedPointerId = null;
    if (!element || pointerId === null) return;
    try {
      if (
        typeof element.releasePointerCapture === 'function' &&
        (typeof element.hasPointerCapture !== 'function' || element.hasPointerCapture(pointerId))
      ) {
        element.releasePointerCapture(pointerId);
      }
    } catch {
      // Releasing a capture the browser already dropped is not an error.
    }
  }

  private clearLongPressTimer(): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  private reset(): void {
    this.clearLongPressTimer();
    this.releasePointerCapture();
    this.setGestureState('idle');
    this.activeTarget = null;
  }
}
