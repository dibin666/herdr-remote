/**
 * Reads the font the workstation's terminal draws with.
 *
 * Colors can be asked for with OSC queries (see terminal-palette.js); a font
 * cannot. No escape sequence that mainstream emulators answer reports the
 * family, so the host works out which terminal it is running in and reads that
 * terminal's own settings — the same settings dialog the user edited.
 *
 * The answer travels to the browser in `host_hello` as a family name, a size,
 * and the font files the browser may fetch by hash, so a phone draws the
 * session in the face the workstation shows even though it has no such font
 * installed. Nothing here guesses: a terminal this module does not know yields
 * `null`, and the browser keeps its own monospace stack.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  MAX_TERMINAL_FONT_BYTES,
  TERMINAL_FONT_CHUNK_BYTES,
  TERMINAL_FONT_STYLES,
  sanitizeTerminalFont,
} from 'herdr-remote-relay/protocol';
import { runtimeStatePath, stateDir } from './config.js';
import { ensureDir, readJson, writeJsonAtomic } from 'herdr-remote-relay/state';
import { parseBinaryPlist, unarchiveKeyed } from './binary-plist.js';

/** Terminals size fonts in points; CSS pixels are 1/96 inch. */
const PX_PER_PT = 96 / 72;
const COMMAND_TIMEOUT_MS = 3000;

/** Names a terminal accepts in place of a real family. */
const GENERIC_FAMILIES = new Set([
  'monospace',
  'mono',
  'sans',
  'sans-serif',
  'serif',
  'system-ui',
  'ui-monospace',
]);

// ── Small readers ────────────────────────────────────────────────────────

function defaultRun(command, args) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS });
    return { status: result.status, stdout: result.stdout || '' };
  } catch {
    return { status: null, stdout: '' };
  }
}

function defaultReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function defaultReadBuffer(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

function withDefaults(deps = {}) {
  const env = deps.env || process.env;
  return {
    env,
    platform: deps.platform || process.platform,
    home: deps.home || env.HOME || os.homedir(),
    run: deps.run || defaultRun,
    readFile: deps.readFile || defaultReadFile,
    readBuffer: deps.readBuffer || defaultReadBuffer,
    terminalArgs: deps.terminalArgs || [],
  };
}

function configHome(deps) {
  return deps.env.XDG_CONFIG_HOME || path.join(deps.home, '.config');
}

function dataHome(deps) {
  return deps.env.XDG_DATA_HOME || path.join(deps.home, '.local', 'share');
}

function expandHome(filePath, deps) {
  return filePath.startsWith('~/') ? path.join(deps.home, filePath.slice(2)) : filePath;
}

function pointsToPx(points) {
  const value = Number(points);
  return Number.isFinite(value) && value > 0 ? Math.round(value * PX_PER_PT * 10) / 10 : undefined;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

/** `[section]` / `key=value` files: konsolerc, kdeglobals, terminalrc, foot.ini. */
function parseIni(text) {
  const sections = { '': {} };
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
function parseGVariantString(output) {
  const text = String(output || '').trim();
  const quoted = /^'((?:[^'\\]|\\.)*)'$/.exec(text) || /^"((?:[^"\\]|\\.)*)"$/.exec(text);
  if (!quoted) return null;
  return quoted[1].replace(/\\(.)/g, '$1');
}

