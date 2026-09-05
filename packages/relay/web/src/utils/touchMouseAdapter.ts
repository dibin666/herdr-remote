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

import { Terminal } from '@xterm/xterm';
import { measureCellDimensions, screenToLogicalCoords } from './terminalFit';

export interface TouchMouseOptions {
  getTerminal: () => Terminal | null;
  getIsController: () => boolean;
  getScale?: () => number;
  getSurfaceElement?: () => HTMLElement | null;
  /**
   * Touch input must never fall back to DOM mousedown events: xterm handles
   * those by focusing its hidden textarea, which lets an arbitrary tap summon
   * the mobile IME. Production touch paths use the core mouse service instead.
   */
  allowSyntheticMouseFallback?: boolean;
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

/** Minimal shape the gesture machine needs from a touch or pointer event. */
interface GesturePoint {
  clientX: number;
  clientY: number;
}

/** Anything that can suppress the browser's default handling of a gesture. */
interface CancellableEvent {
  cancelable?: boolean;
  preventDefault?: () => void;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

interface CoreMouseEvent {
  col: number;
  row: number;
  x: number;
  y: number;
  button: number;
  action: number;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

interface CoreMouseService {
  triggerMouseEvent: (event: CoreMouseEvent) => boolean;
}

interface CoreService {
  triggerDataEvent: (data: string, wasUserInput?: boolean) => void;
  decPrivateModes?: { applicationCursorKeys?: boolean };
}

type ScrollMode = 'buffer' | 'application-mouse' | 'application-keys' | 'none';

type ActiveBuffer = {
  type?: 'normal' | 'alternate';
  baseY?: number;
  cursorY?: number;
  viewportY?: number;
  hasScrollback?: boolean;
};

/**
 * Check whether xterm terminal has mouse tracking enabled by a running program (e.g. htop, tmux, vim)
 */
export function isMouseTrackingActive(term: Terminal | null): boolean {
  if (!term) return false;
  try {
    // xterm 5+ modes object
    const modes = (term as unknown as { modes?: { mouseTrackingMode?: string } }).modes;
    if (modes && typeof modes.mouseTrackingMode === 'string' && modes.mouseTrackingMode !== 'none') {
      return true;
    }

    // Fallback to internal core mouse service if accessible
    const core = (term as unknown as {
      _core?: {
        _coreMouseService?: { areMouseEventsActive?: boolean };
        coreMouseService?: { areMouseEventsActive?: boolean };
        mouseMode?: string;
      };
    })._core;

    if (core?._coreMouseService?.areMouseEventsActive || core?.coreMouseService?.areMouseEventsActive) {
      return true;
    }
    if (core?.mouseMode && core.mouseMode !== 'none') {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * Create a synthetic MouseEvent with proper coordinates and button states
 */
export function createSyntheticMouseEvent(
  type: 'mousedown' | 'mousemove' | 'mouseup',
  coords: { clientX: number; clientY: number; button?: number; buttons?: number }
): MouseEvent {
  const button = coords.button ?? 0;
  const buttons = coords.buttons ?? (type === 'mouseup' ? 0 : 1);

  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: coords.clientX,
    clientY: coords.clientY,
    screenX: coords.clientX,
    screenY: coords.clientY,
    button,
    buttons,
  });
}

/**
 * Dispatch a synthetic MouseEvent on the target DOM element
 */
export function dispatchSyntheticMouseEvent(
  target: EventTarget,
  type: 'mousedown' | 'mousemove' | 'mouseup',
  coords: { clientX: number; clientY: number; button?: number; buttons?: number }
): boolean {
  const event = createSyntheticMouseEvent(type, coords);
  return target.dispatchEvent(event);
}

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

  constructor(options: TouchMouseOptions) {
    this.options = {
      longPressDelayMs: 500,
      dragThresholdPx: 8,
      scrollLineHeightPx: 18,
      ...options,
    };
  }

  public getState(): TouchGestureState {
    return this.state;
  }

  private setGestureState(state: TouchGestureState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onGestureStateChange?.(state);
  }

  private getActiveBuffer(term: Terminal): ActiveBuffer | null {
    try {
      return ((term as unknown as { buffer?: { active?: ActiveBuffer } }).buffer?.active || null);
    } catch {
      return null;
    }
  }

  private getViewportY(term: Terminal): number | null {
    const viewportY = this.getActiveBuffer(term)?.viewportY;
    return typeof viewportY === 'number' && Number.isFinite(viewportY) ? viewportY : null;
  }

  private blurTerminal(term: Terminal): void {
    try {
      (term as unknown as { blur?: () => void }).blur?.();
    } catch {
      // A test double or an older xterm build may not expose blur().
    }
  }

  private getLogicalCoordinates(screenX: number, screenY: number): { clientX: number; clientY: number } {
    const scale = this.options.getScale ? this.options.getScale() : 1.0;
    const surfaceEl = this.options.getSurfaceElement ? this.options.getSurfaceElement() : null;

    if (scale !== 1.0 && surfaceEl && typeof surfaceEl.getBoundingClientRect === 'function') {
      const rect = surfaceEl.getBoundingClientRect();
      return screenToLogicalCoords(screenX, screenY, rect, scale);
    }

    return { clientX: screenX, clientY: screenY };
  }

  /** Find xterm's real scroll viewport, if the terminal has been opened. */
  private getViewportElement(term: Terminal): HTMLElement | null {
    const surface = this.options.getSurfaceElement ? this.options.getSurfaceElement() : null;
    const viewport =
      surface?.querySelector('.xterm-viewport') ||
      term.element?.querySelector('.xterm-viewport') ||
      null;
    return viewport as HTMLElement | null;
  }

  /**
   * Only the row containing xterm's live cursor is an input target on touch.
   * A tap on a historical/output row must not summon the Android keyboard.
   */
  private isInputLineHit(point: GesturePoint, term: Terminal): boolean {
    const active = (term as unknown as {
      buffer?: {
        active?: {
          cursorY?: number;
          viewportY?: number;
          baseY?: number;
        };
      };
    }).buffer?.active;

    const surface = this.options.getSurfaceElement ? this.options.getSurfaceElement() : null;
    const screen = (
      surface?.querySelector('.xterm-screen') ||
      term.element ||
      surface
    ) as HTMLElement | null;
    const cell = measureCellDimensions(term);
    if (!screen || typeof screen.getBoundingClientRect !== 'function' || cell.cellHeight <= 0) {
      return false;
    }

    const rect = screen.getBoundingClientRect();
    const logical = this.getLogicalCoordinates(point.clientX, point.clientY);
    const hasScreenBox = rect.width > 0 && rect.height > 0;
    const hasCursorPosition = [active?.cursorY, active?.viewportY, active?.baseY].every(
      (value) => typeof value === 'number' && Number.isFinite(value)
    );

    // Do not use the helper textarea's box for hit testing. xterm deliberately
    // keeps that textarea invisible and mobile browsers can report its stale
    // or CSS-positioned box even while the terminal is showing history. The
    // only trustworthy input target is the row where xterm's live cursor is
    // currently visible in the active buffer viewport.
    if (!hasCursorPosition) return false;

    const cursorY = active?.cursorY as number;
    const viewportY = active?.viewportY as number;
    const baseY = active?.baseY as number;
    const visibleCursorRow = baseY + cursorY - viewportY;
    const lineTop = rect.top + visibleCursorRow * cell.cellHeight;
    const lineBottom = lineTop + cell.cellHeight;
    const terminalRows = Number((term as unknown as { rows?: number }).rows);

    return (
      visibleCursorRow >= 0 &&
      (!Number.isFinite(terminalRows) || visibleCursorRow < terminalRows) &&
      logical.clientY >= lineTop - 2 &&
      logical.clientY <= lineBottom + 2 &&
      (!hasScreenBox ||
        (logical.clientX >= rect.left && logical.clientX <= rect.right))
    );
  }

  /**
   * Picks the element the synthetic mouse events are dispatched from.
   *
   * xterm registers its `mousedown` handler on its own `.xterm` root, so the
   * event only reaches the PTY if it is dispatched from a node inside that
   * root. The precise hit target is preferred when it lands there, but a touch
   * on the terminal background — the padding remainder below the last row —
   * resolves to an *ancestor* of `.xterm`, from which the event would bubble
   * away from the terminal instead of into it.
   */
  private resolveDispatchTarget(point: GesturePoint, container: HTMLElement): EventTarget {
    const surface = this.options.getSurfaceElement ? this.options.getSurfaceElement() : null;
    const screenEl =
      surface?.querySelector('.xterm-screen') || container.querySelector('.xterm-screen') || null;
    const xtermRoot = screenEl?.closest?.('.xterm') || null;

    let hit: Element | null = null;
    if (typeof document !== 'undefined' && typeof document.elementFromPoint === 'function') {
      hit = document.elementFromPoint(point.clientX, point.clientY);
    }

    if (hit && xtermRoot && (hit === xtermRoot || xtermRoot.contains(hit))) {
      return hit;
    }

    return screenEl || surface || container;
  }

  /**
   * Convert a touch point into the same zero-based coordinates xterm's own
   * browser mouse service uses. This lets us report a terminal click without
   * dispatching a DOM mousedown, whose xterm handler necessarily focuses the
   * hidden textarea and opens Android/iOS input.
   */
  private getMouseReport(point: GesturePoint, term: Terminal): CoreMouseEvent | null {
    const surface = this.options.getSurfaceElement ? this.options.getSurfaceElement() : null;
    const screen = (surface?.querySelector('.xterm-screen') || term.element) as HTMLElement | null;
    if (!screen || typeof screen.getBoundingClientRect !== 'function') return null;

    const rect = screen.getBoundingClientRect();
    const logical = this.getLogicalCoordinates(point.clientX, point.clientY);
    const cell = measureCellDimensions(term);
    // The renderer normally has measured the cell by the time a user can
    // touch the terminal. Keep the fallback usable during the first paint as
    // well; an approximate wheel coordinate is still safer than dropping the
    // application's scroll gesture altogether.
    if (cell.cellWidth <= 0 || cell.cellHeight <= 0) return null;

    const width = Math.max(1, rect.width || term.cols * cell.cellWidth);
    const height = Math.max(1, rect.height || term.rows * cell.cellHeight);
    const x = Math.max(0, Math.min(width - 1, logical.clientX - rect.left));
    const y = Math.max(0, Math.min(height - 1, logical.clientY - rect.top));
    const col = Math.max(0, Math.min(term.cols - 1, Math.floor(x / cell.cellWidth)));
    const row = Math.max(0, Math.min(term.rows - 1, Math.floor(y / cell.cellHeight)));

    return {
      col,
      row,
      x: Math.floor(x),
      y: Math.floor(y),
      button: 0,
      action: 0,
    };
  }

  private getCoreMouseService(term: Terminal): CoreMouseService | null {
    const candidate = term as unknown as {
      coreMouseService?: CoreMouseService;
      _core?: {
        coreMouseService?: CoreMouseService;
        _coreMouseService?: CoreMouseService;
      };
    };

    return (
      candidate.coreMouseService ||
      candidate._core?.coreMouseService ||
      candidate._core?._coreMouseService ||
      null
    );
  }

  private getCoreService(term: Terminal): CoreService | null {
    const candidate = term as unknown as {
      coreService?: CoreService;
      _core?: { coreService?: CoreService };
    };
    return candidate.coreService || candidate._core?.coreService || null;
  }

  /**
   * Find xterm's root so a synthetic wheel follows the exact same native path
   * as a real mouse wheel. It is important that this is *not* a mousedown:
   * xterm's mousedown handler focuses its hidden textarea, which would summon
   * the mobile IME for an output/history touch.
   */
  private getWheelDispatchTarget(term: Terminal): HTMLElement | null {
    const surface = this.options.getSurfaceElement ? this.options.getSurfaceElement() : null;
    return (surface?.querySelector('.xterm') || term.element || null) as HTMLElement | null;
  }

  /**
   * Deliver a line-quantized wheel gesture through xterm's native wheel
   * handler. xterm then chooses the right protocol itself: mouse reports for
   * mouse-enabled TUIs, cursor-key input for an alternate buffer without
   * mouse reporting, or normal-buffer scrollback. A canceled wheel is still a
   * successful delivery — xterm cancels it after forwarding it to the PTY.
   */
  private dispatchWheel(
    point: GesturePoint,
    lines: number,
    term: Terminal,
    event?: CancellableEvent
  ): boolean {
    const target = this.getWheelDispatchTarget(term);
    if (!target || typeof WheelEvent === 'undefined') return false;

    const logical = this.getLogicalCoordinates(point.clientX, point.clientY);
    try {
      const wheel = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: logical.clientX,
        clientY: logical.clientY,
        deltaX: 0,
        // Line mode makes the gesture deterministic and avoids depending on
        // the browser's pixel-to-line conversion or xterm's partial-wheel
        // accumulator. One event carries the whole row delta.
        deltaY: lines,
        deltaMode: 1, // WheelEvent.DOM_DELTA_LINE
        ctrlKey: Boolean(event?.ctrlKey),
        altKey: Boolean(event?.altKey),
        shiftKey: Boolean(event?.shiftKey),
      });
      target.dispatchEvent(wheel);
      return true;
    } catch {
      // Older embedded browsers may expose WheelEvent but reject its
      // constructor. The core-service fallback below keeps those builds
      // usable without ever dispatching a focus-causing mousedown.
      return false;
    }
  }

