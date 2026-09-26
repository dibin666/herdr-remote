// The drawers that open above the key bar: function keys, control chords, and
// the symbols a phone keyboard buries three layers deep.

import { useSettings } from '../../context/TerminalContext';
import type { TranslationKey } from '../../i18n';
import { ANSI_KEYS } from '../../protocol/keyEncoder';
import { cn } from '../../utils/cn';
import { CAP_BASE, CAP_IDLE, CHORD_TONE_CLASS, type ChordTone } from './caps';

type PressKey = (keySeq: string, modifiable?: boolean) => void;

const DRAWER_ROW =
  'scrollbar-none flex items-center gap-1 overflow-x-auto border-b border-tui-border-dim bg-tui-crust p-1.5';

export function FnKeysDrawer({ capHeight, onKey }: { capHeight: string; onKey: PressKey }) {
  return (
    <div className="grid grid-cols-6 gap-1 border-b border-tui-border-dim bg-tui-crust p-1.5 sm:grid-cols-12">
      {([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const).map((n) => {
        const fKey = `F${n}` as keyof typeof ANSI_KEYS;
        return (
          <button
            key={fKey}
            type="button"
            onClick={() => onKey(ANSI_KEYS[fKey])}
            className={cn(CAP_BASE, CAP_IDLE, capHeight)}
          >
            F{n}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A chord in the quick drawer: the sequence, then what it does to the job.
 * `SIGINT` next to `^C` is the terminal's own vocabulary, not a tooltip.
 */
interface QuickChord {
  code: string;
  caption: string;
  title: TranslationKey;
  badge: TranslationKey;
  tone?: ChordTone;
}

const QUICK_CHORDS: readonly QuickChord[] = [
  {
    code: ANSI_KEYS.CTRL_C,
    caption: '^C',
    title: 'virtualKeyboard.ctrlCTitle',
    badge: 'virtualKeyboard.badgeSigint',
    tone: 'bad',
  },
  {
    code: ANSI_KEYS.CTRL_D,
    caption: '^D',
    title: 'virtualKeyboard.ctrlDTitle',
    badge: 'virtualKeyboard.badgeEof',
  },
  {
    code: ANSI_KEYS.CTRL_Z,
    caption: '^Z',
    title: 'virtualKeyboard.ctrlZTitle',
    badge: 'virtualKeyboard.badgeTstp',
    tone: 'warn',
  },
  {
    code: ANSI_KEYS.CTRL_L,
    caption: '^L',
    title: 'virtualKeyboard.ctrlLTitle',
    badge: 'virtualKeyboard.badgeClear',
  },
  {
    code: ANSI_KEYS.CTRL_R,
    caption: '^R',
    title: 'virtualKeyboard.ctrlRTitle',
    badge: 'virtualKeyboard.badgeSearch',
  },
  {
    code: ANSI_KEYS.CTRL_A,
    caption: '^A',
    title: 'virtualKeyboard.ctrlATitle',
    badge: 'virtualKeyboard.badgeStart',
  },
  {
    code: ANSI_KEYS.CTRL_E,
    caption: '^E',
    title: 'virtualKeyboard.ctrlETitle',
    badge: 'virtualKeyboard.badgeEnd',
  },
  {
    code: ANSI_KEYS.CTRL_K,
    caption: '^K',
    title: 'virtualKeyboard.ctrlKTitle',
    badge: 'virtualKeyboard.badgeKill',
  },
];

export function ChordsDrawer({ capHeight, onKey }: { capHeight: string; onKey: PressKey }) {
  const { t } = useSettings();
  return (
    <div className={DRAWER_ROW}>
      {QUICK_CHORDS.map((chord) => (
        <button
          key={chord.caption}
          type="button"
          onClick={() => onKey(chord.code, false)}
          className={cn(
            CAP_BASE,
            capHeight,
            'gap-1.5 px-2',
            CHORD_TONE_CLASS[chord.tone ?? 'default'],
          )}
          title={t(chord.title)}
        >
          <span className="font-bold">{chord.caption}</span>
          <span className="text-tui-sm opacity-70">{t(chord.badge)}</span>
        </button>
      ))}
    </div>
  );
}

const SYMBOLS = [
  '|',
  '~',
  '/',
  '\\',
  '-',
  '_',
  '$',
  '&',
  ';',
  ':',
  '`',
  '"',
  "'",
  '>',
  '<',
  '=',
  '#',
  '@',
  '{',
  '}',
  '[',
  ']',
];

export function SymbolsDrawer({
  squareKeyClass,
  onKey,
}: {
  squareKeyClass: string;
  onKey: PressKey;
}) {
  return (
    <div className={DRAWER_ROW}>
      {SYMBOLS.map((sym) => (
        <button
          key={sym}
          type="button"
          onClick={() => onKey(sym, true)}
          className={cn(CAP_BASE, CAP_IDLE, squareKeyClass, 'font-bold')}
        >
          {sym}
        </button>
      ))}
    </div>
  );
}
