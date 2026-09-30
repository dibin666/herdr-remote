import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readHerdrPrefixKeys } from '../src/connector/herdr-prefix-keys.js';
import { herdrConfigPath } from '../src/socket-discovery.js';
import { tempDir } from './helpers.js';

/** The keys read from a config file holding `toml`, found through HERDR_CONFIG_PATH. */
function prefixKeysOf(t, toml) {
  const file = path.join(tempDir(t, 'herdr-remote-prefix-'), 'config.toml');
  fs.writeFileSync(file, toml);
  return readHerdrPrefixKeys({ HERDR_CONFIG_PATH: file });
}

test('a single prefix string is read as a one-key list', (t) => {
  assert.deepEqual(prefixKeysOf(t, '[keys]\nprefix = "ctrl+space"\n'), ['ctrl+space']);
  assert.deepEqual(prefixKeysOf(t, "[keys]\nprefix = 'alt+a' # my own\n"), ['alt+a']);
});

test('a prefix array keeps every key, in order, however it is laid out', (t) => {
  assert.deepEqual(prefixKeysOf(t, '[keys]\nprefix = ["ctrl+space", "ctrl+s"]\n'), [
    'ctrl+space',
    'ctrl+s',
  ]);
  assert.deepEqual(
    prefixKeysOf(
      t,
      [
        '[keys]',
        'prefix = [',
        '  "ctrl+space", # "ctrl+b" was the default ]',
        "  'ctrl+s',",
        ']',
        'new_workspace = "prefix+n"',
      ].join('\n'),
    ),
    ['ctrl+space', 'ctrl+s'],
  );
});

test('a dotted keys.prefix at the top of the file counts too', (t) => {
  assert.deepEqual(prefixKeysOf(t, 'onboarding = false\nkeys.prefix = ["ctrl+a"]\n'), ['ctrl+a']);
});

test('Herdr defaults to ctrl+b when the file, the key or the table is missing', (t) => {
  const missing = path.join(tempDir(t, 'herdr-remote-prefix-'), 'absent.toml');
  assert.deepEqual(readHerdrPrefixKeys({ HERDR_CONFIG_PATH: missing }), ['ctrl+b']);
  assert.deepEqual(prefixKeysOf(t, ''), ['ctrl+b']);
  assert.deepEqual(prefixKeysOf(t, '[keys]\nnew_tab = "prefix+c"\n'), ['ctrl+b']);
  // Another table's `prefix` is not Herdr's prefix key.
  assert.deepEqual(prefixKeysOf(t, '[ui]\nprefix = "ctrl+a"\n'), ['ctrl+b']);
  assert.deepEqual(prefixKeysOf(t, '# prefix = "ctrl+a"\n[[keys.custom]]\nprefix = "ctrl+a"\n'), [
    'ctrl+b',
  ]);
});

test('unusable prefix values fall back to ctrl+b, and usable entries survive the rest', (t) => {
  for (const toml of [
    '[keys]\nprefix = 5\n',
    '[keys]\nprefix = true\n',
    '[keys]\nprefix = ""\n',
    '[keys]\nprefix = []\n',
    '[keys]\nprefix = [1, 2]\n',
    '[keys]\nprefix = ["ctrl+\u00e9", "   "]\n',
    '[keys]\nprefix = ["ctrl+',
  ]) {
    assert.deepEqual(prefixKeysOf(t, toml), ['ctrl+b'], toml);
  }
  assert.deepEqual(prefixKeysOf(t, '[keys]\nprefix = ["ctrl+\u00e9", "ctrl+s", 7]\n'), ['ctrl+s']);
});

test('prefix keys come out lowercase, trimmed, without duplicates and in bounded numbers', (t) => {
  assert.deepEqual(
    prefixKeysOf(t, '[keys]\nprefix = [" Ctrl+Space ", "CTRL + S", "ctrl+s", "Ctrl+Shift+X"]\n'),
    ['ctrl+space', 'ctrl+s', 'ctrl+shift+x'],
  );

  const many = Array.from({ length: 30 }, (_, index) => `"ctrl+f${index + 1}"`);
  const keys = prefixKeysOf(t, `[keys]\nprefix = [${many.join(', ')}]\n`);
  assert.equal(keys.length, 8);
  assert.deepEqual(keys.slice(0, 2), ['ctrl+f1', 'ctrl+f2']);

  assert.deepEqual(prefixKeysOf(t, `[keys]\nprefix = ["${'ctrl+'.repeat(20)}a", "ctrl+a"]\n`), [
    'ctrl+a',
  ]);
});

test('the config is the one Herdr reads: HERDR_CONFIG_PATH, else the config home', (t) => {
  const home = tempDir(t, 'herdr-remote-prefix-home-');
  const write = (...parts) => {
    const file = path.join(home, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return file;
  };
  const xdgFile = write('xdg', 'herdr', 'config.toml');
  fs.writeFileSync(xdgFile, '[keys]\nprefix = "ctrl+x"\n');
  const explicit = write('elsewhere', 'custom.toml');
  fs.writeFileSync(explicit, '[keys]\nprefix = "ctrl+e"\n');
  const appData = write('roaming', 'herdr', 'config.toml');
  fs.writeFileSync(appData, '[keys]\nprefix = "ctrl+w"\n');

  const xdg = path.join(home, 'xdg');
  assert.deepEqual(readHerdrPrefixKeys({ XDG_CONFIG_HOME: xdg }, 'linux'), ['ctrl+x']);
  assert.deepEqual(readHerdrPrefixKeys({ XDG_CONFIG_HOME: xdg }, 'darwin'), ['ctrl+x']);
  assert.deepEqual(
    readHerdrPrefixKeys({ XDG_CONFIG_HOME: xdg, HERDR_CONFIG_PATH: explicit }, 'linux'),
    ['ctrl+e'],
  );
  assert.deepEqual(readHerdrPrefixKeys({ APPDATA: path.join(home, 'roaming') }, 'win32'), [
    'ctrl+w',
  ]);
  assert.equal(herdrConfigPath({ XDG_CONFIG_HOME: xdg }, 'linux'), xdgFile);
  // An unreadable HERDR_CONFIG_PATH is not rescued by the config home: Herdr would not read it either.
  assert.deepEqual(
    readHerdrPrefixKeys(
      { XDG_CONFIG_HOME: xdg, HERDR_CONFIG_PATH: path.join(home, 'nothing.toml') },
      'linux',
    ),
    ['ctrl+b'],
  );
});
