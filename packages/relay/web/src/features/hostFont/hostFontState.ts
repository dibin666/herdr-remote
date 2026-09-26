// What this window knows about the workstation's terminal font, and the
// helpers that read it.

import type { HostFontSubsetSource, HostTerminalFont } from '@protocol/terminal';
import type {
  isHostFontRegistered,
  readCachedFace,
  readCachedSubsets,
  registerGlyphSubset,
  registerHostFontFaces,
  writeCachedFace,
  writeCachedSubset,
} from './hostFont';
import { wantsGlyph } from './hostFont';

/**
 * Where the workstation's font stands in this window:
 *
 * - `none`: the host reported no font (unknown terminal, older host).
 * - `installed`: this device has the family; it is used by name.
 * - `loaded`: the host's files are registered (fetched now or from cache).
 * - `available`: files are offered and nobody has answered yet — ask.
 * - `declined`: the user chose this device's own fonts for this font.
 * - `loading` / `failed`: a transfer in progress, or one that did not finish.
 * - `unavailable`: no files to fetch (a font collection, or not on disk).
 */
export type HostFontStatus =
  | 'none'
  | 'checking'
  | 'installed'
  | 'loaded'
  | 'available'
  | 'declined'
  | 'loading'
  | 'failed'
  | 'unavailable';

/**
 * The large font (the CJK fallback, usually) this window receives cut to the
 * characters it draws. `ready` means common characters are in and rarer ones
 * are fetched as they appear.
 */
export type HostGlyphStatus =
  | 'none'
  | 'checking'
  | 'installed'
  | 'available'
  | 'declined'
  | 'loading'
  | 'ready'
  | 'failed';

export interface HostGlyphState {
  source: HostFontSubsetSource | null;
  status: HostGlyphStatus;
  /** The FontFace family the cuts are registered under, once one is. */
  alias: string | null;
  /** How many characters this device holds from the source. */
  covered: number;
}

export interface HostFontState {
  font: HostTerminalFont | null;
  status: HostFontStatus;
  /** The FontFace family of the fetched files, once registered. */
  alias: string | null;
  receivedBytes: number;
  totalBytes: number;
  /** A machine-readable reason when `failed`. */
  error: string | null;
  glyphs: HostGlyphState;
  /** A transfer the user started from the prompt, which shows its progress. */
  interactive: boolean;
  /** Bumped whenever glyphs are added under an unchanged family: repaint. */
  glyphRevision: number;
}

/** Seams for tests; the defaults are the real browser APIs. */
export interface HostFontDeps {
  isInstalled?: (family: string) => boolean;
  readCached?: typeof readCachedFace;
  writeCached?: typeof writeCachedFace;
  register?: typeof registerHostFontFaces;
  isRegistered?: typeof isHostFontRegistered;
  readSubsets?: typeof readCachedSubsets;
  writeSubset?: typeof writeCachedSubset;
  registerGlyphs?: typeof registerGlyphSubset;
}

export const NO_GLYPHS: HostGlyphState = { source: null, status: 'none', alias: null, covered: 0 };

export const INITIAL: HostFontState = {
  font: null,
  status: 'none',
  alias: null,
  receivedBytes: 0,
  totalBytes: 0,
  error: null,
  glyphs: NO_GLYPHS,
  interactive: false,
  glyphRevision: 0,
};

/** For a family cut for everything, what a terminal shows besides Hanzi. */
export const COMMON_LATIN_TEXT = String.fromCodePoint(
  ...Array.from({ length: 0x7f - 0x20 }, (_, i) => 0x20 + i),
  ...Array.from({ length: 0x100 - 0xa0 }, (_, i) => 0xa0 + i),
  ...Array.from({ length: 0x2070 - 0x2000 }, (_, i) => 0x2000 + i),
);

/** The cut source this window uses: the family itself over its CJK fallback. */
export function subsetSource(font: HostTerminalFont | null): HostFontSubsetSource | null {
  const sources = font?.subsets ?? [];
  return (
    sources.find((source) => source.scope === 'all') ??
    sources.find((source) => source.scope === 'cjk') ??
    null
  );
}

export function codepointsOf(text: string, scope: HostFontSubsetSource['scope']): number[] {
  const seen = new Set<number>();
  for (const char of text) {
    const codepoint = char.codePointAt(0) as number;
    if (wantsGlyph(scope, codepoint)) seen.add(codepoint);
  }
  return [...seen];
}
