import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { DOMElement } from 'ink';
import type { MouseEvent } from './protocol.js';
import type { MouseSource } from './source.js';

export type { MouseEvent } from './protocol.js';
export { createMouseSource, type MouseSource } from './source.js';
export { splitMouseInput, createMouseSplitter } from './protocol.js';

export type Rect = { left: number; top: number; width: number; height: number };

/**
 * Absolute position of an element, in 1-based terminal coordinates.
 *
 * Yoga reports each node's offset relative to its parent, so the walk up the
 * tree accumulates them. The +1 converts to terminal coordinates, which is only
 * correct because the app owns the alternate screen and therefore starts at
 * row 1 — rendering below a shell prompt would shift every row.
 */
export function measureElement(node: DOMElement | null): Rect | null {
  if (!node?.yogaNode) return null;
  const layout = node.yogaNode.getComputedLayout();
  let left = 0;
  let top = 0;
  let current: DOMElement | undefined = node;
  while (current?.yogaNode) {
    const own = current.yogaNode.getComputedLayout();
    left += own.left;
    top += own.top;
    current = current.parentNode ?? undefined;
  }
  return { left: left + 1, top: top + 1, width: layout.width, height: layout.height };
}

/**
 * Half-open containment: a row-N item owns row N and nothing else.
 *
 * The inclusive test used by @ink-tools/ink-mouse (`y <= top + height`) makes
 * every one-row item also claim the row below it, so two neighbours fire for a
 * single click and the selection lands on the wrong one.
 */
export function rectContains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.left && x < rect.left + rect.width
    && y >= rect.top && y < rect.top + rect.height;
}

type Target = {
  ref: RefObject<DOMElement | null>;
  onClick?: () => void;
  onHover?: (hovered: boolean) => void;
};

type MouseState = {
  supported: boolean;
  enabled: boolean;
  enable: () => void;
  disable: () => void;
};

// Two contexts on purpose: the registry must stay referentially stable, or
// every hover would re-run the registration effect of every target on screen.
const MouseRegistryContext = createContext<{ register: (target: Target) => () => void } | null>(null);
const MouseStateContext = createContext<MouseState | null>(null);

export function MouseProvider({ source, children }: { source: MouseSource | null; children: React.ReactNode }) {
  const targets = useRef(new Set<Target>());
  const pressed = useRef<Target | null>(null);
  const [hovered, setHovered] = useState<Target | null>(null);
  const [enabled, setEnabled] = useState(false);

  const register = useCallback((target: Target) => {
    targets.current.add(target);
    return () => {
      targets.current.delete(target);
      if (pressed.current === target) pressed.current = null;
      setHovered((current) => (current === target ? null : current));
    };
  }, []);

  /** The innermost registered element under the pointer. */
  const hitTest = useCallback((x: number, y: number): Target | null => {
    let best: Target | null = null;
    let bestArea = Number.POSITIVE_INFINITY;
    for (const target of targets.current) {
      const rect = measureElement(target.ref.current);
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      if (!rectContains(rect, x, y)) continue;
      const area = rect.width * rect.height;
      if (area < bestArea) {
        best = target;
        bestArea = area;
      }
    }
    return best;
  }, []);

  useEffect(() => {
    if (!source) return undefined;
    return source.subscribe((event: MouseEvent) => {
      if (event.type === 'wheel') return;
      const target = hitTest(event.x, event.y);

      if (event.type === 'move') {
        // Only re-render when the pointer actually crosses into a different
        // element; any-motion tracking fires on every cell otherwise.
        setHovered((current) => (current === target ? current : target));
        return;
      }
      if (event.type === 'press') {
        if (event.button !== 'left') return;
        pressed.current = target;
        setHovered(target);
        return;
      }
      // Release: a click counts only when press and release share a target,
      // so dragging off a row cancels it the way a button should.
      if (pressed.current && pressed.current === target) target?.onClick?.();
      pressed.current = null;
    });
  }, [source, hitTest]);

  useEffect(() => {
    const previous = hovered;
    previous?.onHover?.(true);
    return () => previous?.onHover?.(false);
  }, [hovered]);

  const enable = useCallback(() => {
    if (!source) return;
    source.enable();
    setEnabled(source.isEnabled());
  }, [source]);

  const disable = useCallback(() => {
    if (!source) return;
    source.disable();
    setEnabled(source.isEnabled());
  }, [source]);

  const registry = useMemo(() => ({ register }), [register]);
  const state = useMemo<MouseState>(() => ({
    supported: Boolean(source?.supported),
    enabled,
    enable,
    disable,
  }), [source, enabled, enable, disable]);

  return (
    <MouseRegistryContext.Provider value={registry}>
      <MouseStateContext.Provider value={state}>{children}</MouseStateContext.Provider>
    </MouseRegistryContext.Provider>
  );
}

const KEYBOARD_ONLY: MouseState = {
  supported: false,
  enabled: false,
  enable: () => {},
  disable: () => {},
};

export function useMouse(): MouseState {
  // Tests mount screens without a provider; degrade to keyboard only rather
  // than crash the interface.
  return useContext(MouseStateContext) ?? KEYBOARD_ONLY;
}

/**
 * Make an element clickable and hoverable.
 *
 * Returns whether the pointer is currently over it, so callers can highlight
 * without tracking mouse state themselves.
 */
export function useMouseTarget(
  ref: RefObject<DOMElement | null>,
  { onClick, disabled = false }: { onClick?: () => void; disabled?: boolean } = {},
): boolean {
  const context = useContext(MouseRegistryContext);
  const [hovered, setHovered] = useState(false);
  const handler = useRef(onClick);
  handler.current = onClick;

  const target = useMemo<Target>(() => ({
    ref,
    onClick: () => handler.current?.(),
    onHover: setHovered,
  }), [ref]);

  useEffect(() => {
    if (!context || disabled) return undefined;
    return context.register(target);
  }, [context, target, disabled]);

  useEffect(() => {
    if (disabled) setHovered(false);
  }, [disabled]);

  return hovered && !disabled;
}
