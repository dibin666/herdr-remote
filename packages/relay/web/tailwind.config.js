/** @type {import('tailwindcss').Config} */

/**
 * The web UI is a terminal client, so it is dressed as one.
 *
 * Every colour here is Herdr's own default theme (Catppuccin Mocha, the palette
 * `herdr` ships with and the one its TUI paints itself in), exposed under names
 * that say what a token is *for* rather than what it looks like. There is one
 * appearance: a dark terminal. No light variant, no gradients, no brand tints.
 */
const mocha = {
  crust: '#11111b',
  mantle: '#181825',
  base: '#1e1e2e',
  surface0: '#313244',
  surface1: '#45475a',
  surface2: '#585b70',
  overlay0: '#6c7086',
  overlay1: '#7f849c',
  subtext0: '#a6adc8',
  subtext1: '#bac2de',
  text: '#cdd6f4',
  blue: '#89b4fa',
  sapphire: '#74c7ec',
  sky: '#89dceb',
  teal: '#94e2d5',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  peach: '#fab387',
  maroon: '#eba0ac',
  red: '#f38ba8',
  mauve: '#cba6f7',
  pink: '#f5c2e7',
};

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        tui: {
          /** Behind everything: the "terminal window" the panels sit on. */
          crust: mocha.crust,
          /** Bars and chrome strips: header, footer, table headings. */
          mantle: mocha.mantle,
          /** A panel's own fill. */
          base: mocha.base,
          /** Cursor row / hovered row, the TUI's inverse-video stand-in. */
          selection: mocha.surface0,
          /** Raised inner surfaces: inputs, code blocks, key caps. */
          surface: mocha.surface0,
          /** Box-drawing lines. */
          border: mocha.surface1,
          /** A line that should recede: nested rules, disabled frames. */
          'border-dim': mocha.surface0,
          /** A line that should lead: a focused field, a hovered row. */
          'border-bright': mocha.surface2,
          /** Body text. */
          text: mocha.text,
          /** Labels, hints, paths — everything secondary. */
          muted: mocha.subtext0,
          /** Quieter still: separators rendered as glyphs, disabled labels. */
          faint: mocha.overlay0,
          /** Where you are, and what you can act on. */
          accent: mocha.blue,
          'accent-bright': mocha.sky,
          'accent-dim': mocha.sapphire,
          /** Colour that carries meaning, and nothing else. */
          ok: mocha.green,
          warn: mocha.yellow,
          bad: mocha.red,
          info: mocha.teal,
          alt: mocha.mauve,
          notice: mocha.peach,
        },
        ansi: mocha,
      },
      fontFamily: {
        /*
         * One family for the whole interface: a TUI has no proportional text.
         *
         * The CJK monospace faces come first among the fallbacks that can carry
         * Han characters. Without them a browser reaches for a *proportional*
         * CJK face, whose glyph advances do not divide into the Latin cell —
         * which is why mixed 中文/latin lines drifted off the grid and looked
         * like two different type sizes on one row.
         */
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'Liberation Mono',
          'Courier New',
          'Sarasa Mono SC',
          'Noto Sans Mono CJK SC',
          'Noto Sans Mono CJK TC',
          'Microsoft YaHei Mono',
          'PingFang SC',
          'monospace',
        ],
        sans: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'Liberation Mono',
          'Courier New',
          'Sarasa Mono SC',
          'Noto Sans Mono CJK SC',
          'Noto Sans Mono CJK TC',
          'Microsoft YaHei Mono',
          'PingFang SC',
          'monospace',
        ],
      },
      borderRadius: {
        /* Terminal cells are rectangles. Every radius resolves to none, so a
           stray `rounded-xl` from older markup cannot round a corner. */
        none: '0px',
        sm: '0px',
        DEFAULT: '0px',
        md: '0px',
        lg: '0px',
        xl: '0px',
        '2xl': '0px',
        '3xl': '0px',
        full: '9999px',
      },
      spacing: {
        'safe-top': 'env(safe-area-inset-top, 0px)',
        'safe-bottom': 'env(safe-area-inset-bottom, 0px)',
        'safe-left': 'env(safe-area-inset-left, 0px)',
        'safe-right': 'env(safe-area-inset-right, 0px)',
        /** One terminal row, used to align chrome to the grid. */
        row: '1.375rem',
      },
      fontSize: {
        /*
         * A terminal has exactly one type size. This interface has two, and the
         * second only because a status line may be quieter than its content.
         *
         * The gap between them is deliberately one pixel of visual weight, not
         * a heading scale: hierarchy here is carried by weight and colour. An
         * earlier 11/13/16 ladder put three sizes on a single line, and mixed
         * with CJK — whose glyphs fill their em box where Latin ones do not —
         * that read as four.
         */
        tui: ['13px', { lineHeight: '20px' }],
        'tui-sm': ['12px', { lineHeight: '18px' }],
        /* Reserved for a headline figure on the status board. Never for text. */
        'tui-lg': ['15px', { lineHeight: '22px' }],
      },
      keyframes: {
        'tui-blink': {
          '0%, 49%': { opacity: '1' },
          '50%, 100%': { opacity: '0' },
        },
      },
      animation: {
        'tui-blink': 'tui-blink 1s step-end infinite',
      },
    },
  },
  plugins: [],
}
