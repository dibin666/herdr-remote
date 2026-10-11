// The floating keyboard button: with the "button" keyboard trigger, a tap on
// the input row shows it beside the cursor, and only tapping it opens the IME.

import type { Terminal } from '@xterm/xterm';
import type React from 'react';
import { type RefObject, useCallback, useEffect, useState } from 'react';
import { type OfferBox, placeKeyboardOffer, readOfferGrid } from './keyboardOffer';
import { measureCellDimensions } from './terminalFit';

const sameBox = (a: OfferBox | null, b: OfferBox) =>
  a !== null && a.row === b.row && a.col === b.col && a.rows === b.rows && a.cols === b.cols;

export function useKeyboardOffer({
  termRef,
  enabled,
  onOpen,
}: {
  termRef: RefObject<Terminal | null>;
  enabled: boolean;
  onOpen?: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const [box, setBox] = useState<OfferBox | null>(null);

  const offer = useCallback(() => setVisible(true), []);
  const dismiss = useCallback(() => setVisible(false), []);

  useEffect(() => {
    if (!enabled) setVisible(false);
  }, [enabled]);

  // Follow the cursor while shown: output keeps moving it, and a box chosen
  // for the previous frame may sit on text this one drew.
  useEffect(() => {
    const term = termRef.current;
    if (!visible || !term) {
      setBox(null);
      return;
    }
    const place = () => {
      const grid = readOfferGrid(term);
      const next = grid ? placeKeyboardOffer(grid) : null;
      if (!next) {
        setVisible(false);
        return;
      }
      setBox((previous) => (sameBox(previous, next) ? previous : next));
    };
    place();
    const renderDispose = term.onRender(place);
    // The keyboard came up some other way; the button has nothing left to do.
    const textarea = term.textarea;
    textarea?.addEventListener('focus', dismiss);
    return () => {
      renderDispose.dispose();
      textarea?.removeEventListener('focus', dismiss);
    };
  }, [visible, termRef, dismiss]);

  const open = useCallback(() => {
    setVisible(false);
    try {
      termRef.current?.focus();
    } catch {
      // A disposed terminal has nothing to type into.
    }
    onOpen?.();
  }, [termRef, onOpen]);

  return { box: visible ? box : null, offer, dismiss, open };
}

export const KeyboardOfferButton: React.FC<{
  term: Terminal | null;
  surface: HTMLElement | null;
  main: HTMLElement | null;
  box: OfferBox;
  label: string;
  onOpen: () => void;
}> = ({ term, surface, main, box, label, onOpen }) => {
  if (!term || !main) return null;
  const cell = measureCellDimensions(term);
  const screenEl = (surface?.querySelector('.xterm-screen') as HTMLElement | null) || surface;
  if (!screenEl) return null;
  const screenRect = screenEl.getBoundingClientRect();
  const mainRect = main.getBoundingClientRect();

  // Inset by a pixel so the outline stays inside the blank cells it was given.
  return (
    <button
      type="button"
      data-testid="keyboard-offer"
      aria-label={label}
      title={label}
      onClick={onOpen}
      className="absolute z-30 flex select-none items-center justify-center rounded-sm border border-tui-accent/50 bg-tui-mantle/60 p-0 text-tui-accent opacity-80 backdrop-blur-[1px] active:opacity-100"
      style={{
        left: `${screenRect.left - mainRect.left + box.col * cell.cellWidth + 1}px`,
        top: `${screenRect.top - mainRect.top + box.row * cell.cellHeight + 1}px`,
        width: `${box.cols * cell.cellWidth - 2}px`,
        height: `${box.rows * cell.cellHeight - 2}px`,
        touchAction: 'manipulation',
      }}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="h-[80%] max-h-5 w-auto"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        <rect x="2.5" y="6" width="19" height="12" rx="1.5" />
        <path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M8 14h8" />
      </svg>
    </button>
  );
};
