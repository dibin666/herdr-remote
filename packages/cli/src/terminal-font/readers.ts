// Each terminal's own settings, read the way that terminal reads them.

import path from 'node:path';
import { type PlistValue, parseBinaryPlist, unarchiveKeyed } from '../binary-plist.js';
import {
  configHome,
  type Deps,
  dataHome,
  expandHome,
  type FontSetting,
  pointsToPx,
  positiveNumber,
} from './deps.js';
import { familyForPostScriptName } from './files.js';
import {
  firstCssFamily,
  optionValue,
  parseFontconfigPattern,
  parseGVariantString,
  parseIni,
  parseJsonc,
  parsePangoFontDescription,
  parseQtFontString,
  parseTomlSubset,
  parseXFontName,
  xResource,
  xrmResources,
} from './formats.js';

type PlistDict = { [key: string]: PlistValue };

function gsettingsGet(deps: Deps, schema: string, key: string): string | null {
  const result = deps.run('gsettings', ['get', schema, key]);
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

/** A GNOME-style profile: its own font, or the desktop's monospace font. */
function readGSettingsProfileFont(
  deps: Deps,
  {
    schema,
    path: profilePath,
    fontKey = 'font',
  }: { schema: string; path: string; fontKey?: string },
): FontSetting | null {
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

function systemMonospaceFont(deps: Deps): FontSetting | null {
  return parsePangoFontDescription(
    parseGVariantString(gsettingsGet(deps, 'org.gnome.desktop.interface', 'monospace-font-name')),
  );
}

export const READERS: Record<string, (deps: Deps) => FontSetting | null> = {
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
    const query = (property: string) => {
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
    const settings: Record<string, string> = {};
    const visit = (file: string, depth: number) => {
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
    const merged: Record<string, unknown> = {};
    const visit = (file: string, depth: number) => {
      const text = deps.readFile(file);
      if (text === null || depth > 4) return false;
      const values = parseTomlSubset(text);
      // Imports come first; the importing file overrides them.
      for (const imported of [
        ...((values.import as string[] | undefined) || []),
        ...((values['general.import'] as string[] | undefined) || []),
      ]) {
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
    const settings: { families: string[]; size: string | undefined } = {
      families: [],
      size: undefined,
    };
    const visit = (file: string, depth: number) => {
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
    const bookmarks = prefs?.['New Bookmarks'];
    const profiles = (Array.isArray(bookmarks) ? bookmarks : []) as (PlistDict | null)[];
    const profile =
      profiles.find((candidate) => candidate?.Guid === prefs?.['Default Bookmark Guid']) ||
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
    const profile = (prefs['Window Settings'] as PlistDict | undefined)?.[String(name)] as
      | PlistDict
      | undefined;
    // A profile that was never given a font draws with Terminal's own default,
    // SF Mono 11 since macOS 10.15.
    let postscript = 'SFMono-Regular';
    let points = 11;
    const archived = profile?.Font;
    if (Buffer.isBuffer(archived)) {
      // An archived NSFont: its PostScript name and point size.
      const font = unarchiveKeyed(parseBinaryPlist(archived)) as
        | { NSName?: unknown; NSSize?: unknown }
        | undefined;
      if (typeof font?.NSName === 'string' && font.NSName) postscript = font.NSName;
      if (Number(font?.NSSize) > 0) points = Number(font?.NSSize);
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
function readPreferences(domain: string, deps: Deps): PlistDict | null {
  const data = deps.readBuffer(path.join(deps.home, 'Library', 'Preferences', `${domain}.plist`));
  if (!data) return null;
  try {
    return parseBinaryPlist(data) as PlistDict;
  } catch {
    return null;
  }
}

/** The X resource database, as `xrdb -query` prints it: `name:\tvalue`. */
function xResources(deps: Deps): [string, string][] {
  const result = deps.run('xrdb', ['-query']);
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line): [string, string] | null => {
      const colon = line.indexOf(':');
      return colon === -1 ? null : [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    })
    .filter((entry): entry is [string, string] => entry !== null);
}
