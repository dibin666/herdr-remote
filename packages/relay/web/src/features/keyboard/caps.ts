/**
 * The touch key bar is drawn as key caps.
 *
 * Every key is a bordered rectangle holding its own name — `ESC`, `^C`, `F7` —
 * or, for arrows, Enter and the like, a solid Nerd Font icon from the interface
 * face, every icon drawn the same size (see `KeyLabel`). A latched modifier is
 * inverse-video, the way a TUI shows a held state; nothing else on the bar is
 * filled.
 */

/** One key cap. Its height comes from `capHeight`, shared by the whole bar. */
export const CAP_BASE =
  'tui-focusable inline-flex shrink-0 select-none items-center justify-center gap-1 whitespace-nowrap border text-tui font-medium transition-colors';

export const CAP_IDLE =
  'border-tui-border bg-tui-surface text-tui-text hover:border-tui-accent hover:text-tui-accent active:bg-tui-selection';

/** A latched modifier or an open drawer: inverse video, as in a terminal. */
export const CAP_ACTIVE = 'border-tui-accent bg-tui-accent text-tui-crust font-bold';

/** Enter is the one key that always commits something, so it leads in accent. */
export const CAP_COMMIT =
  'border-tui-ok bg-transparent text-tui-ok hover:bg-tui-ok hover:text-tui-crust font-bold';

export const CHORD_TONE_CLASS = {
  default: CAP_IDLE,
  bad: 'border-tui-bad text-tui-bad hover:bg-tui-bad hover:text-tui-crust',
  warn: 'border-tui-warn text-tui-warn hover:bg-tui-warn hover:text-tui-crust',
} as const;

export type ChordTone = keyof typeof CHORD_TONE_CLASS;

/** Cap sizes for the bar's density. */
export function capSizes(compact: boolean) {
  // One cap height for every key on the bar and in its drawers: agent
  // shortcuts a size smaller than ESC beside them made the row read as two
  // toolbars. A finger gets a little more height than a pointer does. A key
  // that is only an icon is square; a word is as wide as it needs.
  return {
    capHeight: compact ? 'h-8' : 'h-7',
    keyClass: compact ? 'h-8 min-w-[2rem] px-1.5' : 'h-7 min-w-[1.75rem] px-1.5',
    squareKeyClass: compact ? 'h-8 w-8' : 'h-7 w-7',
    drawerToggleClass: compact ? 'h-8 px-1.5' : 'h-7 px-1.5',
  };
}
