'use strict';

// The browser draws a Herdr session in whatever font it has; these tests cover
// how the workstation finds out which font its own terminal uses, and how the
// files behind it are offered without ever sending a path.

process.env.HERDR_REMOTE_UPDATE_CHECK = '0';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const { TERMINAL_FONT_CHUNK_BYTES } = require('herdr-remote-relay/protocol');

const {
  parsePangoFontDescription,
  parseQtFontString,
  parseFontconfigPattern,
  parseTomlSubset,
  parseJsonc,
  identifyTerminal,
  readTerminalFont,
  resolveFontFaces,
  publicTerminalFont,
  readFontChunk,
  fontFromEnvironment,
  captureTerminalFont,
  loadHostTerminalFont,
} = require('../src/terminal-font');

/** A command runner answering from a table, `command args…` → stdout. */
function fakeRun(table) {
  return (command, args) => {
    const key = [command, ...args].join(' ');
    return Object.hasOwn(table, key)
      ? { status: 0, stdout: table[key] }
      : { status: 1, stdout: '' };
  };
}

/** A file reader answering from a table of absolute paths. */
function fakeFiles(files) {
  return (filePath) => (Object.hasOwn(files, filePath) ? files[filePath] : null);
}

const HOME = '/home/you';
const base = { home: HOME, env: { HOME }, platform: 'linux' };

test('Pango descriptions give up their family and size in pixels', () => {
  assert.deepEqual(parsePangoFontDescription('JetBrainsMono Nerd Font 9'), {
    family: 'JetBrainsMono Nerd Font',
    sizePx: 12,
  });
  assert.deepEqual(parsePangoFontDescription('Source Code Pro Semi-Bold Italic 10.5'), {
    family: 'Source Code Pro',
    sizePx: 14,
  });
  assert.deepEqual(parsePangoFontDescription('Hack 16px'), { family: 'Hack', sizePx: 16 });
  assert.deepEqual(parsePangoFontDescription('Fira Code, Noto Sans Mono 11 @wght=450'), {
    family: 'Fira Code',
    sizePx: 14.7,
  });
  assert.deepEqual(parsePangoFontDescription('Monospace'), {
    family: 'Monospace',
    sizePx: undefined,
  });
  assert.equal(parsePangoFontDescription(''), null);
});

test('Qt and fontconfig font strings are read the same way', () => {
  assert.deepEqual(parseQtFontString('JetBrains Mono,10,-1,5,400,0,0,0,0,0'), {
    family: 'JetBrains Mono',
    sizePx: 13.3,
  });
  assert.deepEqual(parseQtFontString('Hack,-1,15,5,50,0,0,0,0,0'), { family: 'Hack', sizePx: 15 });
  assert.deepEqual(
    parseFontconfigPattern('JetBrains Mono:size=10:weight=bold,Noto Color Emoji:size=10'),
    { family: 'JetBrains Mono', sizePx: 13.3 },
  );
  assert.deepEqual(parseFontconfigPattern('monospace:pixelsize=14'), {
    family: 'monospace',
    sizePx: 14,
  });
});

test('the TOML and JSONC subsets read what terminals actually write', () => {
  const toml = parseTomlSubset(
    [
      'import = [',
      '  "~/.config/alacritty/theme.toml",',
      ']',
      '[font]',
      'size = 13.5 # comment',
      'normal = { family = "Iosevka Term", style = "Regular" }',
      '[[hints.enabled]]',
      'command = "xdg-open"',
    ].join('\n'),
  );
  assert.deepEqual(toml.import, ['~/.config/alacritty/theme.toml']);
  assert.equal(toml['font.size'], 13.5);
  assert.equal(toml['font.normal.family'], 'Iosevka Term');
  assert.equal(toml.command, undefined);

  const jsonc = parseJsonc(
    '{\n  // the font\n  "editor.fontFamily": "\'Fira Code\', monospace", /* why */\n  "url": "http://x//y",\n}',
  );
  assert.equal(jsonc['editor.fontFamily'], "'Fira Code', monospace");
  assert.equal(jsonc.url, 'http://x//y');
});

