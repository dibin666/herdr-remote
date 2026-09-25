// The notices at the bottom of the screen: repeats collapse into one, and each
// leaves a few seconds after it last fired.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface ToastItem {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  message: string;
  timestamp: number;
  /**
   * How many times this exact notice has fired while it was on screen. A
   * viewer-mode warning is raised per keystroke, so without collapsing repeats
   * a single sentence typed after releasing control buries the terminal.
   */
  count: number;
}

/** How long a notice stays up, counted from its most recent repeat. */
export const TOAST_DISMISS_MS = 4000;
/** Distinct notices on screen at once; the oldest is dropped past this. */
export const MAX_VISIBLE_TOASTS = 3;

export function useToastQueue() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // The live list is held in a ref as well as in state: `addToast` can fire many
  // times between two renders (once per keystroke), and a reducer reading stale
  // state would miss the entry it is supposed to be collapsing into.
  const toastListRef = useRef<ToastItem[]>([]);
  const toastTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const commitToasts = useCallback((next: ToastItem[]) => {
    toastListRef.current = next;
    setToasts(next);
  }, []);

  const removeToast = useCallback(
    (id: string) => {
      const timer = toastTimersRef.current.get(id);
      if (timer) {
        clearTimeout(timer);
        toastTimersRef.current.delete(id);
      }
      commitToasts(toastListRef.current.filter((item) => item.id !== id));
    },
    [commitToasts],
  );

  const addToast = useCallback(
    (type: ToastItem['type'], message: string) => {
      const now = Date.now();
      const current = toastListRef.current;
      const existing = current.find((item) => item.type === type && item.message === message);
      const id = existing ? existing.id : `${now}-${Math.random().toString(36).substring(2, 6)}`;

      let next: ToastItem[];
      if (existing) {
        next = current.map((item) =>
          item.id === id ? { ...item, count: item.count + 1, timestamp: now } : item,
        );
      } else {
        next = [...current, { id, type, message, timestamp: now, count: 1 }];
        // Whatever falls off the end has to give up its dismissal timer too, or
        // it would keep matching as "already on screen" after it is gone.
        while (next.length > MAX_VISIBLE_TOASTS) {
          const [dropped, ...rest] = next;
          const timer = toastTimersRef.current.get(dropped.id);
          if (timer) {
            clearTimeout(timer);
            toastTimersRef.current.delete(dropped.id);
          }
          next = rest;
        }
      }

      commitToasts(next);

      // Each repeat restarts the countdown, so a burst clears once it stops.
      const running = toastTimersRef.current.get(id);
      if (running) clearTimeout(running);
      toastTimersRef.current.set(
        id,
        setTimeout(() => removeToast(id), TOAST_DISMISS_MS),
      );
    },
    [commitToasts, removeToast],
  );

  useEffect(() => {
    const timers = toastTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return { toasts, addToast, removeToast };
}