function gsettingsGet(deps, schema, key) {
  const result = deps.run('gsettings', ['get', schema, key]);
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

// ── Font description formats ────────────────────────────────────────────

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
function parsePangoFontDescription(description) {
  if (typeof description !== 'string') return null;
  const words = description.trim().split(/\s+/).filter(Boolean);
  while (words.length && words[words.length - 1].startsWith('@')) words.pop();

  let sizePx;
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
function parseQtFontString(value) {
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
function parseFontconfigPattern(value) {
  if (typeof value !== 'string') return null;
  const first = value.split(/(?<!\\),/)[0];
  const [rawFamily, ...properties] = first.split(/(?<!\\):/);
  const family = rawFamily.replace(/\\(.)/g, '$1').trim();
  if (!family) return null;
  let sizePx;
  for (const property of properties) {
    const [key, raw] = property.split('=');
    if (key === 'size') sizePx = pointsToPx(raw);
    else if (key === 'pixelsize') sizePx = positiveNumber(raw);
  }
  return { family, sizePx };
}

/** The first entry of a CSS font-family list: `'Fira Code', monospace` → `Fira Code`. */
function firstCssFamily(value) {
  if (typeof value !== 'string') return null;
  const first = value
    .split(',')[0]
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2')
    .trim();
  return first || null;
}

/** JSON with comments and trailing commas, as VS Code writes its settings. */
function parseJsonc(text) {
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
function parseTomlSubset(text) {
  const values = {};
  const lines = String(text || '').split(/\r?\n/);
  let table = '';
  const unquote = (raw) => {
    const value = raw.trim();
    const basic = /^"((?:[^"\\]|\\.)*)"/.exec(value);
    if (basic) return basic[1].replace(/\\(.)/g, '$1');
    const literal = /^'([^']*)'/.exec(value);
    if (literal) return literal[1];
    const number = Number(value.replace(/#.*$/, '').trim());
    return Number.isFinite(number) ? number : undefined;
  };
  const keyPath = (raw) =>
    raw.split('.').map((part) => part.trim().replace(/^(['"])(.*)\1$/, '$2'));
  const assign = (prefix, rawKey, rawValue) => {
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

// ── Which terminal is this? ─────────────────────────────────────────────

/** Process names of the terminals this module can read, innermost wins. */
const TERMINAL_PROCESSES = [
  [/^gnome-terminal/, 'gnome-terminal'],
  [/^ptyxis/, 'ptyxis'],
  [/^tilix$/, 'tilix'],
  [/^konsole$/, 'konsole'],
  [/^xfce4-terminal$/, 'xfce4-terminal'],
  [/^kitty$/, 'kitty'],
  [/^alacritty$/i, 'alacritty'],
  [/^ghostty$/i, 'ghostty'],
  [/^wezterm-gui$/, 'wezterm'],
  [/^foot(client)?$/, 'foot'],
  [/^iTerm2$/, 'iterm2'],
  [/^Terminal$/, 'apple-terminal'],
  [/^xterm$/, 'xterm'],
  [/^(urxvt|urxvtd|rxvt)$/, 'urxvt'],
];

/**
 * The emulator a process runs under, from its own ancestry first.
 *
 * Environment variables leak through nested terminals — a kitty launched from
 * GNOME Terminal still carries `GNOME_TERMINAL_SCREEN` — whereas the nearest
 * emulator process above this one is the one actually drawing it. The
 * environment is the fallback for the common case where there is no such
 * ancestor: Herdr's server runs detached, so everything it starts, this
 * connector included, has lost its terminal parent but kept its variables.
 */
function identifyTerminal({ env = process.env, ancestry = [] } = {}) {
  for (const name of ancestry) {
    const base = path.basename(String(name || ''));
    for (const [pattern, id] of TERMINAL_PROCESSES) {
      if (pattern.test(base)) return id;
    }
  }

  const program = env.TERM_PROGRAM || '';
  if (program === 'vscode') return 'vscode';
  if (program === 'iTerm.app' || env.ITERM_SESSION_ID) return 'iterm2';
  if (program === 'Apple_Terminal') return 'apple-terminal';
  if (program === 'WezTerm' || env.WEZTERM_EXECUTABLE) return 'wezterm';
  if (program === 'ghostty' || env.GHOSTTY_RESOURCES_DIR) return 'ghostty';
  if (env.KITTY_WINDOW_ID || env.TERM === 'xterm-kitty') return 'kitty';
  if (env.ALACRITTY_SOCKET || env.ALACRITTY_WINDOW_ID || env.ALACRITTY_LOG) return 'alacritty';
  if (/^foot/.test(env.TERM || '')) return 'foot';
  if (env.KONSOLE_VERSION || env.KONSOLE_DBUS_SESSION) return 'konsole';
  if (env.PTYXIS_VERSION) return 'ptyxis';
  if (env.TILIX_ID) return 'tilix';
  if (env.GNOME_TERMINAL_SCREEN || env.GNOME_TERMINAL_SERVICE) return 'gnome-terminal';
  if (/^rxvt-unicode/.test(env.TERM || '')) return 'urxvt';
  // Last: a terminal started from xterm inherits this too.
  if (env.XTERM_VERSION) return 'xterm';
  return null;
}

/** This process's ancestors, nearest first: `{ pid, name }`. */
function processLineage({
  platform = process.platform,
  pid = process.ppid,
  run = defaultRun,
} = {}) {
  const lineage = [];
  if (platform === 'linux') {
    let current = pid;
    for (let depth = 0; depth < 32 && current > 1; depth += 1) {
      let stat;
      try {
        stat = fs.readFileSync(`/proc/${current}/stat`, 'utf8');
      } catch {
        break;
      }
      // `pid (comm) state ppid ...`, where comm may itself contain spaces.
      const open = stat.indexOf('(');
      const close = stat.lastIndexOf(')');
      if (open === -1 || close === -1) break;
      lineage.push({ pid: current, name: stat.slice(open + 1, close) });
      current = Number(stat.slice(close + 2).split(' ')[1]);
    }
    return lineage;
  }
  if (platform === 'darwin') {
    const result = run('ps', ['-axo', 'pid=,ppid=,comm=']);
    if (result.status !== 0) return lineage;
    const table = new Map();
    for (const line of result.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (match) table.set(Number(match[1]), { ppid: Number(match[2]), comm: match[3].trim() });
    }
    let current = pid;
    for (let depth = 0; depth < 32 && table.has(current) && current > 1; depth += 1) {
      const entry = table.get(current);
      lineage.push({ pid: current, name: entry.comm });
      current = entry.ppid;
    }
  }
  return lineage;
}

/** Names of this process's ancestors, nearest first. */
function processAncestry(options = {}) {
  return processLineage(options).map((entry) => entry.name);
}

/** The command line of a running process, as its argument list. */
function processArguments(pid, { platform = process.platform } = {}) {
  if (platform !== 'linux') return [];
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

/** The ancestor process that is `source`'s emulator, if any. */
function terminalProcess(source, lineage) {
  return (
    lineage.find((entry) =>
      TERMINAL_PROCESSES.some(
        ([pattern, id]) => id === source && pattern.test(path.basename(String(entry.name || ''))),
      ),
    ) || null
  );
}

// ── Per-terminal settings ───────────────────────────────────────────────

/** A GNOME-style profile: its own font, or the desktop's monospace font. */
function readGSettingsProfileFont(deps, { schema, path: profilePath, fontKey = 'font' }) {
  const useSystem = gsettingsGet(deps, `${schema}:${profilePath}`, 'use-system-font');
  if (useSystem === null) return null;
  if (useSystem === 'false') {
    const font = parsePangoFontDescription(
      parseGVariantString(gsettingsGet(deps, `${schema}:${profilePath}`, fontKey)),
    );
    if (font) return font;
  }
  return systemMonospaceFont(deps);
}

function systemMonospaceFont(deps) {
  return parsePangoFontDescription(
    parseGVariantString(gsettingsGet(deps, 'org.gnome.desktop.interface', 'monospace-font-name')),
  );
}

const READERS = {
  'gnome-terminal': (deps) => {
    const id = parseGVariantString(
      gsettingsGet(deps, 'org.gnome.Terminal.ProfilesList', 'default'),
    );
    if (!id) return null;
    return readGSettingsProfileFont(deps, {
      schema: 'org.gnome.Terminal.Legacy.Profile',
      path: `/org/gnome/terminal/legacy/profiles:/:${id}/`,
    });
  },

  tilix: (deps) => {
    const id = parseGVariantString(
      gsettingsGet(deps, 'com.gexperts.Tilix.ProfilesList', 'default'),
    );
    if (!id) return null;
    return readGSettingsProfileFont(deps, {
      schema: 'com.gexperts.Tilix.Profile',
      path: `/com/gexperts/Tilix/profiles/${id}/`,
    });
  },

  ptyxis: (deps) => {
    const useSystem = gsettingsGet(deps, 'org.gnome.Ptyxis', 'use-system-font');
    if (useSystem === 'false') {
      const font = parsePangoFontDescription(
        parseGVariantString(gsettingsGet(deps, 'org.gnome.Ptyxis', 'font-name')),
      );
      if (font) return font;
    }
    return useSystem === null ? null : systemMonospaceFont(deps);
  },

  konsole: (deps) => {
    const rc = parseIni(deps.readFile(path.join(configHome(deps), 'konsolerc')));
    const profileName = rc['Desktop Entry']?.DefaultProfile;
    if (profileName) {
      const profile = parseIni(deps.readFile(path.join(dataHome(deps), 'konsole', profileName)));
      const font = parseQtFontString(profile.Appearance?.Font);
      if (font) return font;
    }
    // Konsole's built-in profile draws with the desktop's fixed-width font.
    const globals = parseIni(deps.readFile(path.join(configHome(deps), 'kdeglobals')));
    return parseQtFontString(globals.General?.fixed) || { family: 'Hack', sizePx: pointsToPx(10) };
  },

  'xfce4-terminal': (deps) => {
    // 1.1+ keeps its settings in xfconf; older releases in terminalrc.
    const query = (property) => {
      const result = deps.run('xfconf-query', ['-c', 'xfce4-terminal', '-p', property]);
      return result.status === 0 ? result.stdout.trim() : null;
    };
    const rc =
      parseIni(deps.readFile(path.join(configHome(deps), 'xfce4', 'terminal', 'terminalrc')))
        .Configuration || {};
    const useSystem =
      (query('/font-use-system') ?? rc.FontUseSystem ?? 'false').toLowerCase() === 'true';
    if (!useSystem) {
      const font = parsePangoFontDescription(query('/font-name') ?? rc.FontName ?? 'Monospace 12');
      if (font) return font;
    }
    const result = deps.run('xfconf-query', ['-c', 'xsettings', '-p', '/Gtk/MonospaceFontName']);
    return parsePangoFontDescription(result.status === 0 ? result.stdout.trim() : 'Monospace 10');
  },

  kitty: (deps) => {
    const directory = deps.env.KITTY_CONFIG_DIRECTORY || path.join(configHome(deps), 'kitty');
    const settings = {};
    const visit = (file, depth) => {
      const text = deps.readFile(file);
      if (text === null || depth > 4) return;
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const [key, ...rest] = line.split(/\s+/);
        const value = rest.join(' ');
        if (key === 'include') visit(path.resolve(directory, expandHome(value, deps)), depth + 1);
        else if (key === 'font_family' || key === 'font_size') settings[key] = value;
      }
    };
    visit(path.join(directory, 'kitty.conf'), 0);
    // kitty 0.33+ also accepts `font_family family="JetBrains Mono" style=...`.
    const raw = settings.font_family || 'monospace';
    const quoted = /family\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(raw);
    const family = quoted ? quoted[1] || quoted[2] || quoted[3] : raw;
    return { family, sizePx: pointsToPx(settings.font_size || 11) };
  },

  alacritty: (deps) => {
    const candidates = [
      path.join(configHome(deps), 'alacritty', 'alacritty.toml'),
      path.join(configHome(deps), 'alacritty.toml'),
      path.join(deps.home, '.alacritty.toml'),
    ];
    const merged = {};
    const visit = (file, depth) => {
      const text = deps.readFile(file);
      if (text === null || depth > 4) return false;
      const values = parseTomlSubset(text);
      // Imports come first; the importing file overrides them.
      for (const imported of [...(values.import || []), ...(values['general.import'] || [])]) {
        visit(path.resolve(path.dirname(file), expandHome(String(imported), deps)), depth + 1);
      }
      Object.assign(merged, values);
      return true;
    };
    candidates.some((file) => visit(file, 0));
    const fallbackFamily = deps.platform === 'darwin' ? 'Menlo' : 'monospace';
    return {
      family: String(merged['font.normal.family'] || fallbackFamily),
      sizePx: pointsToPx(merged['font.size'] || 11.25),
    };
  },

  ghostty: (deps) => {
    const settings = { families: [], size: undefined };
    const visit = (file, depth) => {
      const text = deps.readFile(file);
      if (text === null || depth > 4) return;
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const equals = line.indexOf('=');
        if (equals === -1) continue;
        const key = line.slice(0, equals).trim();
        const value = line
          .slice(equals + 1)
          .trim()
          .replace(/^"(.*)"$/, '$1');
        if (key === 'font-family') {
          // An empty value resets the list, per Ghostty's repeatable keys.
          if (value) settings.families.push(value);
          else settings.families = [];
        } else if (key === 'font-size') {
          settings.size = value;
        } else if (key === 'config-file') {
          const target = expandHome(value.replace(/^\?/, ''), deps);
          visit(path.resolve(path.dirname(file), target), depth + 1);
        }
      }
    };
    visit(path.join(configHome(deps), 'ghostty', 'config'), 0);
    if (deps.platform === 'darwin') {
      visit(
        path.join(deps.home, 'Library', 'Application Support', 'com.mitchellh.ghostty', 'config'),
        0,
      );
    }
    // Ghostty ships JetBrains Mono inside the binary and draws with it by default.
    return {
      family: settings.families[0] || 'JetBrains Mono',
      sizePx: pointsToPx(settings.size || (deps.platform === 'darwin' ? 13 : 12)),
    };
  },

  wezterm: (deps) => {
    const result = deps.run('wezterm', ['ls-fonts']);
    const listing = result.status === 0 ? result.stdout : '';
    const match =
      /family\s*=\s*"([^"]+)"/.exec(listing) ||
      /font_with_fallback\(\{[\s\S]*?"([^"]+)"/.exec(listing);
    let sizePt = 12;
    for (const file of [
      path.join(deps.home, '.wezterm.lua'),
      path.join(configHome(deps), 'wezterm', 'wezterm.lua'),
    ]) {
      const size = /font_size\s*=\s*(\d+(?:\.\d+)?)/.exec(deps.readFile(file) || '');
      if (size) {
        sizePt = Number(size[1]);
        break;
      }
    }
    // WezTerm, like Ghostty, embeds JetBrains Mono as its default.
    return { family: match ? match[1] : 'JetBrains Mono', sizePx: pointsToPx(sizePt) };
  },

  foot: (deps) => {
    const ini = parseIni(deps.readFile(path.join(configHome(deps), 'foot', 'foot.ini')));
    const value = ini.main?.font || ini['']?.font || 'monospace:size=8';
    return parseFontconfigPattern(value);
  },

  vscode: (deps) => {
    const base =
      deps.platform === 'darwin'
        ? path.join(deps.home, 'Library', 'Application Support')
        : configHome(deps);
    for (const product of ['Code', 'Cursor', 'Code - Insiders', 'VSCodium', 'Windsurf']) {
      const settings = parseJsonc(deps.readFile(path.join(base, product, 'User', 'settings.json')));
      if (!settings) continue;
      const family =
        firstCssFamily(settings['terminal.integrated.fontFamily']) ||
        firstCssFamily(settings['editor.fontFamily']);
      const sizePx =
        positiveNumber(settings['terminal.integrated.fontSize']) ||
        positiveNumber(settings['editor.fontSize']) ||
        14;
      if (family) return { family, sizePx };
    }
    return { family: deps.platform === 'darwin' ? 'Menlo' : 'Droid Sans Mono', sizePx: 14 };
  },

  iterm2: (deps) => {
    const prefs = readPreferences('com.googlecode.iterm2', deps);
    const profiles = Array.isArray(prefs?.['New Bookmarks']) ? prefs['New Bookmarks'] : [];
    const profile =
      profiles.find((candidate) => candidate?.Guid === prefs['Default Bookmark Guid']) ||
      profiles[0];
    // `JetBrainsMonoNF-Regular 13`: a PostScript name, then the size in points.
    const match = /^(.+?)\s+(\d+(?:\.\d+)?)$/.exec(String(profile?.['Normal Font'] || '').trim());
    if (!match) return null;
    const family = familyForPostScriptName(match[1], deps);
    return family ? { family, sizePx: pointsToPx(match[2]) } : null;
  },

  'apple-terminal': (deps) => {
    const prefs = readPreferences('com.apple.Terminal', deps);
    if (!prefs) return null;
    const name = prefs['Default Window Settings'] || prefs['Startup Window Settings'] || 'Basic';
    const profile = prefs['Window Settings']?.[name];
    // A profile that was never given a font draws with Terminal's own default,
    // SF Mono 11 since macOS 10.15.
    let postscript = 'SFMono-Regular';
    let points = 11;
    if (Buffer.isBuffer(profile?.Font)) {
      // An archived NSFont: its PostScript name and point size.
      const font = unarchiveKeyed(parseBinaryPlist(profile.Font));
      if (typeof font?.NSName === 'string' && font.NSName) postscript = font.NSName;
      if (Number(font?.NSSize) > 0) points = Number(font.NSSize);
    }
    const family = familyForPostScriptName(postscript, deps);
    return family ? { family, sizePx: pointsToPx(points) } : null;
  },

  xterm: (deps) => {
    // The emulator's own command line (`-fa`, `-fs`, `-xrm`) over the X
    // resources, the way xterm itself ranks them. Without a faceName xterm
    // draws with a bitmap core font, which no browser can load: no answer.
    const classes = ['XTerm', 'xterm', 'UXTerm', 'uxterm'];
    const args = deps.terminalArgs || [];
    const resources = [...xResources(deps), ...xrmResources(args)];
    const face =
      optionValue(args, ['-fa', '-faceName']) || xResource(resources, classes, 'faceName');
    if (!face) return null;
    const font = parseXFontName(face, { bareIsPattern: true });
    if (!font) return null;
    const size = Number(
      optionValue(args, ['-fs', '-faceSize']) || xResource(resources, classes, 'faceSize'),
    );
    return size > 0 ? { ...font, sizePx: pointsToPx(size) } : font;
  },

  urxvt: (deps) => {
    const args = deps.terminalArgs || [];
    const resources = [...xResources(deps), ...xrmResources(args)];
    const font =
      optionValue(args, ['-fn']) ||
      xResource(resources, ['URxvt', 'urxvt', 'Rxvt', 'rxvt'], 'font');
    return font ? parseXFontName(font) : null;
  },
};

/**
 * A macOS preferences file, parsed. These are binary plists; one that is not
 * (edited by hand) is left alone rather than guessed at.
 */
function readPreferences(domain, deps) {
  const data = deps.readBuffer(path.join(deps.home, 'Library', 'Preferences', `${domain}.plist`));
  if (!data) return null;
  try {
    return parseBinaryPlist(data);
  } catch {
    return null;
  }
}

/** The last value given to any of `names` on a command line. */
function optionValue(args, names) {
  let value = null;
  for (let i = 0; i < args.length - 1; i += 1) {
    if (names.includes(args[i])) value = args[i + 1];
  }
  return value;
}

/** `-xrm 'XTerm*faceName: Hack'` entries, in the shape `xResources` returns. */
function xrmResources(args) {
  const entries = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] !== '-xrm') continue;
    const colon = args[i + 1].indexOf(':');
    if (colon !== -1)
      entries.push([args[i + 1].slice(0, colon).trim(), args[i + 1].slice(colon + 1).trim()]);
  }
  return entries;
}

/** The X resource database, as `xrdb -query` prints it: `name:\tvalue`. */
function xResources(deps) {
  const result = deps.run('xrdb', ['-query']);
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => {
      const colon = line.indexOf(':');
      return colon === -1 ? null : [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    })
    .filter(Boolean);
}

/**
 * The value X would give `<class>.<...>.<resource>`, simplified to what
 * terminal users write: `XTerm*faceName`, `xterm.vt100.faceName`, `*faceName`.
 * A named class wins over the bare wildcard.
 */
function xResource(resources, classes, resource) {
  let named = null;
  let wildcard = null;
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
function parseXFontName(value, { bareIsPattern = false } = {}) {
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

// ── Font files ──────────────────────────────────────────────────────────

const FACE_PATTERNS = {
  regular: ':weight=regular:slant=roman',
  bold: ':weight=bold:slant=roman',
  italic: ':weight=regular:slant=italic',
  boldItalic: ':weight=bold:slant=italic',
};

function escapeFontconfig(value) {
  return value.replace(/([\\\-:,])/g, '\\$1');
}

/** `00 01 00 00` / `true` are TrueType, `OTTO` is CFF OpenType. */
function sfntFormat(header) {
  if (!header || header.length < 4) return null;
  const tag = header.subarray(0, 4).toString('latin1');
  if (tag === '\x00\x01\x00\x00' || tag === 'true') return 'truetype';
  if (tag === 'OTTO') return 'opentype';
  return null;
}

function readHeader(filePath, length) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch {}
  }
}

/**
 * The family, subfamily and PostScript names in a TTF/OTF `name` table. Used
 * where fontconfig is absent — a stock macOS — to find a family's files.
 */
function readSfntNames(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    if (!sfntFormat(head)) return null;
    const tables = head.readUInt16BE(4);
    const directory = Buffer.alloc(tables * 16);
    fs.readSync(fd, directory, 0, directory.length, 12);
    let offset = -1;
    let length = 0;
    for (let i = 0; i < tables; i += 1) {
      if (directory.toString('latin1', i * 16, i * 16 + 4) === 'name') {
        offset = directory.readUInt32BE(i * 16 + 8);
        length = directory.readUInt32BE(i * 16 + 12);
      }
    }
    if (offset < 0 || length > 1024 * 1024) return null;
    const table = Buffer.alloc(length);
    fs.readSync(fd, table, 0, length, offset);
    const count = table.readUInt16BE(2);
    const strings = table.readUInt16BE(4);
    const names = {};
    for (let i = 0; i < count; i += 1) {
      const record = 6 + i * 12;
      const platformId = table.readUInt16BE(record);
      const languageId = table.readUInt16BE(record + 4);
      const nameId = table.readUInt16BE(record + 6);
      const size = table.readUInt16BE(record + 8);
      const start = strings + table.readUInt16BE(record + 10);
      if (![1, 2, 6, 16, 17].includes(nameId) || start + size > table.length) continue;
      let text;
      if ((platformId === 3 || platformId === 0) && size % 2 === 0) {
        if (platformId === 3 && languageId !== 0x409 && names[nameId]) continue;
        const utf16 = Buffer.from(table.subarray(start, start + size));
        text = utf16.swap16().toString('utf16le');
      } else if (platformId === 1 && !names[nameId]) {
        text = table.toString('latin1', start, start + size);
      }
      if (text) names[nameId] = text;
    }
    return {
      family: names[16] || names[1] || null,
      subfamily: names[17] || names[2] || '',
      postscript: names[6] || null,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch {}
  }
}

function macFontFiles(deps) {
  const roots = [
    path.join(deps.home, 'Library', 'Fonts'),
    '/Library/Fonts',
    '/System/Library/Fonts',
  ];
  const files = [];
  const walk = (directory, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 2) walk(full, depth + 1);
      else if (/\.(ttf|otf)$/i.test(entry.name)) files.push(full);
    }
  };
  for (const root of roots) walk(root, 0);
  return files;
}

