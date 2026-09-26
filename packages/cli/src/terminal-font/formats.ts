// The formats terminal settings come in: INI, GVariant, Pango and Qt font
// strings, fontconfig patterns, JSONC, a TOML subset and X resources.

import { type FontSetting, pointsToPx, positiveNumber } from './deps.js';

type TomlValue = string | number | string[];

/** `[section]` / `key=value` files: konsolerc, kdeglobals, terminalrc, foot.ini. */
export function parseIni(text: unknown): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = { '': {} };
  let current = sections[''];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = sections[header[1].trim()] ||= {};
      continue;
    }
    const equals = line.indexOf('=');
    if (equals === -1) continue;
    current[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
  }
  return sections;
}

/** A GSettings value as printed by `gsettings get`: `'text'`, `true`, `@as []`. */
export function parseGVariantString(output: unknown): string | null {
  const text = String(output || '').trim();
  const quoted = /^'((?:[^'\\]|\\.)*)'$/.exec(text) || /^"((?:[^"\\]|\\.)*)"$/.exec(text);
  if (!quoted) return null;
  return quoted[1].replace(/\\(.)/g, '$1');
}

const PANGO_STYLE_WORDS = new Set([
  'normal',
  'roman',
  'oblique',
  'italic',
  'small-caps',
  'all-small-caps',
  'petite-caps',
  'all-petite-caps',
  'unicase',
  'title-caps',
  'ultra-condensed',
  'extra-condensed',
  'condensed',
  'semi-condensed',
  'semi-expanded',
  'expanded',
  'extra-expanded',
  'ultra-expanded',
  'thin',
  'ultra-light',
  'extra-light',
  'light',
  'semi-light',
  'demi-light',
  'book',
  'regular',
  'medium',
  'semi-bold',
  'demi-bold',
  'bold',
  'ultra-bold',
  'extra-bold',
  'heavy',
  'black',
  'ultra-black',
  'extra-black',
  'ultra-heavy',
  'extra-heavy',
  'not-rotated',
  'south',
  'upside-down',
  'north',
  'rotated-left',
  'east',
  'rotated-right',
  'west',
]);

/**
 * `JetBrainsMono Nerd Font Bold 9` → family and size.
 *
 * Pango writes `FAMILY-LIST [STYLE-OPTIONS] [SIZE[px]] [@VARIATIONS]`: the
 * size and the style words are peeled off the end, and what is left is the
 * family list, whose first entry is the face the terminal asked for.
 */
export function parsePangoFontDescription(description: unknown): FontSetting | null {
  if (typeof description !== 'string') return null;
  const words = description.trim().split(/\s+/).filter(Boolean);
  while (words.length && words[words.length - 1].startsWith('@')) words.pop();

  let sizePx: number | undefined;
  const size = /^(\d+(?:\.\d+)?)(px)?$/i.exec(words[words.length - 1] || '');
  if (size && words.length > 1) {
    words.pop();
    sizePx = size[2] ? positiveNumber(size[1]) : pointsToPx(size[1]);
  }
  while (words.length > 1) {
    const last = words[words.length - 1].toLowerCase();
    if (!PANGO_STYLE_WORDS.has(last) && !/^weight=\d+$/.test(last)) break;
    words.pop();
  }
  const family = words.join(' ').split(',')[0].trim();
  return family ? { family, sizePx } : null;
}

/** Qt's `QFont::toString()`: `JetBrains Mono,10,-1,5,400,0,...`. */
export function parseQtFontString(value: unknown): FontSetting | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(',');
  const family = (parts[0] || '').trim();
  if (!family) return null;
  const points = Number(parts[1]);
  const pixels = Number(parts[2]);
  const sizePx = points > 0 ? pointsToPx(points) : pixels > 0 ? pixels : undefined;
  return { family, sizePx };
}

/** A fontconfig pattern as foot writes it: `JetBrains Mono:size=10:weight=bold`. */
export function parseFontconfigPattern(value: unknown): FontSetting | null {
  if (typeof value !== 'string') return null;
  const first = value.split(/(?<!\\),/)[0];
  const [rawFamily, ...properties] = first.split(/(?<!\\):/);
  const family = rawFamily.replace(/\\(.)/g, '$1').trim();
  if (!family) return null;
  let sizePx: number | undefined;
  for (const property of properties) {
    const [key, raw] = property.split('=');
    if (key === 'size') sizePx = pointsToPx(raw);
    else if (key === 'pixelsize') sizePx = positiveNumber(raw);
  }
  return { family, sizePx };
}

/** The first entry of a CSS font-family list: `'Fira Code', monospace` → `Fira Code`. */
export function firstCssFamily(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const first = value
    .split(',')[0]
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2')
    .trim();
  return first || null;
}

/** JSON with comments and trailing commas, as VS Code writes its settings. */
export function parseJsonc(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string') return null;
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === '\\') {
        out += text[i + 1] || '';
        i += 1;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (char === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += char;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return null;
  }
}

/**
 * Just enough TOML for Alacritty's font keys: tables, dotted keys, strings,
 * numbers, inline tables and (possibly multi-line) string arrays. Returns a
 * flat `dotted.key → value` map.
 */
