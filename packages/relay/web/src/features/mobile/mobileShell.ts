/**
 * Which app shell a viewport gets.
 *
 * The phone shell hands the whole screen to the terminal and folds every other
 * control into a sheet, so it is only an improvement on viewports that cannot
 * carry the desktop chrome: a phone in either orientation, or a window too
 * narrow for the header to fit. Width is the source of truth here; a browser
 * can report a precise pointer in desktop mode or on a touch laptop while the
 * header still physically cannot fit.
 */

import { useEffect, useState } from 'react';
import {
  getViewportWidth,
  isCoarsePointerDevice,
  MOBILE_BREAKPOINT_PX,
} from '@/features/terminal/terminalLayout';

/**
 * Widest viewport the phone shell may still claim — and only with a coarse
 * pointer. A phone in landscape (≈844px on current handsets) stays under it;
 * a wider tablet does not.
 */
export const MOBILE_SHELL_MAX_WIDTH_PX = 900;

export function isMobileShellViewport(): boolean {
  if (typeof window === 'undefined') return false;

  const width = getViewportWidth();
  // Too narrow for the desktop chrome regardless of what is pointing at it.
  if (width < MOBILE_BREAKPOINT_PX) return true;
  // The landscape-phone / small-tablet band: the phone shell only earns its
  // chrome when the pointer is a finger. An iPad with a keyboard or a narrow
  // desktop window keeps the desktop layout, which fits at these widths.
  if (width <= MOBILE_SHELL_MAX_WIDTH_PX) return isCoarsePointerDevice();
  return false;
}

/**
 * Live `isMobileShellViewport()`, re-evaluated on rotation, window resize and a
 * change of primary pointer (a tablet gaining a mouse). The value is read once
 * up front so the first paint is already the right shell — a phone must never
 * flash the desktop header on load.
 */
export function useMobileShell(): boolean {
  const [isMobileShell, setIsMobileShell] = useState(isMobileShellViewport);

  useEffect(() => {
    const sync = () => {
      const next = isMobileShellViewport();
      setIsMobileShell((prev) => (prev === next ? prev : next));
    };

    sync();

    let pointerQuery: MediaQueryList | null = null;
    try {
      pointerQuery =
        typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: coarse)') : null;
    } catch {
      pointerQuery = null;
    }
    pointerQuery?.addEventListener?.('change', sync);

    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', sync);
    window.visualViewport?.addEventListener('resize', sync);

    return () => {
      pointerQuery?.removeEventListener?.('change', sync);
      window.removeEventListener('resize', sync);
      window.removeEventListener('orientationchange', sync);
      window.visualViewport?.removeEventListener('resize', sync);
    };
  }, []);

  return isMobileShell;
}

/**
 * The live viewport width, re-rendered on resize. Status lines and toolbars
 * use it to drop their least-wanted tokens before they are squeezed into
 * overlapping ones.
 */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(getViewportWidth);

  useEffect(() => {
    const sync = () => setWidth(getViewportWidth());
    sync();
    window.addEventListener('resize', sync);
    window.visualViewport?.addEventListener('resize', sync);
    return () => {
      window.removeEventListener('resize', sync);
      window.visualViewport?.removeEventListener('resize', sync);
    };
  }, []);

  return width;
}
