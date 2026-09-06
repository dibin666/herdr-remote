'use strict';

const en = require('./en');
const zh = require('./zh');

const CATALOGUES = { en, zh };
const DEFAULT_LOCALE = 'en';

/**
 * Work out the interface language from the environment.
 *
 * Order matters: an explicit override wins, then the saved preference, then the
 * POSIX locale variables in the order the C library itself consults them.
 */
function detectLocale({ env = process.env, preference = 'auto' } = {}) {
  if (preference && preference !== 'auto' && CATALOGUES[preference]) return preference;
  if (env.HERDR_REMOTE_LANG && CATALOGUES[env.HERDR_REMOTE_LANG]) return env.HERDR_REMOTE_LANG;

  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || env.LANGUAGE || '';
  const primary = String(raw).split(/[:.@]/)[0].toLowerCase();
  if (primary.startsWith('zh')) return 'zh';
  return DEFAULT_LOCALE;
}

function interpolate(template, values) {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  ));
}

/**
 * Build a translator for a locale.
 *
 * A missing key falls back to English and finally to the key itself, so a typo
 * shows up as a visible key rather than an empty gap in the layout.
 */
function createTranslator(locale = DEFAULT_LOCALE) {
  const active = CATALOGUES[locale] || CATALOGUES[DEFAULT_LOCALE];
  const fallback = CATALOGUES[DEFAULT_LOCALE];
  const t = (key, values) => {
    const template = active[key] ?? fallback[key] ?? key;
    return interpolate(template, values);
  };
  t.locale = locale;
  t.has = (key) => Object.prototype.hasOwnProperty.call(active, key);
  return t;
}

module.exports = {
  CATALOGUES,
  DEFAULT_LOCALE,
  detectLocale,
  createTranslator,
  interpolate,
};