  /** Direct core fallback for xterm builds that expose no DOM wheel target. */
  private emitWheel(
    point: GesturePoint,
    lines: number,
    term: Terminal,
    event?: CancellableEvent
  ): boolean {
    if (lines === 0) return false;
    if (this.dispatchWheel(point, lines, term, event)) return true;

    const service = this.getCoreMouseService(term);
    if (!service?.triggerMouseEvent) return false;

    let sent = 0;
    for (let index = 0; index < Math.abs(lines); index += 1) {
      const report = this.getMouseReport(point, term);
      if (!report) continue;
      report.button = 4; // CoreMouseButton.WHEEL
      report.action = lines < 0 ? 0 : 1; // CoreMouseAction.UP/DOWN
      report.ctrl = Boolean(event?.ctrlKey);
      report.alt = Boolean(event?.altKey);
      report.shift = Boolean(event?.shiftKey);
      if (service.triggerMouseEvent(report)) sent += 1;
    }
    return sent > 0;
  }

  /**
   * Alternate-screen buffers have no xterm scrollback. Match xterm's native
   * wheel behavior there: mouse-enabled apps receive wheel reports; otherwise
   * they receive application cursor-key sequences. Both paths keep scrolling
   * inside the agent rather than pretending an empty xterm viewport moved.
   */
  private scrollAlternateBuffer(
    point: GesturePoint,
    lines: number,
    term: Terminal,
    event?: CancellableEvent
  ): ScrollMode {
    if (lines === 0 || !this.options.getIsController()) return 'none';

    const mouseTracking = isMouseTrackingActive(term);
    if (this.emitWheel(point, lines, term, event)) {
      return mouseTracking ? 'application-mouse' : 'application-keys';
    }

    // Keep a protocol-level fallback for a test double or an older xterm build
    // that has neither a DOM root nor a core mouse service.
    if (!mouseTracking) {
      const service = this.getCoreService(term);
      if (!service?.triggerDataEvent) return 'none';

      const applicationCursorKeys = Boolean(service.decPrivateModes?.applicationCursorKeys);
      const sequence = `\u001b${applicationCursorKeys ? 'O' : '['}${lines < 0 ? 'A' : 'B'}`;
      service.triggerDataEvent(sequence.repeat(Math.abs(lines)), true);
      return 'application-keys';
    }

    return 'none';
  }

