// What touch input needs from xterm beyond its public API: whether a program
// has mouse reporting on, the active buffer's position, the core services
// that inject mouse reports and key data, and synthetic DOM mouse events.

import type { Terminal } from '@xterm/xterm';

/** Minimal shape the gesture machine needs from a touch or pointer event. */
export interface GesturePoint {
  clientX: number;
  clientY: number;
}

/** Anything that can suppress the browser's default handling of a gesture. */
export interface CancellableEvent {
  cancelable?: boolean;
  preventDefault?: () => void;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export interface CoreMouseEvent {
  col: number;
  row: number;
  x: number;
  y: number;
  button: number;
  action: number;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface CoreMouseService {
  triggerMouseEvent: (event: CoreMouseEvent) => boolean;
}

export interface CoreService {
  triggerDataEvent: (data: string, wasUserInput?: boolean) => void;
  decPrivateModes?: { applicationCursorKeys?: boolean };
}

export type ScrollMode = 'buffer' | 'application-mouse' | 'application-keys' | 'none';

export type ActiveBuffer = {
  type?: 'normal' | 'alternate';
  baseY?: number;
  cursorY?: number;
  viewportY?: number;
  hasScrollback?: boolean;
};

/**
 * Check whether xterm terminal has mouse tracking enabled by a running program (e.g. htop, tmux, vim)
 */
export function isMouseTrackingActive(term: Terminal | null): boolean {
  if (!term) return false;
  try {
    // xterm 5+ modes object
    const modes = (term as unknown as { modes?: { mouseTrackingMode?: string } }).modes;
    if (
      modes &&
      typeof modes.mouseTrackingMode === 'string' &&
      modes.mouseTrackingMode !== 'none'
    ) {
      return true;
    }

    // Fallback to internal core mouse service if accessible
    const core = (
      term as unknown as {
        _core?: {
          _coreMouseService?: { areMouseEventsActive?: boolean };
          coreMouseService?: { areMouseEventsActive?: boolean };
          mouseMode?: string;
        };
      }
    )._core;

    if (
      core?._coreMouseService?.areMouseEventsActive ||
      core?.coreMouseService?.areMouseEventsActive
    ) {
      return true;
    }
    if (core?.mouseMode && core.mouseMode !== 'none') {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * Create a synthetic MouseEvent with proper coordinates and button states
 */
export function createSyntheticMouseEvent(
  type: 'mousedown' | 'mousemove' | 'mouseup',
  coords: { clientX: number; clientY: number; button?: number; buttons?: number },
): MouseEvent {
  const button = coords.button ?? 0;
  const buttons = coords.buttons ?? (type === 'mouseup' ? 0 : 1);

  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: coords.clientX,
    clientY: coords.clientY,
    screenX: coords.clientX,
    screenY: coords.clientY,
    button,
    buttons,
  });
}

/**
 * Dispatch a synthetic MouseEvent on the target DOM element
 */
export function dispatchSyntheticMouseEvent(
  target: EventTarget,
  type: 'mousedown' | 'mousemove' | 'mouseup',
  coords: { clientX: number; clientY: number; button?: number; buttons?: number },
): boolean {
  const event = createSyntheticMouseEvent(type, coords);
  return target.dispatchEvent(event);
}

export function getActiveBuffer(term: Terminal): ActiveBuffer | null {
  try {
    return (term as unknown as { buffer?: { active?: ActiveBuffer } }).buffer?.active || null;
  } catch {
    return null;
  }
}

export function getViewportY(term: Terminal): number | null {
  const viewportY = getActiveBuffer(term)?.viewportY;
  return typeof viewportY === 'number' && Number.isFinite(viewportY) ? viewportY : null;
}

export function blurTerminal(term: Terminal): void {
  try {
    (term as unknown as { blur?: () => void }).blur?.();
  } catch {
    // A test double or an older xterm build may not expose blur().
  }
}

export function getCoreMouseService(term: Terminal): CoreMouseService | null {
  const candidate = term as unknown as {
    coreMouseService?: CoreMouseService;
    _core?: {
      coreMouseService?: CoreMouseService;
      _coreMouseService?: CoreMouseService;
    };
  };

  return (
    candidate.coreMouseService ||
    candidate._core?.coreMouseService ||
    candidate._core?._coreMouseService ||
    null
  );
}

export function getCoreService(term: Terminal): CoreService | null {
  const candidate = term as unknown as {
    coreService?: CoreService;
    _core?: { coreService?: CoreService };
  };
  return candidate.coreService || candidate._core?.coreService || null;
}
