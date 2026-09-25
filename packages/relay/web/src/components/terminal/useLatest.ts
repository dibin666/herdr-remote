import { type RefObject, useRef } from 'react';

/**
 * A ref that always holds this render's `value`. Listeners bound once (xterm's,
 * the document's) read through it instead of closing over a stale render.
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
