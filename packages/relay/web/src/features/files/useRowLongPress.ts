// A finger held on a file row: after half a second without moving it opens
// the row's menu, where a mouse would have right-clicked.

import type React from 'react';
import { useRef } from 'react';

const LONG_PRESS_MS = 500;
/** Further than this and the finger is scrolling the list. */
const LONG_PRESS_MOVE_PX = 10;
/** A click this soon after a long press lifts is that press ending, not a tap. */
const LONG_PRESS_CLICK_GUARD_MS = 400;

export function useRowLongPress<T>(onLongPress: (x: number, y: number, row: T) => void) {
  const heldRef = useRef<{
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout>;
    fired: boolean;
  } | null>(null);
  const ignoreClickUntilRef = useRef(0);

  const release = () => {
    const held = heldRef.current;
    if (!held) return;
    clearTimeout(held.timer);
    if (held.fired) ignoreClickUntilRef.current = Date.now() + LONG_PRESS_CLICK_GUARD_MS;
    heldRef.current = null;
  };

  return {
    /**
     * The finger lifting from a long press clicks the row it was on. True for
     * that click, which must not also act on the row the menu was opened for.
     */
    isReleaseClick: () => Date.now() < ignoreClickUntilRef.current,
    touchHandlers: (row: T) => ({
      onTouchStart: (e: React.TouchEvent) => {
        const { clientX, clientY } = e.touches[0];
        heldRef.current = {
          x: clientX,
          y: clientY,
          fired: false,
          timer: setTimeout(() => {
            if (heldRef.current) heldRef.current.fired = true;
            onLongPress(clientX, clientY, row);
          }, LONG_PRESS_MS),
        };
      },
      onTouchMove: (e: React.TouchEvent) => {
        const held = heldRef.current;
        if (!held) return;
        const touch = e.touches[0];
        if (Math.hypot(touch.clientX - held.x, touch.clientY - held.y) > LONG_PRESS_MOVE_PX) {
          clearTimeout(held.timer);
          heldRef.current = null;
        }
      },
      onTouchEnd: release,
      onTouchCancel: release,
    }),
  };
}