test('the nearest terminal process wins over variables leaked from an outer one', () => {
  const env = { GNOME_TERMINAL_SCREEN: '/org/gnome/Terminal/screen/1', KITTY_WINDOW_ID: '1' };
  assert.equal(identifyTerminal({ env, ancestry: ['fish', 'kitty', 'gnome-terminal-'] }), 'kitty');
  // Herdr's detached server has no terminal parent: the variables decide.
  assert.equal(
    identifyTerminal({ env: { GNOME_TERMINAL_SCREEN: 'x' }, ancestry: ['herdr', 'systemd'] }),
    'gnome-terminal',
  );
  assert.equal(
    identifyTerminal({ env: { TERM_PROGRAM: 'vscode', GNOME_TERMINAL_SCREEN: 'x' }, ancestry: [] }),
    'vscode',
  );
  assert.equal(identifyTerminal({ env: { TERM: 'foot' }, ancestry: [] }), 'foot');
  assert.equal(
    identifyTerminal({ env: { TERM: 'xterm-256color' }, ancestry: ['bash', 'sshd'] }),
    null,
  );
});

test('GNOME Terminal: the default profile font, or the desktop font when it says so', () => {
  const profile = 'org.gnome.Terminal.Legacy.Profile:/org/gnome/terminal/legacy/profiles:/:b1dc/';
  const table = {
    'gsettings get org.gnome.Terminal.ProfilesList default': "'b1dc'\n",
    [`gsettings get ${profile} use-system-font`]: 'false\n',
    [`gsettings get ${profile} font`]: "'JetBrainsMono Nerd Font 9'\n",
    'gsettings get org.gnome.desktop.interface monospace-font-name': "'Noto Sans Mono 10'\n",
  };
  assert.deepEqual(readTerminalFont('gnome-terminal', { ...base, run: fakeRun(table) }), {
    source: 'gnome-terminal',
    family: 'JetBrainsMono Nerd Font',
    sizePx: 12,
  });

  table[`gsettings get ${profile} use-system-font`] = 'true\n';
  assert.deepEqual(readTerminalFont('gnome-terminal', { ...base, run: fakeRun(table) }), {
    source: 'gnome-terminal',
    family: 'Noto Sans Mono',
    sizePx: 13.3,
  });

  // No GSettings to ask (no session bus): no answer, not a guess.
  assert.equal(readTerminalFont('gnome-terminal', { ...base, run: fakeRun({}) }), null);
});

test('config-file terminals: kitty, Alacritty, Ghostty, foot, Konsole, VS Code', () => {
  const config = `${HOME}/.config`;
  const files = {
    [`${config}/kitty/kitty.conf`]: 'font_size 10\ninclude fonts.conf\n',
    [`${config}/kitty/fonts.conf`]: 'font_family family="Cascadia Code" style=Regular\n',
    [`${config}/alacritty/alacritty.toml`]:
      '[general]\nimport = ["fonts.toml"]\n[font]\nsize = 12\n',
    [`${config}/alacritty/fonts.toml`]: '[font.normal]\nfamily = "Hack"\n',
    [`${config}/ghostty/config`]:
      'font-family = Iosevka\nfont-family =\nfont-family = "Maple Mono"\nfont-size = 15\n',
    [`${config}/foot/foot.ini`]: '[main]\nfont=Fira Code:size=9\n',
    [`${config}/konsolerc`]: '[Desktop Entry]\nDefaultProfile=Mine.profile\n',
    [`${HOME}/.local/share/konsole/Mine.profile`]: '[Appearance]\nFont=Hack,11,-1,5,50,0,0,0,0,0\n',
    [`${config}/Code/User/settings.json`]:
      '{ "terminal.integrated.fontFamily": "\'MesloLGS NF\', monospace", "editor.fontSize": 13, }',
  };
  const deps = { ...base, readFile: fakeFiles(files), run: fakeRun({}) };

  assert.deepEqual(readTerminalFont('kitty', deps), {
    source: 'kitty',
    family: 'Cascadia Code',
    sizePx: 13.3,
  });
  assert.deepEqual(readTerminalFont('alacritty', deps), {
    source: 'alacritty',
    family: 'Hack',
    sizePx: 16,
  });
  assert.deepEqual(readTerminalFont('ghostty', deps), {
    source: 'ghostty',
    family: 'Maple Mono',
    sizePx: 20,
  });
  assert.deepEqual(readTerminalFont('foot', deps), {
    source: 'foot',
    family: 'Fira Code',
    sizePx: 12,
  });
  assert.deepEqual(readTerminalFont('konsole', deps), {
    source: 'konsole',
    family: 'Hack',
    sizePx: 14.7,
  });
  assert.deepEqual(readTerminalFont('vscode', deps), {
    source: 'vscode',
    family: 'MesloLGS NF',
    sizePx: 13,
  });
});

