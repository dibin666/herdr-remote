/**
 * Floating TUI-styled selection action menu for mobile terminals.
 *
 * Why this exists:
 * Mobile touches cannot directly trigger native copy/paste workflows on xterm DOM rows
 * without unwanted browser scrolling and IME side-effects. This popup provides a thumb-friendly
 * touch target for copying words, lines, full screens, and triggering paste.
 *
 * Critical constraints:
 *   - Strict viewport boundary clamping: The terminal layer is `inset-x-0 top-12 bottom-11`
 *     (App.tsx:257). The menu MUST clamp within the visible container with an 8px margin
 *     and flip vertically above the touch point when needed to prevent being cropped by the
 *     top header or bottom status/keyboard bars.
 *   - Strict uniform height: Every action row is `h-11` (44px) matching MobileControlSheet.
 *   - "复制选中" appears only when an active selection exists (`hasSelection === true`).
 *   - "粘贴" is omitted when `isController === false` to avoid meaningless viewer warnings.
 */

import React, { useLayoutEffect, useRef, useState, useEffect } from 'react';
import { GLYPH, Panel } from './tui';
import { cn } from '../utils/cn';
import { useTerminal } from '../context/TerminalContext';

const actionRowClass =
  'tui-focusable group flex h-11 w-full select-none items-center gap-2 border px-2 text-left text-tui transition-colors';

const idleRowClass =
  'border-tui-border text-tui-muted hover:border-tui-accent hover:text-tui-accent active:bg-tui-selection';

export interface TerminalSelectionMenuProps {
  /** Touch anchor coordinate relative to the terminal main container. */
  anchorPoint: { x: number; y: number };
  /** Whether xterm currently has an active text selection. */
  hasSelection: boolean;
  /** Whether the client holds controller lease. */
  isController: boolean;
  /** Whether vibration on key press is enabled in settings. */
  vibrateOnKeyPress?: boolean;
  onCopySelection: () => void;
  onCopyLine: () => void;
  onCopyScreen: () => void;
  onPaste: () => void;
  onClose: () => void;
}

export const TerminalSelectionMenu: React.FC<TerminalSelectionMenuProps> = ({
  anchorPoint,
  hasSelection,
  isController,
  vibrateOnKeyPress = false,
  onCopySelection,
  onCopyLine,
  onCopyScreen,
  onPaste,
  onClose,
}) => {
  const { t } = useTerminal();
  const menuRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null);

  // Trigger haptic feedback once on open if enabled
  useEffect(() => {
    if (vibrateOnKeyPress && typeof navigator !== 'undefined' && navigator.vibrate) {
      try {
        navigator.vibrate(8);
      } catch {
        // Ignore vibration failure
      }
    }
  }, [vibrateOnKeyPress]);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || !el.parentElement) return;

    const parentRect = el.parentElement.getBoundingClientRect();
    const menuRect = el.getBoundingClientRect();

    const menuWidth = menuRect.width || 208;
    const menuHeight = menuRect.height || 220;
    const containerWidth = parentRect.width;
    const containerHeight = parentRect.height;

    // Horizontal: center over touch point, clamped with 8px margin
    let x = anchorPoint.x - menuWidth / 2;
    x = Math.max(8, Math.min(Math.max(8, containerWidth - menuWidth - 8), x));

    // Vertical: prefer flipping above the touch point so thumb does not cover the menu.
    // Flip below only if there is not enough clearance above.
    let y = anchorPoint.y - menuHeight - 8;
    if (y < 8) {
      y = anchorPoint.y + 8;
    }
    // Hard clamp vertically so it never gets clipped by top-12 or bottom-11 bounds
    y = Math.max(8, Math.min(Math.max(8, containerHeight - menuHeight - 8), y));

    setCoords({ x, y });
  }, [anchorPoint.x, anchorPoint.y, hasSelection, isController]);

  // Initial estimate to avoid off-screen jumping before layout measurement
  const initialX = Math.max(8, anchorPoint.x - 104);
  const initialY = Math.max(8, anchorPoint.y - 200);

  const style: React.CSSProperties = {
    position: 'absolute',
    left: `${coords ? coords.x : initialX}px`,
    top: `${coords ? coords.y : initialY}px`,
    visibility: coords ? 'visible' : 'hidden',
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="终端选择操作"
      className="z-50 w-52 select-none font-mono"
      style={style}
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Panel
        tone="accent"
        className="border border-tui-border bg-tui-base p-1.5 shadow-lg"
        bodyClassName="flex flex-col gap-1"
      >
        {hasSelection && (
          <button
            type="button"
            role="menuitem"
            className={cn(actionRowClass, idleRowClass)}
            onClick={() => {
              onCopySelection();
              onClose();
            }}
          >
            <span aria-hidden="true" className="shrink-0 text-tui-faint group-hover:text-tui-accent">
              {GLYPH.cursor}
            </span>
            <span className="truncate">{t('clipboard.copySelection')}</span>
          </button>
        )}

        <button
          type="button"
          role="menuitem"
          className={cn(actionRowClass, idleRowClass)}
          onClick={() => {
            onCopyLine();
            onClose();
          }}
        >
          <span aria-hidden="true" className="shrink-0 text-tui-faint group-hover:text-tui-accent">
            {GLYPH.cursor}
          </span>
          <span className="truncate">{t('clipboard.copyLine')}</span>
        </button>

        <button
          type="button"
          role="menuitem"
          className={cn(actionRowClass, idleRowClass)}
          onClick={() => {
            onCopyScreen();
            onClose();
          }}
        >
          <span aria-hidden="true" className="shrink-0 text-tui-faint group-hover:text-tui-accent">
            {GLYPH.cursor}
          </span>
          <span className="truncate">{t('clipboard.copyScreen')}</span>
        </button>

        {isController && (
          <button
            type="button"
            role="menuitem"
            className={cn(actionRowClass, idleRowClass)}
            onClick={() => {
              onPaste();
              onClose();
            }}
          >
            <span aria-hidden="true" className="shrink-0 text-tui-faint group-hover:text-tui-accent">
              {GLYPH.cursor}
            </span>
            <span className="truncate">{t('clipboard.paste')}</span>
          </button>
        )}

        <button
          type="button"
          role="menuitem"
          className={cn(actionRowClass, idleRowClass)}
          onClick={onClose}
        >
          <span aria-hidden="true" className="shrink-0 text-tui-faint group-hover:text-tui-accent">
            {GLYPH.cursor}
          </span>
          <span className="truncate">{t('clipboard.cancel')}</span>
        </button>
      </Panel>
    </div>
  );
};