/** Apple's own terminal faces, which live outside the font folders. */
const APPLE_POSTSCRIPT_FAMILIES = [
  [/^\.?SF(NS)?Mono/, 'SF Mono'],
  [/^Menlo-/, 'Menlo'],
  [/^Monaco$/, 'Monaco'],
  [/^Courier(New)?/, 'Courier New'],
  [/^AndaleMono$/, 'Andale Mono'],
];

function familyForPostScriptName(postscript, deps) {
  const apple = APPLE_POSTSCRIPT_FAMILIES.find(([pattern]) => pattern.test(postscript));
  if (apple && deps.platform === 'darwin') return apple[1];
  const listed = deps.run('fc-list', [`:postscriptname=${escapeFontconfig(postscript)}`, 'family']);
  if (listed.status === 0 && listed.stdout.trim())
    return listed.stdout.trim().split('\n')[0].split(',')[0].trim();
  if (deps.platform !== 'darwin') return null;
  for (const file of macFontFiles(deps)) {
    const names = readSfntNames(file);
    if (names?.postscript === postscript) return names.family;
  }
  return null;
}

function styleOfSubfamily(subfamily) {
  const text = String(subfamily || '').toLowerCase();
  const bold = /\bbold\b/.test(text) && !/(semi|demi|extra|ultra)\s*bold/.test(text);
  const italic = /italic|oblique/.test(text);
  if (bold && italic) return 'boldItalic';
  if (bold) return 'bold';
  if (italic) return 'italic';
  return /^(regular|normal|book|roman)$/.test(text.trim()) ? 'regular' : null;
}

