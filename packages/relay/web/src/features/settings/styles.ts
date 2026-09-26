import { cn } from '@/shared/lib/cn';
import { CONTROL_H } from '@/shared/ui';

/** A field or button sized to the settings column: one height, no own padding. */
export const CONTROL_FIELD = cn(CONTROL_H, 'py-0');

/** The same, one step smaller, for controls inside a list row. */
export const COMPACT_FIELD = 'h-7 py-0';

/** A section's own small action beside its heading. */
export const COMPACT = 'h-7 py-0 px-1.5';

/** Resets are the only destructive words here, so they are the only red ones. */
export const DANGER_GHOST = 'text-tui-bad hover:border-tui-bad hover:text-tui-bad';

/**
 * One agent-key row. Every column has a fixed width so the combo fields and
 * buttons line up down the list; a phone splits the row over two lines. The
 * default column fits the longest caption, "Default: Alt+⇧P".
 */
export const AGENT_ROW_GRID = [
  'grid items-center gap-x-2 gap-y-1 py-1',
  "grid-cols-[4rem_minmax(0,1fr)_9rem] [grid-template-areas:'cap_label_actions'_'combo_combo_default']",
  "sm:grid-cols-[4rem_minmax(0,1fr)_9rem_9rem_7rem] sm:[grid-template-areas:'cap_label_combo_default_actions']",
].join(' ');

/** The words on every switch in the settings. */
export function toggleWords(t: (key: 'settings.toggleOff' | 'settings.toggleOn') => string) {
  return { offLabel: t('settings.toggleOff'), onLabel: t('settings.toggleOn') };
}
