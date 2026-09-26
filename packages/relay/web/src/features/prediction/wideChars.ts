/**
 * Cell widths for characters that predictive echo is willing to draw.
 *
 * Predicting a character means guessing how many cells the remote program
 * will give it. For printable ASCII that is always one. For CJK ideographs,
 * kana, Hangul and fullwidth forms, xterm (Unicode 11), Herdr's libghostty
 * pane emulator and Ink-based agents all agree on two, which was checked on
 * captured Herdr screens. Everything else — emoji, combining marks,
 * ambiguous-width symbols — is where those three disagree, so it returns 0
 * and the predictor stands down instead of drawing a character in the wrong
 * place.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3000, 0x3029], // ideographic space, CJK punctuation (3030 and 303D are emoji-capable)
  [0x302e, 0x302f],
  [0x3031, 0x303c],
  [0x303e, 0x303e],
  [0x3041, 0x3096], // hiragana (3099-309A are combining marks)
  [0x309b, 0x30ff], // katakana
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xff01, 0xff60], // fullwidth ASCII variants and punctuation
  [0xffe0, 0xffe6], // fullwidth currency and signs
  [0x20000, 0x2fffd], // CJK extensions B-F
  [0x30000, 0x3fffd], // CJK extension G and later
];

export type PredictableWidth = 0 | 1 | 2;

export function predictableWidth(codePoint: number): PredictableWidth {
  if (codePoint >= 0x20 && codePoint <= 0x7e) return 1;
  if (codePoint < 0x3000) return 0;
  for (const [start, end] of WIDE_RANGES) {
    if (codePoint < start) return 0;
    if (codePoint <= end) return 2;
  }
  return 0;
}
