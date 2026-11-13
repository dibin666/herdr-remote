import type React from 'react';
import { useCallback, useRef } from 'react';

/**
 * The pull-down-to-dismiss gesture every bottom sheet on the phone shell
 * shares. Pass the ref the sheet element already carries — the caller often
 * has other uses for it (focusing the sheet, for one). Attach the handlers to
 * the sheet's handle strip; 64px of downward travel commits the close, less
 * snaps back.
 */
export function useSheetDragClose<T extends HTMLElement>(
  onClose: () => void,
  sheetRef: React.RefObject<T | null>,
) {
  const dragStartYRef = useRef<number | null>(null);
  const sheetDragRef = useRef(0);

  const onTouchStart = useCallback((event: React.TouchEvent) => {
    dragStartYRef.current = event.touches[0]?.clientY ?? null;
    sheetDragRef.current = 0;
  }, []);

  const onTouchMove = useCallback(
    (event: React.TouchEvent) => {
      if (dragStartYRef.current === null) return;
      const dy = (event.touches[0]?.clientY ?? 0) - dragStartYRef.current;
      sheetDragRef.current = Math.max(0, dy);
      if (sheetRef.current && dy > 0) {
        sheetRef.current.style.transform = `translateY(${dy}px)`;
      }
    },
    [sheetRef],
  );

  const onTouchEnd = useCallback(() => {
    const dy = sheetDragRef.current;
    dragStartYRef.current = null;
    sheetDragRef.current = 0;
    if (sheetRef.current) sheetRef.current.style.transform = '';
    if (dy > 64) onClose();
  }, [onClose, sheetRef]);

  return { onTouchStart, onTouchMove, onTouchEnd };
}
