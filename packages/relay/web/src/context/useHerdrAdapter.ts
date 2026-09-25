// The relay client for this window, created once, with every event routed to
// the handlers of the latest render.

import { type RefObject, useRef } from 'react';
import { type AdapterEventMap, HerdrClientAdapter } from '../protocol/clientAdapter';
import type { ConnectionConfig } from '../types/connection';

export type AdapterHandlers = { [K in keyof AdapterEventMap]?: AdapterEventMap[K] };

/**
 * The adapter is constructed and wired during the first render, not from an
 * effect, so nothing it reports can arrive before a handler is listening.
 * Handlers are read at call time, so they always see the current render's
 * state and never need to be re-bound.
 */
export function useHerdrAdapter(
  adapterRef: RefObject<HerdrClientAdapter | null>,
  createConfig: () => ConnectionConfig,
  handlers: AdapterHandlers,
): HerdrClientAdapter {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  if (!adapterRef.current) {
    const adapter = new HerdrClientAdapter(createConfig());
    for (const event of Object.keys(handlers) as (keyof AdapterEventMap)[]) {
      const route = (...args: unknown[]) =>
        (handlersRef.current[event] as ((...values: unknown[]) => void) | undefined)?.(...args);
      adapter.on(event, route as AdapterEventMap[typeof event]);
    }
    adapterRef.current = adapter;
  }
  return adapterRef.current;
}