export function parseTomlSubset(text: unknown): Record<string, TomlValue> {
  const values: Record<string, TomlValue> = {};
  const lines = String(text || '').split(/\r?\n/);
  let table = '';
  const unquote = (raw: string): string | number | undefined => {
    const value = raw.trim();
    const basic = /^"((?:[^"\\]|\\.)*)"/.exec(value);
    if (basic) return basic[1].replace(/\\(.)/g, '$1');
    const literal = /^'([^']*)'/.exec(value);
    if (literal) return literal[1];
    const number = Number(value.replace(/#.*$/, '').trim());
    return Number.isFinite(number) ? number : undefined;
  };
  const keyPath = (raw: string) =>
    raw.split('.').map((part) => part.trim().replace(/^(['"])(.*)\1$/, '$2'));
  const assign = (prefix: string, rawKey: string, rawValue: string): void => {
    const key = [...(prefix ? [prefix] : []), ...keyPath(rawKey)].join('.');
    const value = rawValue.trim();
    if (value.startsWith('{')) {
      const body = value.slice(1, value.lastIndexOf('}'));
      for (const pair of body.split(/,(?=(?:[^"']|"[^"]*"|'[^']*')*$)/)) {
        const equals = pair.indexOf('=');
        if (equals !== -1) assign(key, pair.slice(0, equals), pair.slice(equals + 1));
      }
      return;
    }
    if (value.startsWith('[')) {
      values[key] = [...value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
      return;
    }
    const parsed = unquote(value);
    if (parsed !== undefined) values[key] = parsed;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[([^[\]]+)\]/.exec(line);
    if (header) {
      table = keyPath(header[1]).join('.');
      continue;
    }
    if (line.startsWith('[[')) {
      table = '\0';
      continue;
    }
    if (table === '\0') continue;
    const equals = line.indexOf('=');
    if (equals === -1) continue;
    let rawValue = line.slice(equals + 1);
    // An array may span lines; gather it before assigning.
    if (rawValue.trim().startsWith('[') && !rawValue.includes(']')) {
      while (index + 1 < lines.length && !rawValue.includes(']')) {
        index += 1;
        rawValue += ` ${lines[index].trim()}`;
      }
    }
    assign(table, line.slice(0, equals), rawValue);
  }
  return values;
}

/** The last value given to any of `names` on a command line. */
export function optionValue(args: string[], names: string[]): string | null {
  let value: string | null = null;
  for (let i = 0; i < args.length - 1; i += 1) {
    if (names.includes(args[i])) value = args[i + 1];
  }
  return value;
}

/** `-xrm 'XTerm*faceName: Hack'` entries, in the shape `xResources` returns. */
export function xrmResources(args: string[]): [string, string][] {
  const entries: [string, string][] = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] !== '-xrm') continue;
    const colon = args[i + 1].indexOf(':');
    if (colon !== -1)
      entries.push([args[i + 1].slice(0, colon).trim(), args[i + 1].slice(colon + 1).trim()]);
  }
  return entries;
}

/**
 * The value X would give `<class>.<...>.<resource>`, simplified to what
 * terminal users write: `XTerm*faceName`, `xterm.vt100.faceName`, `*faceName`.
 * A named class wins over the bare wildcard.
 */
export function xResource(
  resources: [string, string][],
  classes: string[],
  resource: string,
): string | null {
  let named: string | null = null;
  let wildcard: string | null = null;
  // Later entries win: `-xrm` options are appended after the database.
  for (const [name, value] of resources) {
    const parts = name.split(/[.*]/).filter(Boolean);
    if (parts[parts.length - 1] !== resource || !value) continue;
    if (parts.length === 1) wildcard = value;
    else if (classes.includes(parts[0])) named = value;
  }
  return named ?? wildcard;
}

/**
 * An X terminal's font name: `xft:JetBrains Mono:size=11` (FreeType, any list
 * takes its first entry) or an XLFD `-misc-dejavu sans mono-medium-r-normal--14-…`.
 * A bare core-font alias (`fixed`, `9x15`) names a bitmap font: no answer —
 * except in xterm's `faceName`, which is always a FreeType pattern.
 */
export function parseXFontName(value: unknown, { bareIsPattern = false } = {}): FontSetting | null {
  const first = String(value || '')
    .split(/,(?=\s*(?:xft:|-))/)[0]
    .trim();
  if (/^xft:/i.test(first)) return parseFontconfigPattern(first.slice(4));
  if (first.startsWith('-')) {
    const fields = first.split('-');
    const family = (fields[2] || '').trim();
    if (!family || family === '*' || /^(fixed|misc)$/i.test(family)) return null;
    const pixels = Number(fields[7]);
    const decipoints = Number(fields[8]);
    return {
      family,
      sizePx: pixels > 0 ? pixels : decipoints > 0 ? pointsToPx(decipoints / 10) : undefined,
    };
  }
  if (!first) return null;
  return bareIsPattern || first.includes(':') ? parseFontconfigPattern(first) : null;
}
