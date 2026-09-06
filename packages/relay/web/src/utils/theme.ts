import { ITheme } from '@xterm/xterm';

export type ThemeName = 'claude' | 'light' | 'dark' | 'tokyonight' | 'monokai' | 'matrix';

/** Shared brand colors for the dark-only Herdr web shell and default terminal. */
export const HERDR_DARK_BACKGROUND = '#0b1120';
export const HERDR_LIGHT_BLUE = '#7dd3fc';
export const HERDR_BANNER_ANSI = '\x1b[38;2;125;211;252m';

/** The sixteen ANSI slots every terminal theme must define explicitly. */
export const ANSI_COLOR_KEYS = [
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

export type AnsiColorKey = typeof ANSI_COLOR_KEYS[number];
type AnsiPalette = Record<AnsiColorKey, string>;

/**
 * A light-background ANSI palette adapted from the readable light palettes in
 * Monolith and OpenAlice. Normal colors target WCAG AA-sized text; bright colors
 * remain visibly distinct while meeting a 3:1 minimum on both light surfaces.
 */
const LIGHT_ANSI: AnsiPalette = {
  black: '#1a1a1e',
  red: '#b42318',
  green: '#107c10',
  yellow: '#9a6700',
  blue: '#0550ae',
  magenta: '#a626a4',
  cyan: '#0e7490',
  white: '#56565e',
  brightBlack: '#71717a',
  brightRed: '#d13438',
  brightGreen: '#128a12',
  brightYellow: '#b58500',
  brightBlue: '#2563eb',
  brightMagenta: '#c026d3',
  brightCyan: '#0891b2',
  brightWhite: '#8c8c94',
};

export const FONT_PRESETS = [
  {
    id: 'system',
    name: 'System Default (Recommended)',
    font: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  },
  {
    id: 'apple',
    name: 'Apple SF Mono / Menlo',
    font: 'SFMono-Regular, Menlo, Monaco, monospace',
  },
  {
    id: 'windows',
    name: 'Windows Consolas',
    font: 'Consolas, "Lucida Console", monospace',
  },
  {
    id: 'linux',
    name: 'Linux Liberation Mono',
    font: '"Liberation Mono", "DejaVu Sans Mono", monospace',
  },
  {
    id: 'courier',
    name: 'Courier New',
    font: '"Courier New", Courier, monospace',
  },
  {
    id: 'firacode',
    name: 'Fira Code (Ligatures)',
    font: '"Fira Code", monospace',
  },
] as const;

export const TERMINAL_THEMES: Record<ThemeName, ITheme> = {
  // Optional Claude Warm Ivory terminal palette
  claude: {
    background: '#faf8f5',
    foreground: '#2d2b28',
    cursor: '#d9643a',
    cursorAccent: '#faf8f5',
    selectionBackground: '#ebdcd2',
    selectionForeground: '#2d2b28',
    ...LIGHT_ANSI,
  },
  // Optional Pure Crisp White terminal palette
  light: {
    background: '#ffffff',
    foreground: '#1e293b',
    cursor: '#d9643a',
    cursorAccent: '#ffffff',
    selectionBackground: '#fed7aa',
    selectionForeground: '#1e293b',
    ...LIGHT_ANSI,
  },
  // Herdr Midnight Dark Theme (Default)
  dark: {
    background: HERDR_DARK_BACKGROUND,
    foreground: '#e0f2fe',
    cursor: HERDR_LIGHT_BLUE,
    cursorAccent: HERDR_DARK_BACKGROUND,
    selectionBackground: '#164e63',
    selectionForeground: '#e0f2fe',
    black: '#0b1120',
    red: '#fb7185',
    green: '#4ade80',
    yellow: '#facc15',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#67e8f9',
    white: '#e2e8f0',
    brightBlack: '#64748b',
    brightRed: '#fda4af',
    brightGreen: '#86efac',
    brightYellow: '#fde68a',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#a5f3fc',
    brightWhite: '#f8fafc',
  },
  tokyonight: {
    background: '#1a1b26',
    foreground: '#c0caf5',
    cursor: '#c0caf5',
    cursorAccent: '#1a1b26',
    selectionBackground: '#33467c',
    selectionForeground: '#c0caf5',
    black: '#15161e',
    red: '#f7768e',
    green: '#9ece6a',
    yellow: '#e0af68',
    blue: '#7aa2f7',
    magenta: '#bb9af7',
    cyan: '#7dcfff',
    white: '#a9b1d6',
    brightBlack: '#414868',
    brightRed: '#f7768e',
    brightGreen: '#9ece6a',
    brightYellow: '#e0af68',
    brightBlue: '#7aa2f7',
    brightMagenta: '#bb9af7',
    brightCyan: '#7dcfff',
    brightWhite: '#c0caf5',
  },
  monokai: {
    background: '#272822',
    foreground: '#f8f8f2',
    cursor: '#f8f8f0',
    cursorAccent: '#272822',
    selectionBackground: '#49483e',
    selectionForeground: '#f8f8f2',
    black: '#272822',
    red: '#f92672',
    green: '#a6e22e',
    yellow: '#f4bf75',
    blue: '#66d9ef',
    magenta: '#ae81ff',
    cyan: '#a1efe4',
    white: '#f8f8f2',
    brightBlack: '#75715e',
    brightRed: '#f92672',
    brightGreen: '#a6e22e',
    brightYellow: '#f4bf75',
    brightBlue: '#66d9ef',
    brightMagenta: '#ae81ff',
    brightCyan: '#a1efe4',
    brightWhite: '#f9f8f5',
  },
  matrix: {
    background: '#030a04',
    foreground: '#00ff41',
    cursor: '#00ff41',
    cursorAccent: '#030a04',
    selectionBackground: '#003b00',
    selectionForeground: '#00ff41',
    black: '#001100',
    red: '#00dd00',
    green: '#00ff41',
    yellow: '#33ff33',
    blue: '#008800',
    magenta: '#00aa00',
    cyan: '#55ff55',
    white: '#88ff88',
    brightBlack: '#004400',
    brightRed: '#22ee22',
    brightGreen: '#55ff55',
    brightYellow: '#88ff88',
    brightBlue: '#00cc00',
    brightMagenta: '#22ff22',
    brightCyan: '#aaffaa',
    brightWhite: '#ffffff',
  },
};

function parseHexColor(value: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const hex = match[1].length === 3
    ? match[1].split('').map((channel) => `${channel}${channel}`).join('')
    : match[1];
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
}

function relativeLuminance(value: string): number {
  const rgb = parseHexColor(value);
  if (!rgb) return 0;
  const channels = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG contrast ratio for the hex colors used by the built-in palettes. */
export function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

/** xterm's contrast safety net is only needed for light terminal canvases. */
export function terminalMinimumContrastRatio(themeName: ThemeName): number {
  return themeName === 'claude' || themeName === 'light' ? 3 : 1;
}

/**
 * The web shell deliberately has one appearance. Keep this compatibility
 * resolver for callers and old stored values, but never consult the OS.
 */
export function resolveEffectiveColorMode(
  _colorMode: 'light' | 'dark' | 'system'
): 'dark' {
  return 'dark';
}

/** Compatibility hook retained for the provider; the result is always dark. */
export function useEffectiveColorMode(
  _colorMode: 'light' | 'dark' | 'system'
): 'dark' {
  return 'dark';
}

/**
 * Resolves the selected terminal ANSI palette and canvas background. The
 * legacy color-mode arguments remain in the signature for compatibility, but
 * terminal palette selection is independent from the dark-only web shell.
 */
export function resolveTerminalTheme(
  themeName: ThemeName,
  _effectiveColorMode: 'light' | 'dark',
  _colorMode: 'light' | 'dark' | 'system'
): { theme: ITheme; background: string; resolvedThemeName: ThemeName } {
  const resolvedThemeName: ThemeName = themeName;
  const themeObj = TERMINAL_THEMES[resolvedThemeName] || TERMINAL_THEMES.dark;
  const background = themeObj.background || HERDR_DARK_BACKGROUND;

  return {
    // xterm only reacts when an object-valued option receives a new object.
    theme: { ...themeObj },
    background,
    resolvedThemeName,
  };
}

/** Applies the single dark appearance to the document and browser chrome. */
export function applyDocumentTheme(_effectiveMode: 'light' | 'dark'): void {
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