  /** Send a mouse report directly when xterm exposes its core mouse service. */
  private emitMouse(
    type: 'mousedown' | 'mousemove' | 'mouseup',
    point: GesturePoint,
    event?: CancellableEvent
  ): void {
    const term = this.options.getTerminal();
    if (!term) return;

    const service = this.getCoreMouseService(term);
    if (service?.triggerMouseEvent) {
      const report = this.getMouseReport(point, term);
      if (report) {
        report.action = type === 'mousedown' ? 1 : type === 'mouseup' ? 0 : 32;
        report.ctrl = Boolean(event?.ctrlKey);
        report.alt = Boolean(event?.altKey);
        report.shift = Boolean(event?.shiftKey);
        service.triggerMouseEvent(report);
      }
      // Never fall back to a DOM mousedown when xterm owns the core service:
      // the caller performs the deliberate focus after the tap is classified,
      // so a native mousedown cannot focus xterm during an in-progress swipe.
      return;
    }

    // Test doubles and older xterm builds without the core service may retain
    // the DOM fallback, but the production touch path opts out. A DOM
    // mousedown is not a safe compatibility mechanism on mobile because
    // xterm's native handler focuses the hidden textarea before we know
    // whether the gesture was a tap or a swipe.
    if (this.options.allowSyntheticMouseFallback === false || !this.activeTarget) return;
    const logical = this.getLogicalCoordinates(point.clientX, point.clientY);
    dispatchSyntheticMouseEvent(this.activeTarget, type, {
      clientX: logical.clientX,
      clientY: logical.clientY,
      button: 0,
      buttons: type === 'mouseup' ? 0 : 1,
    });
  }