test('a terminal left on its defaults reports the default it really draws with', () => {
  const deps = {
    ...base,
    readFile: fakeFiles({}),
    run: fakeRun({ 'fc-match -f %{family[0]} monospace': 'DejaVu Sans Mono' }),
  };
  // Ghostty embeds JetBrains Mono; kitty and foot ask fontconfig for "monospace".
  assert.deepEqual(readTerminalFont('ghostty', deps), {
    source: 'ghostty',
    family: 'JetBrains Mono',
    sizePx: 16,
  });
  assert.deepEqual(readTerminalFont('kitty', deps), {
    source: 'kitty',
    family: 'DejaVu Sans Mono',
    sizePx: 14.7,
  });
  assert.deepEqual(readTerminalFont('foot', deps), {
    source: 'foot',
    family: 'DejaVu Sans Mono',
    sizePx: 10.7,
  });
});

/** Writes a file whose first bytes make it look like the given font format. */
function fontFile(directory, name, magic, size = 1000) {
  const file = path.join(directory, name);
  const body = Buffer.alloc(size, 7);
  Buffer.from(magic, 'latin1').copy(body, 0);
  fs.writeFileSync(file, body);
  return file;
}

test('font files: real TTF/OTF of the right family only, never the same file twice', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-font-files-'));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const regular = fontFile(directory, 'Mono-Regular.ttf', '\x00\x01\x00\x00');
  const bold = fontFile(directory, 'Mono-Bold.otf', 'OTTO');
  const other = fontFile(directory, 'Other-Italic.ttf', 'true');

  const answer = (file, family, index = 0) => `${file}\n${family}\n${index}\n`;
  const run = fakeRun({
    'fc-match -f %{file}\n%{family}\n%{index}\n My Mono:weight=regular:slant=roman': answer(
      regular,
      'My Mono,My Mono NF',
    ),
    'fc-match -f %{file}\n%{family}\n%{index}\n My Mono:weight=bold:slant=roman': answer(
      bold,
      'My Mono',
    ),
    // No italic: fontconfig falls back to the regular file.
    'fc-match -f %{file}\n%{family}\n%{index}\n My Mono:weight=regular:slant=italic': answer(
      regular,
      'My Mono',
    ),
    // No bold italic either: fontconfig picks some other family entirely.
    'fc-match -f %{file}\n%{family}\n%{index}\n My Mono:weight=bold:slant=italic': answer(
      other,
      'DejaVu Sans Mono',
    ),
  });

  const faces = resolveFontFaces('My Mono', { ...base, run });
  assert.deepEqual(
    faces.map(({ style, format, bytes }) => ({ style, format, bytes })),
    [
      { style: 'regular', format: 'truetype', bytes: 1000 },
      { style: 'bold', format: 'opentype', bytes: 1000 },
    ],
  );
  assert.match(faces[0].sha256, /^[0-9a-f]{64}$/);

  // A collection member, or a file that is not an sfnt, is not offered.
  const ttc = fakeRun({
    'fc-match -f %{file}\n%{family}\n%{index}\n CJK:weight=regular:slant=roman': answer(
      regular,
      'CJK',
      2,
    ),
  });
  assert.deepEqual(resolveFontFaces('CJK', { ...base, run: ttc }), []);
  const woff = fontFile(directory, 'Web.woff2', 'wOF2');
  const web = fakeRun({
    'fc-match -f %{file}\n%{family}\n%{index}\n Web:weight=regular:slant=roman': answer(
      woff,
      'Web',
    ),
  });
  assert.deepEqual(resolveFontFaces('Web', { ...base, run: web }), []);
  assert.deepEqual(resolveFontFaces('monospace', { ...base, run }), []);

  // What leaves the machine: hashes and sizes, no paths.
  const wire = publicTerminalFont({ family: 'My Mono', sizePx: 12, source: 'kitty', faces });
  assert.equal(JSON.stringify(wire).includes(directory), false);
  assert.equal(wire.faces.length, 2);
});

