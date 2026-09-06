/**
 * Terminal Layout & Typography Utilities
 */

export const MIN_DESKTOP_FONT_SIZE = 10;
export const MAX_DESKTOP_FONT_SIZE = 24;
export const DEFAULT_DESKTOP_FONT_SIZE = 15;
export const DEFAULT_MOBILE_FONT_SIZE = 13;

/** Viewport width below which the mobile typography band and layout apply. */
export const MOBILE_BREAKPOINT_PX = 640;

/**
 * Whether this device is driven by a finger rather than a mouse.
 *
 * Renderer choice and input handling key off this rather than viewport width
 * alone: a narrow desktop window still has a precise pointer and a working GPU,
 * while a wide tablet does not.
 */
export function isCoarsePointerDevice(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (typeof window.matchMedia === 'function') {
      if (window.matchMedia('(pointer: coarse)').matches) return true;
      if (window.matchMedia('(hover: none)').matches) return true;
    }
  } catch {
    // matchMedia can throw on malformed queries in old engines; fall through.
  }
  return getViewportWidth() < MOBILE_BREAKPOINT_PX;
}

/**
 * Get reliable viewport width
 */
export function getViewportWidth(): number {
  if (typeof window === 'undefined') return 1024;
  if (window.visualViewport && typeof window.visualViewport.width === 'number' && window.visualViewport.width > 0) {
    return window.visualViewport.width;
  }
  return window.innerWidth || 1024;
}

/**
 * Get reliable viewport height. Used as a fallback when the terminal container
 * has not been laid out yet (clientHeight === 0), so the mobile grid never
 * collapses to zero rows.
 */
export function getViewportHeight(): number {
  if (typeof window === 'undefined') return 768;
  if (
    window.visualViewport &&
    typeof window.visualViewport.height === 'number' &&
    window.visualViewport.height > 0
  ) {
    return window.visualViewport.height;
  }
  return window.innerHeight || 768;
}

/**
 * Validates and clamps a raw font size into safe bounds [10, 24] for desktop settings
 */
export function clampFontSize(fontSize: unknown, fallback = DEFAULT_DESKTOP_FONT_SIZE): number {
  const numeric = typeof fontSize === 'number' ? fontSize : Number(fontSize);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.min(MAX_DESKTOP_FONT_SIZE, Math.max(MIN_DESKTOP_FONT_SIZE, Math.round(numeric)));
}

/**
 * Resolves the terminal base font size:
 * - On desktop (>= 640px): user customized font size clamped to [10, 24]
 * - On mobile (< 640px): stable base font size (13px, or user base clamped to [12, 15])
 *   Fitting to mobile screen is handled via Orca-style CSS scale on the terminal surface.
 */
export function getEffectiveTerminalFontSize(
  userFontSize: number,
  viewportWidth: number = getViewportWidth()
): number {
  const isMobile = viewportWidth < MOBILE_BREAKPOINT_PX;
  if (isMobile) {
    const clamped = clampFontSize(userFontSize, DEFAULT_MOBILE_FONT_SIZE);
    return Math.min(15, Math.max(12, clamped));
  }
  return clampFontSize(userFontSize, DEFAULT_DESKTOP_FONT_SIZE);
}