  // ---------------------------------------------------------------- gestures

  private beginGesture(point: GesturePoint, container: HTMLElement): void {
    this.startX = point.clientX;
    this.startY = point.clientY;
    this.lastX = point.clientX;
    this.lastY = point.clientY;
    this.setGestureState('pending');
    this.scrollRemainderY = 0;
    this.activeTarget = this.resolveDispatchTarget(point, container);

    this.clearLongPressTimer();
    this.longPressTimer = setTimeout(() => {
      if (this.state === 'pending') {
        this.setGestureState('longpress');
        // The pointer-down handler already canceled the browser's default
        // selection gesture. Keep the capture so a long press cannot turn into
        // a synthetic click when the finger is finally released.
      }
    }, this.options.longPressDelayMs);
  }

  private moveGesture(point: GesturePoint, event?: CancellableEvent): void {
    if (this.state === 'longpress' || this.state === 'idle') return;

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
      if (term) this.blurTerminal(term);
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
        this.emitMouse('mousedown', { clientX: this.startX, clientY: this.startY }, event);
      }

      if (this.state === 'dragging') {
        this.lastX = point.clientX;
        this.lastY = point.clientY;
        this.emitMouse('mousemove', point, event);
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

    // Keep sub-cell movement until a whole row is available; a finger swipe
    // upward therefore produces negative rows and reveals older output.
    const measuredCell = measureCellDimensions(term);
    const step = measuredCell.measured
      ? measuredCell.cellHeight
      : this.options.scrollLineHeightPx || measuredCell.cellHeight || 18;
    this.scrollRemainderY += deltaY;
    const lines = Math.trunc(this.scrollRemainderY / step);
    let moved = false;
    let scrollMode: ScrollMode = 'none';
    const active = this.getActiveBuffer(term);
    const mouseTracking = isMouseTrackingActive(term);

    if (lines !== 0) {
      if (active?.type === 'alternate') {
        // A TUI/agent in the alternate screen has no xterm scrollback. Its
        // visible history is owned by the application, so route a finger
        // swipe through the same wheel protocol xterm uses for mouse input.
        scrollMode = this.scrollAlternateBuffer(point, lines, term, event);
        moved = scrollMode !== 'none';
      } else {
        const beforeViewportY = this.getViewportY(term);
        term.scrollLines(lines);
        const afterViewportY = this.getViewportY(term);
        scrollMode = 'buffer';
        moved =
          beforeViewportY === null ||
          afterViewportY === null ||
          beforeViewportY !== afterViewportY;
      }
      this.scrollRemainderY -= lines * step;
    }

    const viewport = this.getViewportElement(term);
    this.options.onGestureScroll?.({
      deltaY,
      lines,
      viewportY: this.getViewportY(term),
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
        this.emitMouse('mousedown', tap, event);
        this.emitMouse('mouseup', tap, event);
      }
      // A tap on the live cursor row is the terminal input gesture. Output
      // and history rows remain safe to inspect without summoning the IME.
      const tap = { clientX: this.startX, clientY: this.startY };
      if (isController && term && this.isInputLineHit(tap, term)) {
        this.options.onFocus?.();
      }
    } else if (this.state === 'dragging') {
      if (mouseActive && isController) {
        const end = point ?? { clientX: this.lastX, clientY: this.lastY };
        this.emitMouse('mouseup', end, event);
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
      const cancelCoords = this.getLogicalCoordinates(this.lastX, this.lastY);
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
