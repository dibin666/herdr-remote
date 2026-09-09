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

export const FONT_PRESETS = [
  {
    id: 'system',
    name: 'System Default (Recommended)',
    font: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", "Symbols Nerd Font Mono", monospace',
  },
  {
    id: 'apple',
    name: 'Apple SF Mono / Menlo',
    font: 'SFMono-Regular, Menlo, Monaco, "Symbols Nerd Font Mono", monospace',
  },
  {
    id: 'windows',
    name: 'Windows Consolas',
    font: 'Consolas, "Lucida Console", "Symbols Nerd Font Mono", monospace',
  },
  {
    id: 'linux',
    name: 'Linux Liberation Mono',
    font: '"Liberation Mono", "DejaVu Sans Mono", "Symbols Nerd Font Mono", monospace',
  },
  {
    id: 'courier',
    name: 'Courier New',
    font: '"Courier New", Courier, "Symbols Nerd Font Mono", monospace',
  },
  {
    id: 'firacode',
    name: 'Fira Code (Ligatures)',
    font: '"Fira Code", "Symbols Nerd Font Mono", monospace',
  },
] as const;

export type FontPresetId = typeof FONT_PRESETS[number]['id'];

/**
 * Ensures the terminal font stack always includes 'Symbols Nerd Font Mono' as a fallback
 * for remote Nerd Font / Powerline icons, even with custom font strings.
 */
export function resolveTerminalFontFamily(fontFamily: string | null | undefined): string {
  if (!fontFamily || typeof fontFamily !== 'string') {
    return FONT_PRESETS[0].font;
  }
  const trimmed = fontFamily.trim();
  if (trimmed.includes('Symbols Nerd Font')) {
    return trimmed;
  }
  if (/^['"]?monospace['"]?$/i.test(trimmed)) {
    return '"Symbols Nerd Font Mono", monospace';
  }
  const hasMonospace = /,\s*['"]?monospace['"]?\s*$/i;
  if (hasMonospace.test(trimmed)) {
    return trimmed.replace(hasMonospace, ', "Symbols Nerd Font Mono", monospace');
  }
  return `${trimmed}, "Symbols Nerd Font Mono", monospace`;
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
