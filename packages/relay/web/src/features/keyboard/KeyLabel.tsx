// What a key cap says, with its symbols drawn as Nerd Font icons.

import type React from 'react';

/**
 * Solid icons from the interface face, Maple Mono NF CN (bundled, so every
 * device has them). Text arrows like `←` come from whatever font a device
 * falls back to and were thin, outlined and a different size on each phone.
 *
 * `box` is the glyph's outline in font units (xMin, xMax, yMin, yMax), read
 * from the font. Nerd Font glyphs are drawn at very different sizes — a menu
 * caret is a third the height of an arrow — so each one is scaled and centred
 * from its own outline, and every icon on the bar comes out the same size.
 */
const KEY_ICONS = {
  left: { glyph: '\u{F0731}', box: [0, 660, 34, 686] }, // nf-md-arrow_left_bold
  up: { glyph: '\u{F0737}', box: [0, 652, 30, 690] }, // nf-md-arrow_up_bold
  down: { glyph: '\u{F072E}', box: [0, 652, 30, 690] }, // nf-md-arrow_down_bold
  right: { glyph: '\u{F0734}', box: [0, 660, 34, 686] }, // nf-md-arrow_right_bold
  enter: { glyph: '\u{F17A6}', box: [0, 709, -36, 756] }, // nf-md-arrow_left_bottom_bold
  backspace: { glyph: '\u{F006E}', box: [0, 1000, -15, 735] }, // nf-md-backspace
  shift: { glyph: '\u{F0636}', box: [0, 832, 26, 694] }, // nf-md-apple_keyboard_shift
  open: { glyph: '\u{F0360}', box: [91, 509, 256, 464] }, // nf-md-menu_up
  close: { glyph: '\u{F035D}', box: [91, 509, 256, 464] }, // nf-md-menu_down
  image: { glyph: '\u{F02E9}', box: [0, 750, -15, 735] }, // nf-md-image
  customize: { glyph: '\u{F066A}', box: [0, 750, -15, 735] }, // nf-md-tune_vertical
  admin: { glyph: '\u{F088F}', box: [0, 750, -99, 819] }, // nf-md-shield_account
} as const;

export type KeyIconName = keyof typeof KEY_ICONS;

const ICON_FOR_SYMBOL: Record<string, KeyIconName> = {
  '←': 'left',
  '↑': 'up',
  '↓': 'down',
  '→': 'right',
  '⏎': 'enter',
  '⌫': 'backspace',
  '⇧': 'shift',
};

/** The longer side of every icon, as a share of the text size. */
const ICON_EM = 0.9;
/** Maple's baseline below the top of a `line-height: 1` box: (1 + ascent 1.02 − descent 0.3) / 2. */
const BASELINE_EM = 0.86;
const UNITS_PER_EM = 1000;

function iconStyle([xMin, xMax, yMin, yMax]: readonly number[]): React.CSSProperties {
  const scale = (ICON_EM * UNITS_PER_EM) / Math.max(xMax - xMin, yMax - yMin);
  const centreX = (xMin + xMax) / 2 / UNITS_PER_EM;
  const centreY = BASELINE_EM - (yMin + yMax) / 2 / UNITS_PER_EM;
  return {
    fontSize: `${scale}em`,
    left: `${(0.5 - scale * centreX) * 100}%`,
    top: `${(0.5 - scale * centreY) * 100}%`,
  };
}

/** One icon in a 1em square, the glyph's outline centred in it. */
export function KeyIcon({ name }: { name: KeyIconName }) {
  const icon = KEY_ICONS[name];
  return (
    <span
      aria-hidden="true"
      data-key-icon={name}
      className="relative inline-block size-[1em] shrink-0 overflow-visible"
    >
      <span className="absolute leading-none" style={iconStyle(icon.box)}>
        {icon.glyph}
      </span>
    </span>
  );
}

/** A caption such as `⇧TAB` or `Alt+⏎`, its key symbols drawn as icons. */
export function KeyLabel({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center">
      {[...text].map((char, index) => {
        const icon = ICON_FOR_SYMBOL[char];
        // biome-ignore lint/suspicious/noArrayIndexKey: a caption's characters never reorder
        return icon ? <KeyIcon key={index} name={icon} /> : char;
      })}
    </span>
  );
}
