// The workstation's terminal palette and font, as a host reports them and a
// browser receives them. Browser-safe: no Node APIs, so the web app imports it.

/**
 * The sixteen ANSI slots a host may report, in index order. A palette is
 * all-or-nothing: half the host's colors mixed with half the browser's would
 * look worse than either set on its own.
 */
export const ANSI_PALETTE_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

export type AnsiPaletteKey = (typeof ANSI_PALETTE_KEYS)[number];

/** The sixteen ANSI slots, exactly as the host's terminal reported them. */
export type HostAnsiPalette = Record<AnsiPaletteKey, string>;

/**
 * The workstation's terminal colors, answered by the host's own emulator to
 * the OSC 10/11/12 and OSC 4 queries. The browser renders with these instead
 * of inventing a palette, which is what makes the web view look like the
 * session does on the workstation.
 */
export interface HostTerminalPalette {
  background?: string;
  foreground?: string;
  cursor?: string;
  ansi?: HostAnsiPalette;
}

/** The faces a host may offer, in the order a browser registers them. */
export const TERMINAL_FONT_STYLES = ['regular', 'bold', 'italic', 'boldItalic'] as const;
export type HostFontStyle = (typeof TERMINAL_FONT_STYLES)[number];

export const TERMINAL_FONT_FORMATS = ['truetype', 'opentype'] as const;
export type HostFontFormat = (typeof TERMINAL_FONT_FORMATS)[number];

/** `cjk`: the face Hanzi fall back to; `all`: the family itself, too big to send whole. */
export const TERMINAL_FONT_SUBSET_SCOPES = ['cjk', 'all'] as const;
export type HostFontSubsetScope = (typeof TERMINAL_FONT_SUBSET_SCOPES)[number];

/** One font file; a CJK face is larger than this and is left to the browser. */
export const MAX_TERMINAL_FONT_BYTES = 16 * 1024 * 1024;
/** Raw bytes per `host_font_chunk`; base64 keeps it far below any payload cap. */
export const TERMINAL_FONT_CHUNK_BYTES = 256 * 1024;

/** One file behind the workstation's terminal font, known here only by hash. */
export interface HostFontFace {
  style: HostFontStyle;
  format: HostFontFormat;
  bytes: number;
  sha256: string;
}

/** A font too large to send whole, cut to the characters a window draws. */
export interface HostFontSubsetSource {
  family: string;
  style: 'regular';
  scope: HostFontSubsetScope;
  /** Identifies the source font; subsets are cached under it. */
  sha256: string;
}

/**
 * The font the workstation's terminal draws with, read by the host from that
 * terminal's own settings. `faces` lists the files a browser without the font
 * may fetch, a slice at a time.
 */
export interface HostTerminalFont {
  family: string;
  /** In CSS pixels, converted from the terminal's points. */
  sizePx?: number;
  /** Which terminal it came from: `gnome-terminal`, `kitty`, … */
  source?: string;
  faces: HostFontFace[];
  subsets?: HostFontSubsetSource[];
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * A family name ends up inside a CSS `font-family` list in the browser. Quotes,
 * separators and escapes are what would let a name break out of its slot, and
 * no real family needs them.
 */
const FONT_FAMILY_FORBIDDEN = /["'\\;,{}<>@\u0000-\u001f\u007f]/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

type Untrusted = Record<string, unknown>;

function isRecord(value: unknown): value is Untrusted {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return (list as readonly unknown[]).includes(value);
}

function hexColor(value: unknown): string | undefined {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : undefined;
}

/**
 * Validates a terminal palette crossing the wire.
 *
 * The host reports what its own terminal answered to the OSC color queries,
 * and the browser paints with it. Anything that is not a plain `#rrggbb`
 * string is dropped here, so a compromised or buggy host cannot push arbitrary
 * data into a browser's renderer options.
 */
export function sanitizeTerminalPalette(value: unknown): HostTerminalPalette | null {
  if (!isRecord(value)) return null;
  const palette: HostTerminalPalette = {};
  for (const key of ['background', 'foreground', 'cursor'] as const) {
    const color = hexColor(value[key]);
    if (color) palette[key] = color;
  }
  const ansi = value.ansi;
  if (isRecord(ansi)) {
    const collected: Partial<HostAnsiPalette> = {};
    for (const key of ANSI_PALETTE_KEYS) {
      const color = hexColor(ansi[key]);
      if (color) collected[key] = color;
    }
    if (Object.keys(collected).length === ANSI_PALETTE_KEYS.length) {
      palette.ansi = collected as HostAnsiPalette;
    }
  }
  return Object.keys(palette).length > 0 ? palette : null;
}

function familyName(value: unknown): string | null {
  const family = typeof value === 'string' ? value.trim() : '';
  if (!family || family.length > 128 || FONT_FAMILY_FORBIDDEN.test(family)) return null;
  return family;
}

/**
 * Validates the terminal font a host reports.
 *
 * The browser draws the session in the family the workstation's terminal
 * uses, and may fetch the font files by their hash. Every field is optional
 * except the family; anything malformed is dropped rather than repaired.
 */
export function sanitizeTerminalFont(value: unknown): HostTerminalFont | null {
  if (!isRecord(value)) return null;
  const family = familyName(value.family);
  if (!family) return null;

  const size = Number(value.sizePx);
  const sizePx =
    Number.isFinite(size) && size >= 4 && size <= 96 ? Math.round(size * 10) / 10 : null;
  const source =
    typeof value.source === 'string' && /^[a-z0-9-]{1,32}$/.test(value.source)
      ? value.source
      : null;

  const faces: HostFontFace[] = [];
  const seen = new Set<HostFontStyle>();
  for (const face of Array.isArray(value.faces) ? value.faces.slice(0, 16) : []) {
    if (!isRecord(face)) continue;
    const { style, format, bytes, sha256 } = face;
    if (!isOneOf(TERMINAL_FONT_STYLES, style) || seen.has(style)) continue;
    if (!isOneOf(TERMINAL_FONT_FORMATS, format)) continue;
    if (typeof bytes !== 'number' || !Number.isInteger(bytes)) continue;
    if (bytes <= 0 || bytes > MAX_TERMINAL_FONT_BYTES) continue;
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) continue;
    seen.add(style);
    faces.push({ style, format, bytes, sha256 });
  }

  // Large fonts (CJK above all) are offered a few characters at a time.
  const subsets: HostFontSubsetSource[] = [];
  for (const entry of Array.isArray(value.subsets) ? value.subsets.slice(0, 16) : []) {
    if (!isRecord(entry)) continue;
    const name = familyName(entry.family);
    const { scope, sha256 } = entry;
    if (!name || entry.style !== 'regular') continue;
    if (!isOneOf(TERMINAL_FONT_SUBSET_SCOPES, scope)) continue;
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) continue;
    if (subsets.some((known) => known.scope === scope)) continue;
    subsets.push({ family: name, style: 'regular', scope, sha256 });
  }

  return {
    family,
    ...(sizePx !== null && { sizePx }),
    ...(source !== null && { source }),
    faces,
    subsets,
  };
}