/** Candidate files per style, from fontconfig or, failing that, a scan. */
function locateFaceFiles(family, deps) {
  const located = {};
  let fontconfig = false;
  for (const style of TERMINAL_FONT_STYLES) {
    const result = deps.run('fc-match', [
      '-f',
      '%{file}\n%{family}\n%{index}\n',
      `${escapeFontconfig(family)}${FACE_PATTERNS[style]}`,
    ]);
    if (result.status !== 0) continue;
    fontconfig = true;
    const [file, families = '', index = '0'] = result.stdout.split('\n');
    // fontconfig always answers; an answer in another family means the
    // requested one is not installed. A collection member is not a file a
    // browser can load on its own.
    const names = families.split(',').map((name) => name.trim().toLowerCase());
    if (!file || !names.includes(family.toLowerCase()) || Number(index) !== 0) continue;
    located[style] = file;
  }
  if (fontconfig || deps.platform !== 'darwin') return located;

  for (const file of macFontFiles(deps)) {
    const names = readSfntNames(file);
    if (!names || names.family?.toLowerCase() !== family.toLowerCase()) continue;
    const style = styleOfSubfamily(names.subfamily);
    if (style && !located[style]) located[style] = file;
  }
  return located;
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * The files behind a family, ready to be offered to a browser.
 *
 * A style fontconfig can only satisfy with the regular file is left out: the
 * browser synthesises bold and italic from the regular face just as well, and
 * sending the same file twice would only cost the phone the bytes.
 */
function resolveFontFaces(family, deps = {}) {
  const resolved = withDefaults(deps);
  if (!family || GENERIC_FAMILIES.has(family.toLowerCase())) return [];
  const located = locateFaceFiles(family, resolved);
  const faces = [];
  const usedFiles = new Set();
  for (const style of TERMINAL_FONT_STYLES) {
    const file = located[style];
    if (!file || usedFiles.has(file)) continue;
    // Apple's system fonts (SF Mono, Menlo…) are licensed for Apple devices
    // only; offering them to any browser would redistribute them. An Apple
    // device has them already, and anything else falls back by name.
    if (/^\/System\//.test(file) || /\.app\/Contents\//.test(file)) continue;
    if (style !== 'regular' && !faces.length) continue;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_TERMINAL_FONT_BYTES) continue;
    const format = sfntFormat(readHeader(file, 4));
    if (!format) continue;
    usedFiles.add(file);
    faces.push({
      style,
      format,
      bytes: stat.size,
      sha256: hashFile(file),
      path: file,
      mtimeMs: stat.mtimeMs,
    });
  }
  return faces;
}

/** A file a subset can be cut from; far larger than a face sent whole. */
const MAX_SUBSET_SOURCE_BYTES = 64 * 1024 * 1024;

/** Where fontconfig finds `pattern`: the file, the face's names, its index. */
function locateFont(pattern, deps) {
  const result = deps.run('fc-match', ['-f', '%{file}\n%{family}\n%{index}\n', pattern]);
  if (result.status !== 0) return null;
  const [file, families = '', index = '0'] = result.stdout.split('\n');
  if (!file) return null;
  return {
    file,
    families: families
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
    index: Number(index) || 0,
  };
}

/**
 * Fonts the browser receives a few characters at a time instead of whole:
 *
 * - `cjk`: the face fontconfig falls back to for Chinese under this family —
 *   what the workstation's terminal actually draws Hanzi with. 16–20 MB, and
 *   often inside a collection (.ttc) a browser cannot load anyway.
 * - `all`: the family itself, when it is too large or in a collection to be
 *   sent as a whole file (a CJK programming font like Sarasa Mono).
 *
 * Only regular weights: the browser emboldens them for bold text, which is
 * how a missing bold is drawn everywhere else too.
 */
function resolveSubsetSources(family, faces, deps = {}) {
  const resolved = withDefaults(deps);
  if (!family || GENERIC_FAMILIES.has(family.toLowerCase())) return [];
  const wanted = family.toLowerCase();
  const sources = [];
  const add = (located, scope, name) => {
    if (!located || /^\/System\//.test(located.file) || /\.app\/Contents\//.test(located.file))
      return;
    let stat;
    try {
      stat = fs.statSync(located.file);
    } catch {
      return;
    }
    if (!stat.isFile() || stat.size > MAX_SUBSET_SOURCE_BYTES) return;
    const header = readHeader(located.file, 4);
    if (!sfntFormat(header) && header?.toString('latin1') !== 'ttcf') return;
    // Identifies the face without reading 20 MB: a browser caches by it.
    const sha256 = crypto
      .createHash('sha256')
      .update(`${located.file}\0${located.index}\0${stat.size}\0${stat.mtimeMs}`)
      .digest('hex');
    sources.push({
      family: name,
      style: 'regular',
      scope,
      sha256,
      path: located.file,
      index: located.index,
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  };

  const self = locateFont(`${escapeFontconfig(family)}${FACE_PATTERNS.regular}`, resolved);
  const selfInstalled = self && self.families.some((name) => name.toLowerCase() === wanted);
  if (selfInstalled && !faces.some((face) => face.style === 'regular')) add(self, 'all', family);

  const cjk = locateFont(
    `${escapeFontconfig(family)}:charset=4e00${FACE_PATTERNS.regular}`,
    resolved,
  );
  const coveredBySelf = cjk && cjk.families.some((name) => name.toLowerCase() === wanted);
  if (cjk && !coveredBySelf && cjk.families[0]) add(cjk, 'cjk', cjk.families[0]);
  return sources;
}

/** A generic family is replaced by the real face fontconfig picks for it. */
function concreteFamily(family, deps) {
  if (!GENERIC_FAMILIES.has(String(family).toLowerCase())) return family;
  const result = deps.run('fc-match', ['-f', '%{family[0]}', family]);
  const matched = result.status === 0 ? result.stdout.trim() : '';
  return matched || null;
}

// ── Putting it together ─────────────────────────────────────────────────

/** Reads one terminal's configured font: `{ source, family, sizePx }` or null. */
function readTerminalFont(source, deps = {}) {
  const resolved = withDefaults(deps);
  const reader = READERS[source];
  if (!reader) return null;
  let font;
  try {
    font = reader(resolved);
  } catch {
    return null;
  }
  if (!font?.family) return null;
  const family = concreteFamily(font.family, resolved);
  if (!family) return null;
  return sanitizeDetected({ source, family, sizePx: font.sizePx });
}

/** Identifies the terminal and reads its font. */
function detectTerminalFont({ env = process.env, ancestry, lineage, deps = {} } = {}) {
  const processes =
    lineage ||
    (ancestry ? ancestry.map((name) => ({ pid: 0, name })) : processLineage({ run: deps.run }));
  const source = identifyTerminal({ env, ancestry: processes.map((entry) => entry.name) });
  if (!source) return null;
  // A terminal configured on its command line (xterm's `-fa`) says so there.
  const emulator = terminalProcess(source, processes);
  const terminalArgs = deps.terminalArgs || (emulator?.pid ? processArguments(emulator.pid) : []);
  return readTerminalFont(source, { ...deps, env, terminalArgs });
}

/** What detection reports, before any files are attached. */
function sanitizeDetected(value) {
  const clean = sanitizeTerminalFont(value);
  if (!clean) return null;
  const detected = { source: clean.source || null, family: clean.family };
  if (clean.sizePx) detected.sizePx = clean.sizePx;
  return detected;
}

/** The full record a connector serves from: detection plus local files. */
function describeTerminalFont(detected, deps = {}) {
  if (!detected?.family) return null;
  const faces = resolveFontFaces(detected.family, deps);
  return { ...detected, faces, subsets: resolveSubsetSources(detected.family, faces, deps) };
}

/** The same record with the file paths removed: what may leave this machine. */
function publicTerminalFont(record) {
  return record ? sanitizeTerminalFont(record) : null;
}

/**
 * One slice of a face, by hash. The file is re-checked against what was
 * announced, so an edited font is refused rather than spliced into a browser's
 * copy of the old one.
 */
function readFontChunk(record, sha256, index) {
  const face = record?.faces?.find((candidate) => candidate.sha256 === sha256);
  if (!face) return null;
  const total = Math.ceil(face.bytes / TERMINAL_FONT_CHUNK_BYTES);
  if (!Number.isInteger(index) || index < 0 || index >= total) return null;
  let fd;
  try {
    const stat = fs.statSync(face.path);
    if (stat.size !== face.bytes || stat.mtimeMs !== face.mtimeMs) return null;
    fd = fs.openSync(face.path, 'r');
    const start = index * TERMINAL_FONT_CHUNK_BYTES;
    const length = Math.min(TERMINAL_FONT_CHUNK_BYTES, face.bytes - start);
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, start);
    if (read !== length) return null;
    return { data: buffer, total };
  } catch {
    return null;
  } finally {
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch {}
  }
}

/** Reads a font a parent process already detected. */
function fontFromEnvironment(env = process.env) {
  const raw = env.HERDR_TERM_FONT_JSON;
  if (!raw) return null;
  try {
    return sanitizeDetected(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Remembers the font for a start that has no terminal around it: a service
 * manager's, or Herdr's detached server's.
 */
function rememberTerminalFont(detected) {
  const clean = sanitizeDetected(detected);
  if (!clean) return null;
  try {
    ensureDir(stateDir());
    const state = readJson(runtimeStatePath(), {});
    const previous = state.terminalFont;
    if (!previous || JSON.stringify(previous) !== JSON.stringify(clean)) {
      writeJsonAtomic(runtimeStatePath(), { ...state, terminalFont: clean });
    }
  } catch {
    // A font is a nicety; failing to remember it must not break a start.
  }
  return clean;
}

function rememberedTerminalFont() {
  try {
    return sanitizeDetected(readJson(runtimeStatePath(), {}).terminalFont);
  } catch {
    return null;
  }
}

/**
 * Detect the terminal's font at the entry point, where the terminal's
 * variables and process ancestry are still this process's own, and hand the
 * answer to everything this command starts.
 */
function captureTerminalFont({ env = process.env, detect = detectTerminalFont } = {}) {
  if (env.HERDR_TERM_FONT_JSON) return fontFromEnvironment(env);
  const detected = detect({ env });
  if (!detected) return null;
  env.HERDR_TERM_FONT_JSON = JSON.stringify(detected);
  rememberTerminalFont(detected);
  return detected;
}

/** The font a service start hands its children: inherited, else remembered. */
function resolveHostFont({ env = process.env } = {}) {
  return fontFromEnvironment(env) || rememberedTerminalFont();
}

/**
 * What the connector serves: the terminal's settings read again now, when the
 * terminal is known, so a font changed since the last start is not reported
 * stale; otherwise what was handed down. `refresh` also re-identifies a
 * terminal nobody had named, for a browser that asks to sync.
 */
function loadHostTerminalFont({ env = process.env, refresh = false, deps = {} } = {}) {
  const known = resolveHostFont({ env });
  let current = known?.source ? readTerminalFont(known.source, { ...deps, env }) : null;
  if (!current && refresh && !known) current = detectTerminalFont({ env, deps });
  if (current && JSON.stringify(current) !== JSON.stringify(known)) rememberTerminalFont(current);
  return describeTerminalFont(current || known, deps);
}

export {
  PX_PER_PT,
  parsePangoFontDescription,
  parseQtFontString,
  parseFontconfigPattern,
  parseGVariantString,
  parseTomlSubset,
  parseJsonc,
  parseXFontName,
  xResource,
  firstCssFamily,
  identifyTerminal,
  processAncestry,
  processLineage,
  readTerminalFont,
  detectTerminalFont,
  resolveFontFaces,
  resolveSubsetSources,
  readSfntNames,
  sfntFormat,
  describeTerminalFont,
  publicTerminalFont,
  readFontChunk,
  fontFromEnvironment,
  rememberTerminalFont,
  rememberedTerminalFont,
  captureTerminalFont,
  resolveHostFont,
  loadHostTerminalFont,
};
