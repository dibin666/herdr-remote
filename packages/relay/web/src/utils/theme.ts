import type { ITheme } from '@xterm/xterm';
import type { HostTerminalPalette } from '../types/protocol';

/**
 * Terminal colors are never decided here.
 *
 * The web client is a transparent pipe for the Herdr host PTY: every SGR /
 * OSC sequence the host emits is handed to xterm untouched, and xterm paints
 * it with its stock palette. There is no client-side ANSI palette, no theme
 * picker and no contrast remapping, so what a user sees in the browser is what
 * the same session looks like in the host terminal.
 *
 * The only colors this module still owns belong to the app chrome around the
 * terminal (header, modals, document background), which is dark-only.
 */

/**
 * Shell chrome colour for the dark-only Herdr web UI.
 *
 * Catppuccin Mocha's `crust`: the same base Herdr's own TUI paints itself on,
 * so the browser client and the terminal it mirrors are the same shade of dark.
 */
export const HERDR_DARK_BACKGROUND = '#11111b';

/**
 * Everything after the chosen face, in order: Nerd Font icons (bundled, so a
 * Powerline prompt draws on any device), CJK monospace faces whose advance is
 * two Latin cells, then the generic fallback. The same order as `--tui-font`.
 */
const FONT_STACK_TAIL = [
  '"Symbols Nerd Font Mono"',
  '"Sarasa Mono SC"',
  '"Noto Sans Mono CJK SC"',
  '"Noto Sans Mono CJK TC"',
  '"Microsoft YaHei Mono"',
  '"PingFang SC"',
  'monospace',
];

/** Each platform's own monospace face, whichever this device has. */
const SYSTEM_MONOSPACE = [
  'ui-monospace',
  'SFMono-Regular',
  'Menlo',
  'Monaco',
  'Consolas',
  '"Liberation Mono"',
  '"Courier New"',
];

export type FontPresetId =
  | 'host'
  | 'system'
  | 'jetbrains-mono'
  | 'fira-code'
  | 'cascadia-code'
  | 'source-code-pro'
  | 'ibm-plex-mono';

export interface FontPreset {
  id: FontPresetId;
  /** The label when no translation is loaded. */
  name: string;
  /** Faces ahead of the shared tail; empty for `host`, which is resolved live. */
  faces: string[];
}

/**
 * The choices under "Monospace Font". `host` is the default: the session is
 * drawn in whatever the workstation's terminal uses. The programming fonts
 * name the real family first, so a copy installed on this device wins, and
 * the bundled `Herdr …` webfont (see `fonts.css`) second, so the choice also
 * works on a phone that has none of them.
 */
export const FONT_PRESETS: readonly FontPreset[] = [
  { id: 'host', name: 'Host terminal font', faces: [] },
  { id: 'system', name: 'System monospace', faces: SYSTEM_MONOSPACE },
  {
    id: 'jetbrains-mono',
    name: 'JetBrains Mono',
    faces: ['"JetBrains Mono"', '"Herdr JetBrains Mono"'],
  },
  { id: 'fira-code', name: 'Fira Code', faces: ['"Fira Code"', '"Herdr Fira Code"'] },
  {
    id: 'cascadia-code',
    name: 'Cascadia Code',
    faces: ['"Cascadia Code"', '"Herdr Cascadia Code"'],
  },
  {
    id: 'source-code-pro',
    name: 'Source Code Pro',
    faces: ['"Source Code Pro"', '"Herdr Source Code Pro"'],
  },
  {
    id: 'ibm-plex-mono',
    name: 'IBM Plex Mono',
    faces: ['"IBM Plex Mono"', '"Herdr IBM Plex Mono"'],
  },
];

export function isFontPresetId(value: unknown): value is FontPresetId {
  return FONT_PRESETS.some((preset) => preset.id === value);
}

/**
 * The bundled face drawn the same way as a host family, Nerd Font patches
 * included (Caskaydia is Cascadia, Blex is IBM Plex, Sauce is Source). Used
 * while the host's own files are not loaded, so the session already looks
 * like the workstation's instead of like this device's default.
 */
const BUNDLED_EQUIVALENTS: Array<[RegExp, string]> = [
  [/^jetbrains\s*mono/i, '"Herdr JetBrains Mono"'],
  [/^fira\s*code/i, '"Herdr Fira Code"'],
  [/^(cascadia\s*(code|mono)|caskaydia\s*(cove|mono))/i, '"Herdr Cascadia Code"'],
  [/^(source\s*code\s*pro|sauce\s*code\s*pro)/i, '"Herdr Source Code Pro"'],
  [/^(ibm\s*plex\s*mono|blex\s*mono)/i, '"Herdr IBM Plex Mono"'],
];