test('font files are served a slice at a time, and a changed file is refused', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-font-chunks-'));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const size = TERMINAL_FONT_CHUNK_BYTES * 2 + 5;
  const file = fontFile(directory, 'Big.ttf', 'true', size);
  const run = fakeRun({
    [`fc-match -f %{file}\n%{family}\n%{index}\n Big:weight=regular:slant=roman`]: `${file}\nBig\n0\n`,
  });
  const record = { family: 'Big', faces: resolveFontFaces('Big', { ...base, run }) };
  const { sha256 } = record.faces[0];

  const first = readFontChunk(record, sha256, 0);
  assert.equal(first.total, 3);
  assert.equal(first.data.length, TERMINAL_FONT_CHUNK_BYTES);
  assert.equal(first.data.subarray(0, 4).toString('latin1'), 'true');
  assert.equal(readFontChunk(record, sha256, 2).data.length, 5);
  assert.equal(readFontChunk(record, sha256, 3), null);
  assert.equal(readFontChunk(record, 'f'.repeat(64), 0), null);

  fs.appendFileSync(file, 'edited');
  assert.equal(readFontChunk(record, sha256, 0), null);
});

test('the font detected at the entry point is inherited and remembered', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-font-state-'));
  const previous = process.env.HERDR_REMOTE_STATE_DIR;
  process.env.HERDR_REMOTE_STATE_DIR = directory;
  t.onTestFinished(() => {
    if (previous === undefined) delete process.env.HERDR_REMOTE_STATE_DIR;
    else process.env.HERDR_REMOTE_STATE_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const env = {};
  const detected = { source: 'gnome-terminal', family: 'JetBrainsMono Nerd Font', sizePx: 12 };
  assert.deepEqual(captureTerminalFont({ env, detect: () => detected }), detected);
  assert.deepEqual(fontFromEnvironment(env), detected);

  // Already captured by a parent: no second detection.
  let asked = false;
  captureTerminalFont({
    env,
    detect: () => {
      asked = true;
      return null;
    },
  });
  assert.equal(asked, false);

  // A start with nothing inherited — a service manager's — uses what was
  // remembered, and re-reads that terminal's settings when it can.
  const remembered = loadHostTerminalFont({ env: {}, deps: { ...base, run: fakeRun({}) } });
  assert.equal(remembered.family, 'JetBrainsMono Nerd Font');
  assert.deepEqual(remembered.faces, []);

  assert.equal(fontFromEnvironment({ HERDR_TERM_FONT_JSON: '{"family":"a\\"; }"}' }), null);
  assert.equal(fontFromEnvironment({ HERDR_TERM_FONT_JSON: 'nope' }), null);
});

test('the connector serves slices and re-reads the font for a window that asks', (t) => {
  const { HostConnector } = require('../src/host-connector');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-font-connector-'));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = fontFile(directory, 'Mono.ttf', 'true', 10);
  // "Mono" alone is a generic name, which is never resolved to files.
  const run = fakeRun({
    [`fc-match -f %{file}\n%{family}\n%{index}\n Tiny Mono:weight=regular:slant=roman`]: `${file}\nTiny Mono\n0\n`,
  });
  const record = {
    family: 'Tiny Mono',
    sizePx: 12,
    source: 'kitty',
    faces: resolveFontFaces('Tiny Mono', { ...base, run }),
  };
  const refreshed = { family: 'Fira Code', sizePx: 14, source: 'kitty', faces: [] };

  const connector = new HostConnector({
    relayUrl: 'ws://127.0.0.1:1/ws/host',
    hostId: 'host-test',
    hostToken: 'host-token-123456789',
    lockPath: path.join(directory, 'connector.lock'),
    socketPath: path.join(directory, 'herdr.sock'),
    herdrCommand: process.execPath,
    terminalPalette: null,
    terminalFont: record,
    loadTerminalFont: () => refreshed,
    config: {
      herdr: { args: [], cwd: process.cwd(), socketPath: null },
      cleanup: { heartbeatIntervalMs: 10 },
    },
  });
  const sent = [];
  connector.ws = {
    readyState: WebSocket.OPEN,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
    close() {},
  };
  const deliver = (message) => connector.handleMessage(Buffer.from(JSON.stringify(message)), false);

  deliver({
    type: 'host_font_chunk_request',
    clientId: 'stream-1',
    sha256: record.faces[0].sha256,
    index: 0,
  });
  assert.equal(sent[0].type, 'host_font_chunk');
  assert.equal(sent[0].clientId, 'stream-1');
  assert.equal(Buffer.from(sent[0].dataBase64, 'base64').length, 10);

  deliver({
    type: 'host_font_chunk_request',
    clientId: 'stream-1',
    sha256: record.faces[0].sha256,
    index: 1,
  });
  assert.equal(sent[1].code, 'host_font_unavailable');

  deliver({ type: 'host_font_refresh', clientId: 'stream-1' });
  assert.deepEqual(sent[2], { type: 'terminal_font', terminalFont: { ...refreshed, subsets: [] } });
});

test('a connector that started with no font picks one up when a window opens', (t) => {
  const { HostConnector } = require('../src/host-connector');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-font-late-'));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  let remembered = null;
  const connector = new HostConnector({
    relayUrl: 'ws://127.0.0.1:1/ws/host',
    hostId: 'host-test',
    hostToken: 'host-token-123456789',
    lockPath: path.join(directory, 'connector.lock'),
    socketPath: path.join(directory, 'herdr.sock'),
    herdrCommand: process.execPath,
    terminalPalette: null,
    terminalFont: null,
    loadTerminalFont: () => remembered,
    checkUpdate: null,
    config: {
      herdr: { args: [], cwd: process.cwd(), socketPath: null },
      cleanup: { heartbeatIntervalMs: 10 },
    },
  });
  const sent = [];
  connector.ws = {
    readyState: WebSocket.OPEN,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
    close() {},
  };

  connector.pickUpTerminalFont();
  assert.equal(sent.length, 0);

  // `herdr-remote start` from a terminal wrote one down meanwhile.
  remembered = { family: 'JetBrains Mono', sizePx: 13.3, source: 'ghostty', faces: [] };
  connector.pickUpTerminalFont();
  assert.deepEqual(sent, [{ type: 'terminal_font', terminalFont: { ...remembered, subsets: [] } }]);
  connector.pickUpTerminalFont();
  assert.equal(sent.length, 1);
});

test('Terminal.app: the default profile’s archived NSFont', () => {
  const { parseBinaryPlist } = require('../src/binary-plist');
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'com.apple.Terminal.plist'));
  const prefs = `${HOME}/Library/Preferences/com.apple.Terminal.plist`;
  const run = fakeRun({
    'fc-list :postscriptname=JetBrainsMonoNF\\-Regular family':
      'JetBrainsMono Nerd Font,JetBrainsMono NF\n',
  });
  const deps = {
    ...base,
    platform: 'darwin',
    run,
    readBuffer: (file) => (file === prefs ? fixture : null),
  };

  assert.equal(
    identifyTerminal({ env: { TERM_PROGRAM: 'Apple_Terminal' }, ancestry: [] }),
    'apple-terminal',
  );
  assert.deepEqual(readTerminalFont('apple-terminal', deps), {
    source: 'apple-terminal',
    family: 'JetBrainsMono Nerd Font',
    sizePx: 17.3,
  });

  assert.equal(parseBinaryPlist(fixture)['Default Window Settings'], 'Pro');
  // No preferences file to read: no answer.
  assert.equal(readTerminalFont('apple-terminal', { ...deps, readBuffer: () => null }), null);
});

