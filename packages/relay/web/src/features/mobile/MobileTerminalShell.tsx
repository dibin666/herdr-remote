import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSettings, useTerminalIO } from '@/context/TerminalContext';
import { FileListModal } from '@/features/files/FileListModal';
import { PasteFallbackModal } from '@/features/paste/PasteFallbackModal';
import { MobileControlSheet } from './MobileControlSheet';
import { MobileStatusBar } from './MobileStatusBar';
import { useSheetDragClose } from './sheetDrag';

export interface MobileTerminalShellProps {
  onOpenSettings: () => void;
  onAddProfile?: () => void;
}

/**
 * The phone shell: the terminal owns the whole screen from the top edge, and
 * every piece of chrome lives in one bottom dock — a compact status bar with
 * the menu trigger under the thumb, plus a sheet holding everything else.
 */
export const MobileTerminalShell: React.FC<MobileTerminalShellProps> = ({
  onOpenSettings,
  onAddProfile = () => {},
}) => {
  const { t } = useSettings();
  const { sendKey } = useTerminalIO();
  const [isOpen, setIsOpen] = useState(false);
  /* The dialogs the sheet's quick actions open. They are kept here, not in the
     sheet, so the sheet can get out of the way when one opens: left up, it
     covered the terminal the paste had just gone into. */
  const [pasteOpen, setPasteOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);

  const close = useCallback(() => setIsOpen(false), []);

  /* A bottom sheet lets go the way a thumb expects: grabbed by its handle and
     pulled down. 64px of downward travel commits the close; less snaps back. */
  const sheetRef = useRef<HTMLDivElement>(null);
  const { onTouchStart, onTouchMove, onTouchEnd } = useSheetDragClose(close, sheetRef);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // With any modifier (Ctrl, Alt, Meta), NEVER intercept or stopPropagation/preventDefault
      if (event.ctrlKey || event.altKey || event.metaKey) {
        return;
      }
      if (event.key === 'Escape') {
        const target = event.target as Element | null;
        const isFromTerminal =
          target &&
          typeof target.closest === 'function' &&
          Boolean(target.closest('#terminal-container'));

        if (!isFromTerminal) {
          event.stopPropagation();
          event.preventDefault();
          close();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, close]);

  useEffect(() => {
    // `preventScroll`, because focusing a sheet pinned to the bottom of a phone
    // screen otherwise asks the browser to scroll it into view — and the page
    // visibly jumps to satisfy a request nothing needed.
    if (isOpen) sheetRef.current?.focus({ preventScroll: true });
  }, [isOpen]);

  return (
    <>
      {isOpen && (
        <>
          <div
            data-testid="mobile-sheet-scrim"
            className="absolute inset-0 z-40 bg-tui-crust/70"
            onClick={close}
            aria-hidden="true"
          />

          <div
            ref={sheetRef}
            data-testid="mobile-control-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={t('mobile.sessionControls')}
            tabIndex={-1}
            className="herdr-sheet absolute inset-x-0 bottom-0 z-50 max-h-[85%] overflow-y-auto border-t border-tui-border bg-tui-base pb-3 focus:outline-none"
          >
            {/* The grab strip: pulling it down closes the sheet, the gesture
                every other bottom sheet on the phone already taught. */}
            <div
              data-testid="mobile-sheet-handle"
              aria-hidden="true"
              className="flex touch-none items-start justify-center pb-1 pt-1.5"
              onTouchStart={onTouchStart}
              onTouchMove={onTouchMove}
              onTouchEnd={onTouchEnd}
              onTouchCancel={onTouchEnd}
            >
              <span className="h-1 w-9 bg-tui-border-bright" />
            </div>
            <MobileControlSheet
              onClose={close}
              onOpenSettings={() => {
                close();
                onOpenSettings();
              }}
              onOpenPaste={() => {
                close();
                setPasteOpen(true);
              }}
              onOpenFiles={() => {
                close();
                setFilesOpen(true);
              }}
            />
          </div>
        </>
      )}
      <MobileStatusBar
        onAddProfile={onAddProfile}
        onOpenMenu={() => setIsOpen(true)}
        menuOpen={isOpen}
      />
      <PasteFallbackModal
        isOpen={pasteOpen}
        allowImage={false}
        onClose={() => setPasteOpen(false)}
        onSend={(text) => sendKey(text)}
      />
      <FileListModal isOpen={filesOpen} onClose={() => setFilesOpen(false)} />
    </>
  );
};
