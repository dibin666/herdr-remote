// The keys that put the workstation's Herdr into prefix mode, as a host reads
// them from Herdr's config and a browser receives them. Browser-safe: no Node
// APIs, so the web app imports it.

/** Herdr accepts any number of prefix keys; a window has no use for more than this. */
const MAX_HERDR_PREFIX_KEYS = 8;
/** Longest real combo is `ctrl+shift+double_quote`; this leaves room for spelling variants. */
const MAX_HERDR_PREFIX_KEY_LENGTH = 32;
/**
 * What the browser can act on: a key combo is printable ASCII (modifiers and
 * key names joined by `+`). Whitespace is removed before this is tested.
 */
const PREFIX_KEY = /^[\x21-\x7e]+$/;

/**
 * Validates the Herdr prefix keys crossing the wire, or read from a config
 * file, into one canonical list: lowercase, no whitespace, no duplicates, at
 * most `MAX_HERDR_PREFIX_KEYS` short entries. Herdr ignores entries it cannot
 * read and so does this. `undefined` when nothing usable is left, so a host
 * that says nothing and one that says garbage look the same.
 */
export function sanitizeHerdrPrefixKeys(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const keys = new Set<string>();
  for (const entry of value) {
    if (keys.size >= MAX_HERDR_PREFIX_KEYS) break;
    if (typeof entry !== 'string') continue;
    const key = entry.replace(/\s+/g, '').toLowerCase();
    if (key.length <= MAX_HERDR_PREFIX_KEY_LENGTH && PREFIX_KEY.test(key)) keys.add(key);
  }
  return keys.size > 0 ? [...keys] : undefined;
}