test('iTerm2: the default profile’s font, by its PostScript name', () => {
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'com.googlecode.iterm2.plist'));
  const prefs = `${HOME}/Library/Preferences/com.googlecode.iterm2.plist`;
  const run = fakeRun({
    'fc-list :postscriptname=JetBrainsMonoNF\\-Regular family': 'JetBrainsMono Nerd Font\n',
  });
  const deps = {
    ...base,
    platform: 'darwin',
    run,
    readBuffer: (file) => (file === prefs ? fixture : null),
  };
  assert.deepEqual(readTerminalFont('iterm2', deps), {
    source: 'iterm2',
    family: 'JetBrainsMono Nerd Font',
    sizePx: 18,
  });
});

test('Apple’s own faces are named without a font scan and never offered as files', (t) => {
  const deps = { ...base, platform: 'darwin', run: fakeRun({}), readBuffer: () => null };
  // No preferences file at all: Terminal's default, SF Mono 11.
  const fixtureless = readTerminalFont('apple-terminal', {
    ...deps,
    readBuffer: () => parseableEmptyPlist(),
  });
  assert.deepEqual(fixtureless, { source: 'apple-terminal', family: 'SF Mono', sizePx: 14.7 });

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-font-apple-'));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bundled = path.join(directory, 'Terminal.app', 'Contents', 'Resources', 'Fonts');
  fs.mkdirSync(bundled, { recursive: true });
  const file = fontFile(bundled, 'SF-Mono-Regular.otf', 'OTTO');
  const run = fakeRun({
    'fc-match -f %{file}\n%{family}\n%{index}\n SF Mono:weight=regular:slant=roman': `${file}\nSF Mono\n0\n`,
  });
  assert.deepEqual(resolveFontFaces('SF Mono', { ...base, run }), []);
});

