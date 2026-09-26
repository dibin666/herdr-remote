// Delivering a finger gesture to xterm as the input a mouse would have
// produced: which element and cell a touch lands on, mouse reports through
// xterm's core service, and wheel scrolling for programs on the alternate
// screen. Nothing here keeps gesture state; see TerminalPointerController.

import type { Terminal } from '@xterm/xterm';
import { measureCellDimensions, screenToLogicalCoords } from '@/features/terminal/terminalFit';
import {
  type CancellableEvent,
  type CoreMouseEvent,
  dispatchSyntheticMouseEvent,
  type GesturePoint,
  getCoreMouseService,
  getCoreService,
  isMouseTrackingActive,
  type ScrollMode,
} from './xtermInternals';

export interface PointerDeliveryOptions {
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
}

export class PointerDelivery {
  constructor(private readonly options: PointerDeliveryOptions) {}

  getLogicalCoordinates(screenX: number, screenY: number): { clientX: number; clientY: number } {
    const scale = this.options.getScale ? this.options.getScale() : 1.0;
    const surfaceEl = this.options.getSurfaceElement ? this.options.getSurfaceElement() : null;

    if (scale !== 1.0 && surfaceEl && typeof surfaceEl.getBoundingClientRect === 'function') {
      const rect = surfaceEl.getBoundingClientRect();
      return screenToLogicalCoords(screenX, screenY, rect, scale);
    }

    return { clientX: screenX, clientY: screenY };
  }

