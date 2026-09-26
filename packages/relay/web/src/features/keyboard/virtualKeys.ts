// The user's touch toolbar layout: defaults, upgrading untouched old
// layouts, sanitising what storage returns, and key titles.

import type { Translate, TranslationKey } from '@/shared/i18n';
import { DEFAULT_TOOLBAR_KEYS, type ToolbarKeyDef } from './virtualKeyCatalog';

export * from './virtualKeyCatalog';

export function getDefaultVirtualKeys(): ToolbarKeyDef[] {
  return JSON.parse(JSON.stringify(DEFAULT_TOOLBAR_KEYS));
}

/**
 * Layouts earlier builds shipped as the default: first with Enter buried
 * mid-row, then without Shift+Tab.
 *
 * A saved layout is the user's own arrangement and must be left alone — unless
 * it is untouched, in which case it is not a preference at all but a copy of a
 * default that has since moved on. Recognising it by its exact key order is
 * what lets the new default reach the people who never customised anything.
 */
const LEGACY_DEFAULT_KEY_ORDERS = [
  [
    'esc',
    'tab',
    'shift_tab',
    'ctrl',
    'alt',
    'left',
    'up',
    'down',
    'right',
    'drawer_chords',
    'drawer_symbols',
    'drawer_fn',
    'enter',
  ],
  [
    'esc',
    'tab',
    'ctrl',
    'alt',
    'left',
    'up',
    'down',
    'right',
    'enter',
    'drawer_chords',
    'drawer_symbols',
    'drawer_fn',
  ],
  [
    'esc',
    'tab',
    'ctrl',
    'alt',
    'left',
    'up',
    'down',
    'right',
    'drawer_chords',
    'drawer_symbols',
    'drawer_fn',
    'enter',
  ],
  [
    'esc',
    'tab',
    'ctrl',
    'alt',
    'left',
    'up',
    'down',
    'right',
    'drawer_agent',
    'drawer_symbols',
    'drawer_fn',
    'enter',
  ],
];

function isUntouchedLegacyLayout(keys: ToolbarKeyDef[]): boolean {
  return LEGACY_DEFAULT_KEY_ORDERS.some(
    (order) =>
      keys.length === order.length &&
      keys.every((key, index) => key.id === order[index] && key.enabled !== false),
  );
}

export function sanitizeVirtualKeys(keys: unknown): ToolbarKeyDef[] {
  if (!Array.isArray(keys) || keys.length === 0) {
    return getDefaultVirtualKeys();
  }
  const valid = keys.filter(
    (k) =>
      typeof k === 'object' &&
      k !== null &&
      typeof k.id === 'string' &&
      typeof k.label === 'string' &&
      typeof k.code === 'string',
  ) as ToolbarKeyDef[];
  if (isUntouchedLegacyLayout(valid)) return getDefaultVirtualKeys();
  // Agent shortcuts now live in the main key row, so discard stale drawer entries.
  return valid.filter((key) => key.id !== 'drawer_agent');
}

export function getLocalizedKeyTitle(
  key: { id: string; title?: string; label: string },
  t?: Translate,
): string {
  if (t) {
    // Not every key has a title of its own; those fall back to theirs below.
    const keyPath = `keyTitles.${key.id}` as TranslationKey;
    const translated = t(keyPath);
    if (translated && translated !== keyPath) {
      return translated;
    }
  }
  return key.title || key.label;
}