/** A binary plist holding an empty dictionary. */
function parseableEmptyPlist() {
  // bplist00, one object (an empty dict), 1-byte offsets and refs.
  const body = Buffer.from([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30, 0xd0, 0x08]);
  const trailer = Buffer.alloc(32);
  trailer[6] = 1;
  trailer[7] = 1;
  trailer.writeBigUInt64BE(1n, 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(9n, 24);
  return Buffer.concat([body, trailer]);
}

test('xterm and urxvt: the emulator’s command line over the X resources', () => {
  const xrdb = fakeRun({
    'xrdb -query':
      'XTerm*faceName:\tDejaVu Sans Mono\nXTerm*faceSize:\t10\nURxvt.font:\txft:Iosevka Term:size=12,xft:Noto Color Emoji\n*faceName:\tIgnored\n',
  });
  const deps = { ...base, run: xrdb };
  assert.deepEqual(readTerminalFont('xterm', deps), {
    source: 'xterm',
    family: 'DejaVu Sans Mono',
    sizePx: 13.3,
  });
  assert.deepEqual(
    readTerminalFont('xterm', {
      ...deps,
      terminalArgs: ['xterm', '-fa', 'JetBrains Mono', '-fs', '11'],
    }),
    { source: 'xterm', family: 'JetBrains Mono', sizePx: 14.7 },
  );
  assert.deepEqual(
    readTerminalFont('xterm', { ...deps, terminalArgs: ['xterm', '-xrm', 'XTerm*faceName: Hack'] }),
    { source: 'xterm', family: 'Hack', sizePx: 13.3 },
  );
  assert.deepEqual(readTerminalFont('urxvt', deps), {
    source: 'urxvt',
    family: 'Iosevka Term',
    sizePx: 16,
  });

  // Bitmap core fonts cannot be drawn by a browser: no answer, not a guess.
  const bitmap = {
    ...base,
    run: fakeRun({
      'xrdb -query': 'URxvt.font:\t-misc-fixed-medium-r-normal--13-120-75-75-c-70-iso10646-1\n',
    }),
  };
  assert.equal(readTerminalFont('xterm', bitmap), null);
  assert.equal(readTerminalFont('urxvt', bitmap), null);
  assert.equal(identifyTerminal({ env: { XTERM_VERSION: 'XTerm(390)' }, ancestry: [] }), 'xterm');
  assert.equal(identifyTerminal({ env: { TERM: 'rxvt-unicode-256color' }, ancestry: [] }), 'urxvt');
});

test('large fonts are offered for cutting: the CJK fallback, or a family too big to send', (t) => {
  const { resolveSubsetSources } = require('../src/terminal-font');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-font-subsets-'));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cjk = fontFile(directory, 'NotoSansCJK-Regular.ttc', 'ttcf');
  const mono = fontFile(directory, 'Mono-Regular.ttf', 'true');
  const answer = (file, family, index = 0) => `${file}\n${family}\n${index}\n`;
  const query = (pattern) => `fc-match -f %{file}\n%{family}\n%{index}\n ${pattern}`;

  // A Latin family sent whole; Hanzi fall back to a collection member.
  const latin = fakeRun({
    [query('Tiny Mono:weight=regular:slant=roman')]: answer(mono, 'Tiny Mono'),
    [query('Tiny Mono:charset=4e00:weight=regular:slant=roman')]: answer(
      cjk,
      'Noto Sans Mono CJK SC,Noto Sans Mono CJK SC Regular',
      7,
    ),
  });
  const faces = [{ style: 'regular' }];
  const [source] = resolveSubsetSources('Tiny Mono', faces, { ...base, run: latin });
  assert.equal(source.scope, 'cjk');
  assert.equal(source.family, 'Noto Sans Mono CJK SC');
  assert.equal(source.index, 7);
  assert.match(source.sha256, /^[0-9a-f]{64}$/);

  // A CJK programming font too large to send whole: cut from it for everything.
  const sarasa = fakeRun({
    [query('Sarasa Mono SC:weight=regular:slant=roman')]: answer(cjk, 'Sarasa Mono SC', 3),
    [query('Sarasa Mono SC:charset=4e00:weight=regular:slant=roman')]: answer(
      cjk,
      'Sarasa Mono SC',
      3,
    ),
  });
  assert.deepEqual(
    resolveSubsetSources('Sarasa Mono SC', [], { ...base, run: sarasa }).map((item) => item.scope),
    ['all'],
  );
  assert.deepEqual(resolveSubsetSources('monospace', [], { ...base, run: sarasa }), []);
});

test('the connector answers a cut inline when small, and in slices when large', (t) => {
  const { HostConnector } = require('../src/host-connector');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-font-cut-'));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = fontFile(directory, 'cjk.otf', 'OTTO');
  const stat = fs.statSync(file);
  const source = {
    family: 'Noto Sans CJK SC',
    style: 'regular',
    scope: 'cjk',
    sha256: 'c'.repeat(64),
    path: file,
    index: 0,
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
  };
  const asked = [];
  const connector = new HostConnector({
    relayUrl: 'ws://127.0.0.1:1/ws/host',
    hostId: 'host-test',
    hostToken: 'host-token-123456789',
    lockPath: path.join(directory, 'connector.lock'),
    socketPath: path.join(directory, 'herdr.sock'),
    herdrCommand: process.execPath,
    terminalPalette: null,
    terminalFont: { family: 'Tiny Mono', faces: [], subsets: [source] },
    fontSubsetter: {
      subset(from, codepoints) {
        asked.push(codepoints);
        return Buffer.alloc(codepoints.length > 2 ? TERMINAL_FONT_CHUNK_BYTES + 5 : 7, 1);
      },
    },
    config: {
      herdr: { args: [], cwd: process.cwd(), socketPath: null },
      cleanup: { heartbeatIntervalMs: 10 },
    },
  });
  const sent = [];
  connector.ws = {
    readyState: WebSocket.OPEN,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
    close() {},
  };
  const deliver = (message) => connector.handleMessage(Buffer.from(JSON.stringify(message)), false);

  deliver({
    type: 'host_font_subset_request',
    clientId: 's1',
    requestId: 'r1',
    sha256: source.sha256,
    text: '你好你',
  });
  assert.deepEqual(asked[0], [0x4f60, 0x597d]);
  assert.equal(sent[0].type, 'host_font_subset_ready');
  assert.equal(Buffer.from(sent[0].dataBase64, 'base64').length, 7);

  deliver({
    type: 'host_font_subset_request',
    clientId: 's1',
    requestId: 'r2',
    sha256: source.sha256,
    text: '一二三四',
  });
  assert.equal(sent[1].dataBase64, undefined);
  assert.equal(sent[1].bytes, TERMINAL_FONT_CHUNK_BYTES + 5);
  deliver({ type: 'host_font_chunk_request', clientId: 's1', sha256: sent[1].subsetSha, index: 1 });
  assert.equal(Buffer.from(sent[2].dataBase64, 'base64').length, 5);
  assert.equal(sent[2].total, 2);

  // The font file changed since it was announced: refused, not cut.
  fs.appendFileSync(file, 'x');
  deliver({
    type: 'host_font_subset_request',
    clientId: 's1',
    requestId: 'r3',
    sha256: source.sha256,
    text: '你',
  });
  assert.equal(sent[3].code, 'host_font_unavailable');
});

test('HarfBuzz cuts a real font down to the requested characters', (t) => {
  const { FontSubsetter } = require('../src/font-subset');
  const located = require('node:child_process').spawnSync(
    'fc-match',
    ['-f', '%{file}', 'DejaVu Sans Mono'],
    { encoding: 'utf8' },
  );
  const file = located.status === 0 ? located.stdout.trim() : '';
  if (!/\.(ttf|otf)$/i.test(file)) {
    t.skip('no DejaVu Sans Mono TTF on this machine');
    return;
  }
  const subsetter = new FontSubsetter({ idleMs: 10 });
  const cut = subsetter.subset(
    { path: file, index: 0 },
    [...'Herdr'].map((char) => char.codePointAt(0)),
  );
  subsetter.release();
  assert.ok(
    cut.length > 100 && cut.length < fs.statSync(file).size / 10,
    `cut is ${cut.length} bytes`,
  );
  assert.equal(cut.subarray(0, 4).toString('latin1'), '\x00\x01\x00\x00');
});
