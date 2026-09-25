import en from './en.js';
import zh from './zh.js';

export type Locale = 'en' | 'zh';
export type Catalogue = Record<string, string>;
export type Interpolations = Record<string, string | number>;

/** A bound lookup: `t(key, values)`, plus the locale it speaks. */
export interface Translate {
  (key: string, values?: Interpolations): string;
  locale: string;
  has(key: string): boolean;
}

const CATALOGUES: Record<Locale, Catalogue> = { en, zh };
const DEFAULT_LOCALE: Locale = 'en';

function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && Object.hasOwn(CATALOGUES, value);
}

/**
 * Work out the interface language from the environment.
 *
 * Order matters: an explicit override wins, then the saved preference, then the
 * POSIX locale variables in the order the C library itself consults them.
 */
function detectLocale({
  env = process.env,
  preference = 'auto',
}: {
  env?: NodeJS.ProcessEnv;
  preference?: string | null;
} = {}): Locale {
  if (preference && preference !== 'auto' && isLocale(preference)) return preference;
  if (isLocale(env.HERDR_REMOTE_LANG)) return env.HERDR_REMOTE_LANG;

  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || env.LANGUAGE || '';
  const primary = String(raw).split(/[:.@]/)[0].toLowerCase();
  if (primary.startsWith('zh')) return 'zh';
  return DEFAULT_LOCALE;
}

function interpolate(template: string, values?: Interpolations): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}

/**
 * Build a translator for a locale.
 *
 * A missing key falls back to English and finally to the key itself, so a typo
 * shows up as a visible key rather than an empty gap in the layout.
 */
function createTranslator(locale: string = DEFAULT_LOCALE): Translate {
  const active = isLocale(locale) ? CATALOGUES[locale] : CATALOGUES[DEFAULT_LOCALE];
  const fallback = CATALOGUES[DEFAULT_LOCALE];
  const t = (key: string, values?: Interpolations) => {
    const template = active[key] ?? fallback[key] ?? key;
    return interpolate(template, values);
  };
  return Object.assign(t, {
    locale,
    has: (key: string) => Object.hasOwn(active, key),
  });
}

export { CATALOGUES, DEFAULT_LOCALE, detectLocale, createTranslator, interpolate };
