// Herdr's prefix keys as bytes: the keys after which whatever the user types
// is a Herdr command, not text for the pane, so it must never be predicted.

import { KeyComboError, parseKeyCombo } from '@/shared/keys/keyCombo';
import { encodeCtrlKey } from '@/shared/keys/keyEncoder';

/** What Herdr itself uses until a config says otherwise. */
const DEFAULT_PREFIX_KEYS: readonly string[] = ['ctrl+b'];

/** Names Herdr's config accepts that `parseKeyCombo` spells another way. */
const HERDR_KEY_NAMES = new Map([
  ['meta', 'alt'],
  ['bs', 'backspace'],
  ['minus', '-'],
  ['comma', ','],
  ['period', '.'],
  ['slash', '/'],
  ['quote', "'"],
  ['double_quote', '"'],
  ['double-quote', '"'],
  ['semicolon', ';'],
  ['colon', ':'],
  ['percent', '%'],
  ['ampersand', '&'],
  ['backtick', '`'],
]);
const CTRL_NAMES = ['ctrl', 'control'];
const ALT_NAMES = ['alt', 'option', 'meta'];
const MODIFIER_NAMES = [...CTRL_NAMES, ...ALT_NAMES, 'shift'];

/**
 * Every byte string a terminal may send for `combo`: what `parseKeyCombo`
 * gives Herdr, plus the legacy control byte xterm.js emits for Ctrl+<key>
 * (Ctrl+Shift+X is `ESC[120;6u` on the wire from a toolbar, but a single
 * 0x18 from the keyboard). Empty for a combo this window cannot encode.
 */
function sequencesOf(combo: string): string[] {
  const parts = combo.split('+');
  const sent: string[] = [];
  try {
    sent.push(...parseKeyCombo(parts.map((part) => HERDR_KEY_NAMES.get(part) ?? part).join('+')));
  } catch (error) {
    // `super+b` or an unknown key name: nothing this window could see typed.
    if (error instanceof KeyComboError) return [];
    throw error;
  }
  // A prefix is one key; a chord is not something Herdr enters prefix mode on.
  if (sent.length !== 1) return [];

  const key = parts.find((part) => !MODIFIER_NAMES.includes(part));
  const char = key === 'space' ? ' ' : key;
  if (char?.length === 1 && parts.some((part) => CTRL_NAMES.includes(part))) {
    const control = encodeCtrlKey(char);
    if (control !== char) {
      sent.push(parts.some((part) => ALT_NAMES.includes(part)) ? `\x1b${control}` : control);
    }
  }
  return sent;
}

export class HerdrPrefixKeys {
  private readonly sequences: string[];

  /** `combos` are Herdr key combos; when none can be read, the default `ctrl+b` stands in. */
  constructor(combos: readonly string[]) {
    const read = new Set(combos.flatMap(sequencesOf));
    this.sequences =
      read.size > 0 ? [...read] : [...new Set(DEFAULT_PREFIX_KEYS.flatMap(sequencesOf))];
  }

  /** Whether a prefix key is what `text` holds at `offset`. */
  startsAt(text: string, offset: number): boolean {
    return this.sequences.some((sequence) => text.startsWith(sequence, offset));
  }
}

/**
 * The prefix keys as of now. `get` is read at call time because the host's
 * answer arrives after the terminal exists; the bytes are worked out again
 * only when it hands back a different list.
 */
export function prefixKeysResolver(
  get: (() => readonly string[] | undefined) | undefined,
): () => HerdrPrefixKeys {
  let source: readonly string[] | undefined;
  let keys = new HerdrPrefixKeys(DEFAULT_PREFIX_KEYS);
  return () => {
    const current = get?.();
    if (current !== source) {
      source = current;
      keys = new HerdrPrefixKeys(current ?? DEFAULT_PREFIX_KEYS);
    }
    return keys;
  };
}
