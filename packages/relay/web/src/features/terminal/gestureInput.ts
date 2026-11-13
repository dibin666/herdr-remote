// Taps and swipes drive the terminal; native copy controls own text selection.
import type { Terminal } from '@xterm/xterm';
import {
  nativeCopyField,
  nativeCopySelection,
  TERMINAL_TOUCH_DRAG_THRESHOLD_PX,
} from './nativeCopy';
import { TerminalPointerController } from './touch/touchMouseAdapter';
import type { TouchDebugUpdate } from './touchDebug';

type Point = { clientX: number; clientY: number };

/** Wire gestures on the container to xterm without cancelling native copying. */
export function attachGestureInput({
  container,
  term,
  debug,
  getTerminal,
  getIsController,
  getScale,
  getSurfaceElement,
  getImageAt,
  onImage,
  onFocus,
  getTapOpensKeyboard,
  onKeyboardOffer,
  onKeyboardOfferDismiss,
}: {
  container: HTMLElement;
  term: Terminal;
  debug: TouchDebugUpdate;
  getTerminal: () => Terminal | null;
  getIsController: () => boolean;
  getScale: () => number;
  getSurfaceElement: () => HTMLElement | null;
  getImageAt?: (point: Point) => ImageBitmap | null;
  onImage?: (image: ImageBitmap) => void;
  onFocus: () => void;
  getTapOpensKeyboard: () => boolean;
  onKeyboardOffer: () => void;
  onKeyboardOfferDismiss: () => void;
}): () => void {
  const pointerController = new TerminalPointerController({
    getTerminal,
    getIsController,
    getScale,
    getSurfaceElement,
    // Compatibility mousedown would focus xterm before a swipe is classified.
    allowSyntheticMouseFallback: false,
    isNativeSelectionTarget: (target) => nativeCopyField(target) !== null,
    onImageTap: getImageAt
      ? (point) => {
          const image = getImageAt(point);
          if (!image) return false;
          onImage?.(image);
          return true;
        }
      : undefined,
    onFocus: () => {
      if (!getTapOpensKeyboard() && document.activeElement !== term.textarea) {
        onKeyboardOffer();
        return;
      }
      try {
        term.focus();
      } catch {
        // A terminal being disposed no longer has an input to focus.
      }
      debug?.((previous) => ({
        ...previous,
        focused: document.activeElement === term.textarea,
      }));
      onFocus();
    },
    onTapOutsideInput: onKeyboardOfferDismiss,
    onGestureStateChange: (state) => {
      debug?.((previous) => ({ ...previous, state }));
      if (state !== 'idle' && state !== 'pending') onKeyboardOfferDismiss();
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
        bufferType,
        baseY,
        cursorY,
        hasScrollback,
        mouseTracking,
        scrollMode,
        focused: document.activeElement === term.textarea,
        scrollCalls: previous.scrollCalls + (lines !== 0 ? 1 : 0),
        lastScrollLines: lines,
      }));
    },
    longPressDelayMs: 500,
    dragThresholdPx: TERMINAL_TOUCH_DRAG_THRESHOLD_PX,
    scrollLineHeightPx: 18,
  });

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
    return (
      (target instanceof Node && container.contains(target)) ||
      (allowActiveOutside && pointerController.getState() !== 'idle')
    );
  };
  const countEvent = (field: 'pointerEvents' | 'touchEvents', name: string) => {
    debug?.((previous) => ({
      ...previous,
      [field]: previous[field] + 1,
      lastInputEvent: name,
    }));
  };
  const selectionOwnsGesture = () => {
    if (!nativeCopySelection(container)) return false;
    pointerController.handlePointerCancel();
    return true;
  };
  let nativeTapEnded = false;
  let mouseImagePress: {
    image: ImageBitmap;
    pointerId: number;
    x: number;
    y: number;
    stillATap: boolean;
  } | null = null;

  if (usePointerEvents) {
    listen('pointerdown', (event) => {
      if (!eventIsInTerminal(event)) return;
      countEvent('pointerEvents', 'pointerdown');
      nativeTapEnded = false;
      const field = nativeCopyField(event.target);
      const selected = nativeCopySelection(container);
      if (selected) {
        pointerController.handlePointerCancel();
        if (!field) {
          selected.blur();
          if (event.cancelable) event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (event.pointerType === 'mouse' && event.button === 0 && getImageAt) {
        const image = getImageAt(event);
        if (image) {
          mouseImagePress = {
            image,
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            stillATap: true,
          };
          if (event.cancelable) event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
      const handled = pointerController.handlePointerDown(event, container);
      if (handled && !field) event.stopPropagation();
    });
    listen('pointermove', (event) => {
      if (!eventIsInTerminal(event, true)) return;
      countEvent('pointerEvents', 'pointermove');
      if (selectionOwnsGesture()) return;
      if (mouseImagePress) {
        if (event.pointerId === mouseImagePress.pointerId) {
          if (
            Math.hypot(event.clientX - mouseImagePress.x, event.clientY - mouseImagePress.y) >
            TERMINAL_TOUCH_DRAG_THRESHOLD_PX
          )
            mouseImagePress.stillATap = false;
          event.stopPropagation();
        }
        return;
      }
      pointerController.handlePointerMove(event);
      if (event.pointerType !== 'mouse' && !nativeCopyField(event.target)) event.stopPropagation();
    });
    listen('pointerup', (event) => {
      if (!eventIsInTerminal(event, true)) return;
      countEvent('pointerEvents', 'pointerup');
      if (selectionOwnsGesture()) return;
      if (mouseImagePress) {
        if (event.pointerId === mouseImagePress.pointerId) {
          if (mouseImagePress.stillATap) onImage?.(mouseImagePress.image);
          mouseImagePress = null;
          if (event.cancelable) event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      const field = nativeCopyField(event.target);
      nativeTapEnded = Boolean(field) && pointerController.getState() === 'pending';
      pointerController.handlePointerUp(event);
      if (event.pointerType !== 'mouse' && !field) event.stopPropagation();
    });
    listen('pointercancel', (event) => {
      if (!eventIsInTerminal(event, true)) return;
      countEvent('pointerEvents', 'pointercancel');
      if (mouseImagePress?.pointerId === event.pointerId) mouseImagePress = null;
      pointerController.handlePointerCancel(event);
      // Native selection commonly cancels the pointer stream when handles open.
      if (event.pointerType !== 'mouse' && !nativeCopyField(event.target)) event.stopPropagation();
    });

    if (hasTouchEvents) {
      const suppressNativeTouch = (event: TouchEvent) => {
        if (!eventIsInTerminal(event, true)) return;
        debug?.((previous) => ({ ...previous, touchEvents: previous.touchEvents + 1 }));
        if (nativeCopyField(event.target)) {
          // A completed tap must not refocus the read-only field after xterm.
          if (
            event.type === 'touchend' &&
            nativeTapEnded &&
            !nativeCopySelection(container) &&
            event.cancelable
          )
            event.preventDefault();
          if (event.type === 'touchend' || event.type === 'touchcancel') nativeTapEnded = false;
          return;
        }
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
      };
      for (const name of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) {
        listen(name, suppressNativeTouch);
      }
    }
  } else {
    listen('touchstart', (event) => {
      if (!eventIsInTerminal(event)) return;
      countEvent('touchEvents', 'touchstart');
      if (selectionOwnsGesture()) return;
      if (event.touches.length === 1 && !nativeCopyField(event.target)) event.stopPropagation();
      pointerController.handleTouchStart(event, container);
    });
    listen('touchmove', (event) => {
      if (!eventIsInTerminal(event, true)) return;
      countEvent('touchEvents', 'touchmove');
      if (selectionOwnsGesture()) return;
      if (event.touches.length === 1 && !nativeCopyField(event.target)) event.stopPropagation();
      pointerController.handleTouchMove(event);
    });
    listen('touchend', (event) => {
      if (!eventIsInTerminal(event, true)) return;
      countEvent('touchEvents', 'touchend');
      if (selectionOwnsGesture()) return;
      if (!nativeCopyField(event.target)) event.stopPropagation();
      pointerController.handleTouchEnd(event);
    });
    listen('touchcancel', (event) => {
      if (!eventIsInTerminal(event, true)) return;
      countEvent('touchEvents', 'touchcancel');
      pointerController.handleTouchCancel();
      if (!nativeCopyField(event.target)) event.stopPropagation();
    });
  }

  const onContextMenu = (event: MouseEvent) => {
    if (!nativeCopyField(event.target)) event.preventDefault();
  };
  container.addEventListener('contextmenu', onContextMenu);
  detachInput.push(() => container.removeEventListener('contextmenu', onContextMenu));
  return () => {
    pointerController.handlePointerCancel();
    for (const detach of detachInput) detach();
  };
}
