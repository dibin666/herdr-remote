import { en } from './en';
import { zh } from './zh';
import { Language, TranslationSchema } from './types';

export * from './types';
export { en, zh };

export const translations: Record<Language, TranslationSchema> = {
  en,
  zh,
};

/**
 * Resolves a nested translation key path like 'header.terminalTab'
 * and replaces `{param}` placeholders if params are provided.
 */
export function translate(
  lang: Language,
  path: string,
  params?: Record<string, string | number>
): string {
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