export function bundledEquivalent(family: string): string | null {
  const match = BUNDLED_EQUIVALENTS.find(([pattern]) => pattern.test(family.trim()));
  return match ? match[1] : null;
}

/** Quote one family name for a CSS list. The relay already refused quotes. */
function quoteFamily(family: string): string {
  return `"${family.replace(/["\\]/g, '')}"`;
}

function stack(faces: string[]): string {
  return [...new Set([...faces, ...FONT_STACK_TAIL])].join(', ');
}

/** The system monospace stack; also what `host` shows before a host reports. */
export const SYSTEM_FONT_STACK = stack(SYSTEM_MONOSPACE);

/** The workstation's font as the terminal can name it. */
export interface HostFontFamily {
  family: string;
  /** The FontFace family its fetched files are registered under, once loaded. */
  alias?: string | null;
  /** A large font received cut to size: the CJK fallback, or the family itself. */
  glyphs?: { family: string; scope: 'cjk' | 'all'; alias?: string | null } | null;
}

/**
 * The CSS font-family list for a font setting.
 *
 * `host` puts the fetched files first (when loaded), then the family by name
 * (when this device has it), then the bundled look-alike, then the system
 * stack. Every stack ends with the Nerd Font icons and the CJK faces. A custom
 * stack from an older version is kept, with the icon fallback appended.
 */
export function resolveTerminalFontFamily(
  setting: string | null | undefined,
  host?: HostFontFamily | null,
): string {
  const value = typeof setting === 'string' ? setting.trim() : '';
  if (!value || value === 'host') {
    if (!host?.family) return SYSTEM_FONT_STACK;
    const faces = [];
    const glyphs = host.glyphs;
    // A family cut to size comes first: it is the family.
    if (glyphs?.scope === 'all' && glyphs.alias) faces.push(quoteFamily(glyphs.alias));
    if (host.alias) faces.push(quoteFamily(host.alias));
    faces.push(quoteFamily(host.family));
    const bundled = bundledEquivalent(host.family);
    if (bundled) faces.push(bundled);
    // The workstation's CJK fallback, ahead of this device's own.
    if (glyphs?.scope === 'cjk') {
      if (glyphs.alias) faces.push(quoteFamily(glyphs.alias));
      faces.push(quoteFamily(glyphs.family));
    }
    return stack([...faces, ...SYSTEM_MONOSPACE]);
  }
  const preset = FONT_PRESETS.find((candidate) => candidate.id === value);
  if (preset) return stack([...preset.faces, ...SYSTEM_MONOSPACE]);

  if (value.includes('Symbols Nerd Font')) return value;
  if (/^['"]?monospace['"]?$/i.test(value)) return '"Symbols Nerd Font Mono", monospace';
  const hasMonospace = /,\s*['"]?monospace['"]?\s*$/i;
  if (hasMonospace.test(value))
    return value.replace(hasMonospace, ', "Symbols Nerd Font Mono", monospace');
  return `${value}, "Symbols Nerd Font Mono", monospace`;
}

/**
 * Turns the palette the host reported into xterm's theme shape.
 *
 * This is transport, not design: every value comes from the workstation's own
 * terminal. A host that reported nothing yields `null`, and xterm then keeps
 * its built-in defaults instead of a palette this client made up.
 */
export function hostPaletteToTheme(palette: HostTerminalPalette | null | undefined): ITheme | null {
  if (!palette) return null;

  const theme: ITheme = {};
  if (palette.background) {
    theme.background = palette.background;
    // xterm draws the cursor's own glyph in this color; matching the canvas is
    // what the host terminal does too.
    theme.cursorAccent = palette.background;
  }
  if (palette.foreground) theme.foreground = palette.foreground;
  if (palette.cursor) theme.cursor = palette.cursor;
  if (palette.ansi) Object.assign(theme, palette.ansi);
  if (Object.keys(theme).length === 0) return null;

  return theme;
}

/** Applies the single dark appearance to the document and browser chrome. */
export function applyDocumentTheme(): void {
  if (typeof document === 'undefined') return;

  const themeColor = document.querySelector('meta[name="theme-color"]');
  document.documentElement.style.colorScheme = 'dark';
  themeColor?.setAttribute('content', HERDR_DARK_BACKGROUND);
  document.documentElement.classList.add('dark');
  document.documentElement.classList.remove('light');
  document.body.classList.add('dark');
  document.body.classList.remove('light');
  document.body.style.backgroundColor = HERDR_DARK_BACKGROUND;
}
