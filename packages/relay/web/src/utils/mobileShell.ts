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
import { getViewportWidth, MOBILE_BREAKPOINT_PX } from './terminalLayout';

/**
 * Widest phone viewport still treated as a phone. A phone in landscape
 * (≈844px on current handsets) stays under it; a wider tablet does not.
 */
export const MOBILE_SHELL_MAX_WIDTH_PX = 900;

export function isMobileShellViewport(): boolean {
  if (typeof window === 'undefined') return false;

  const width = getViewportWidth();
  // Too narrow for the desktop header regardless of what is pointing at it.
  // Keep the same width-only rule through the landscape-phone band: desktop
  // mode and touch laptops may report a fine pointer, but must not expose a
  // header whose right-side actions can cover the view switcher.
  if (width < MOBILE_BREAKPOINT_PX) return true;
  return width <= MOBILE_SHELL_MAX_WIDTH_PX;
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
