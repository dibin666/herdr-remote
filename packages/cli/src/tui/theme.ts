// A deliberately quiet palette.
//
// The previous TUI painted 24-bit terracotta on filled backgrounds, which
// fought with every terminal theme it ran in. These are the eight basic ANSI
// colours instead, so the interface inherits whatever palette the user already
// chose: one accent for "where you are", and colour elsewhere only where it
// carries meaning (a service is up, down, or in between).

export const theme = {
  /** Selection and focus. */
  accent: 'cyan',
  /** Frame lines and separators. */
  border: 'gray',
  /** Secondary text: labels, hints, paths. */
  muted: 'gray',
  ok: 'green',
  warn: 'yellow',
  bad: 'red',
} as const;

export const SELECTED_MARKER = '▸';
export const UNSELECTED_MARKER = ' ';

export type StatusLevel = 'ok' | 'warn' | 'bad' | 'idle';

export const STATUS_COLOR: Record<StatusLevel, string | undefined> = {
  ok: theme.ok,
  warn: theme.warn,
  bad: theme.bad,
  idle: theme.muted,
};

/** Filled for a live state, hollow for an inactive one. */
export const STATUS_GLYPH: Record<StatusLevel, string> = {
  ok: '●',
  warn: '●',
  bad: '●',
  idle: '○',
};