  /** Find xterm's real scroll viewport, if the terminal has been opened. */
  getViewportElement(term: Terminal): HTMLElement | null {
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
  isInputLineHit(point: GesturePoint, term: Terminal): boolean {
    const active = (
      term as unknown as {
        buffer?: {
          active?: {
            cursorY?: number;
            viewportY?: number;
            baseY?: number;
          };
        };
      }
    ).buffer?.active;

    const surface = this.options.getSurfaceElement ? this.options.getSurfaceElement() : null;
    const screen = (surface?.querySelector('.xterm-screen') ||
      term.element ||
      surface) as HTMLElement | null;
    const cell = measureCellDimensions(term);
    if (!screen || typeof screen.getBoundingClientRect !== 'function' || cell.cellHeight <= 0) {
      return false;
    }

    const rect = screen.getBoundingClientRect();
    const logical = this.getLogicalCoordinates(point.clientX, point.clientY);
    const hasScreenBox = rect.width > 0 && rect.height > 0;
    const hasCursorPosition = [active?.cursorY, active?.viewportY, active?.baseY].every(
      (value) => typeof value === 'number' && Number.isFinite(value),
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
      (!hasScreenBox || (logical.clientX >= rect.left && logical.clientX <= rect.right))
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
  resolveDispatchTarget(point: GesturePoint, container: HTMLElement): EventTarget {
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
  getMouseReport(point: GesturePoint, term: Terminal): CoreMouseEvent | null {
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

  /**
   * Find xterm's root so a synthetic wheel follows the exact same native path
   * as a real mouse wheel. It is important that this is *not* a mousedown:
   * xterm's mousedown handler focuses its hidden textarea, which would summon
   * the mobile IME for an output/history touch.
   */
  getWheelDispatchTarget(term: Terminal): HTMLElement | null {
    const surface = this.options.getSurfaceElement ? this.options.getSurfaceElement() : null;
    return (surface?.querySelector('.xterm') || term.element || null) as HTMLElement | null;
  }

  /**
   * Deliver a line-quantized wheel gesture through xterm's native wheel
   * handler. xterm then chooses the right protocol itself: mouse reports for
   * mouse-enabled TUIs, cursor-key input for an alternate buffer without
   * mouse reporting, or normal-buffer scrollback. A canceled wheel is still a
   * successful delivery — xterm cancels it after forwarding it to the PTY.
   *
   * One event per row is deliberate. xterm emits exactly one mouse report per
   * wheel event regardless of how many rows that event carries, so a single
   * multi-row event made a fast swipe crawl one line at a time.
   */
  dispatchWheel(
    point: GesturePoint,
    lines: number,
    term: Terminal,
    event?: CancellableEvent,
  ): boolean {
    const target = this.getWheelDispatchTarget(term);
    if (!target || typeof WheelEvent === 'undefined' || lines === 0) return false;

    const logical = this.getLogicalCoordinates(point.clientX, point.clientY);
    const step = lines < 0 ? -1 : 1;
    let sent = 0;

    for (let index = 0; index < Math.abs(lines); index += 1) {
      try {
        const wheel = new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: logical.clientX,
          clientY: logical.clientY,
          deltaX: 0,
          // Line mode keeps the gesture deterministic instead of depending on
          // the browser's pixel-to-line conversion or xterm's partial-wheel
          // accumulator.
          deltaY: step,
          deltaMode: 1, // WheelEvent.DOM_DELTA_LINE
          ctrlKey: Boolean(event?.ctrlKey),
          altKey: Boolean(event?.altKey),
          shiftKey: Boolean(event?.shiftKey),
        });
        target.dispatchEvent(wheel);
        sent += 1;
      } catch {
        // Older embedded browsers may expose WheelEvent but reject its
        // constructor. The core-service fallback below keeps those builds
        // usable without ever dispatching a focus-causing mousedown.
        return sent > 0;
      }
    }

    return sent > 0;
  }

  /** Direct core fallback for xterm builds that expose no DOM wheel target. */
  emitWheel(point: GesturePoint, lines: number, term: Terminal, event?: CancellableEvent): boolean {
    if (lines === 0) return false;
    if (this.dispatchWheel(point, lines, term, event)) return true;

    const service = getCoreMouseService(term);
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
  scrollAlternateBuffer(
    point: GesturePoint,
    lines: number,
    term: Terminal,
    event?: CancellableEvent,
  ): ScrollMode {
    if (lines === 0) return 'none';

    const mouseTracking = isMouseTrackingActive(term);
    // A viewer may scroll: it drives its own PTY stream, so a wheel report
    // moves only its own screen. The cursor-key fallback further down is
    // ordinary keyboard input, which stays behind the control lease — sending
    // it as a viewer would only earn a read-only rejection.
    if (!mouseTracking && !this.options.getIsController()) return 'none';

    if (this.emitWheel(point, lines, term, event)) {
      return mouseTracking ? 'application-mouse' : 'application-keys';
    }

    // Keep a protocol-level fallback for a test double or an older xterm build
    // that has neither a DOM root nor a core mouse service.
    if (!mouseTracking) {
      const service = getCoreService(term);
      if (!service?.triggerDataEvent) return 'none';

      const applicationCursorKeys = Boolean(service.decPrivateModes?.applicationCursorKeys);
      const sequence = `\u001b${applicationCursorKeys ? 'O' : '['}${lines < 0 ? 'A' : 'B'}`;
      service.triggerDataEvent(sequence.repeat(Math.abs(lines)), true);
      return 'application-keys';
    }

    return 'none';
  }

  /** Send a mouse report directly when xterm exposes its core mouse service. */
  emitMouse(
    type: 'mousedown' | 'mousemove' | 'mouseup',
    point: GesturePoint,
    event: CancellableEvent | undefined,
    activeTarget: EventTarget | null,
  ): void {
    const term = this.options.getTerminal();
    if (!term) return;

    const service = getCoreMouseService(term);
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
    if (this.options.allowSyntheticMouseFallback === false || !activeTarget) return;
    const logical = this.getLogicalCoordinates(point.clientX, point.clientY);
    dispatchSyntheticMouseEvent(activeTarget, type, {
      clientX: logical.clientX,
      clientY: logical.clientY,
      button: 0,
      buttons: type === 'mouseup' ? 0 : 1,
    });
  }
}
