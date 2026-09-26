import { en, type TranslationSchema } from './en';
import { zh } from './zh';

export type Language = 'en' | 'zh';
export type { TranslationSchema };

/** Every dotted path to a string in the schema: `'header.appName'`, … */
type Leaves<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Leaves<T[K]>}`;
}[keyof T & string];

export type TranslationKey = Leaves<TranslationSchema>;

export type TranslationParams = Record<string, string | number>;

/** Look a key up in the current language; checked against the schema at compile time. */
export type Translate = (key: TranslationKey, params?: TranslationParams) => string;

const translations: Record<Language, TranslationSchema> = {
  en,
  zh,
};

/**
 * Resolves a nested translation key path like 'header.terminalTab'
 * and replaces `{param}` placeholders if params are provided.
 */
export function translate(lang: Language, path: string, params?: TranslationParams): string {
  const dict = translations[lang] || translations.en;
  const parts = path.split('.');
  let current: unknown = dict;

  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      // Fallback to English
      let fallback: unknown = translations.en;
      for (const p of parts) {
        if (fallback && typeof fallback === 'object' && p in fallback) {
          fallback = (fallback as Record<string, unknown>)[p];
        } else {
          return path;
        }
      }
      current = fallback;
      break;
    }
  }

  if (typeof current !== 'string') {
    return path;
  }

  if (params) {
    let formatted = current;
    for (const [k, v] of Object.entries(params)) {
      formatted = formatted.replaceAll(`{${k}}`, String(v));
    }
    return formatted;
  }

  return current;
}

export type ServerErrorCode = keyof TranslationSchema['serverErrors'];

/** Whether this interface can say `code` in its own words; see `serverErrors`. */
export function isServerErrorCode(code: unknown): code is ServerErrorCode {
  return typeof code === 'string' && Object.hasOwn(en.serverErrors, code);
}
