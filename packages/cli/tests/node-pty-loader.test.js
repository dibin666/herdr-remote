import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { copyNodePty, loadNodePty } from '../src/node-pty-loader.js';
import { tempDir } from './helpers.js';

/** A stand-in node-pty whose entry point reports where it was loaded from. */
function fakeNodePty(t) {
  const root = path.join(tempDir(t), 'node-pty');
  const files = {
    'package.json': JSON.stringify({ name: 'node-pty', main: './lib/index.js' }),
    'lib/index.js': 'exports.loadedFrom = __dirname;',
    'lib/worker/conoutSocketWorker.js': '',
    'lib/index.test.js': "require('ps-list');",
    'prebuilds/win32-x64/conpty.node': 'conpty',
    'prebuilds/win32-x64/conpty.pdb': 'symbols',
    'prebuilds/win32-x64/conpty/OpenConsole.exe': 'console host',
    'prebuilds/darwin-arm64/pty.node': 'mac',
  };
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

test('Windows loads node-pty from a copy outside the package, which npm renames to update it', (t) => {
  const source = fakeNodePty(t);
  const directory = tempDir(t);

  const loaded = loadNodePty({ platform: 'win32', arch: 'x64', source, directory });

  const copy = path.dirname(loaded.loadedFrom);
  assert.equal(path.dirname(copy), directory);
  assert.ok(fs.existsSync(path.join(copy, 'lib', 'worker', 'conoutSocketWorker.js')));
  // ConPTY starts OpenConsole.exe from beside conpty.node.
  assert.ok(fs.existsSync(path.join(copy, 'prebuilds', 'win32-x64', 'conpty', 'OpenConsole.exe')));
  assert.ok(!fs.existsSync(path.join(copy, 'prebuilds', 'win32-x64', 'conpty.pdb')));
  assert.ok(!fs.existsSync(path.join(copy, 'prebuilds', 'darwin-arm64')));
  assert.ok(!fs.existsSync(path.join(copy, 'lib', 'index.test.js')));
});

test('each build of node-pty is copied once and its copy kept', (t) => {
  const source = fakeNodePty(t);
  const directory = tempDir(t);

  const first = copyNodePty(source, directory, 'win32', 'x64');
  assert.equal(copyNodePty(source, directory, 'win32', 'x64'), first);

  fs.writeFileSync(path.join(source, 'prebuilds', 'win32-x64', 'conpty.node'), 'rebuilt');
  const second = copyNodePty(source, directory, 'win32', 'x64');
  assert.notEqual(second, first);
  // A process of the previous release may still have the old copy loaded.
  assert.deepEqual(
    fs.readdirSync(directory).sort(),
    [path.basename(first), path.basename(second)].sort(),
  );
});

test('other platforms load node-pty where npm installed it', (t) => {
  const source = fakeNodePty(t);
  const directory = path.join(tempDir(t), 'copies');

  const loaded = loadNodePty({ platform: 'linux', arch: 'x64', source, directory });

  assert.equal(loaded.loadedFrom, path.join(source, 'lib'));
  assert.ok(!fs.existsSync(directory));
});

test('Windows falls back to the package when no copy can be made', (t) => {
  const source = fakeNodePty(t);
  const blocked = path.join(tempDir(t), 'not-a-directory');
  fs.writeFileSync(blocked, '');
  const warnings = [];

  const loaded = loadNodePty({
    platform: 'win32',
    arch: 'x64',
    source,
    directory: blocked,
    warn: (message) => warnings.push(message),
  });

  assert.equal(loaded.loadedFrom, path.join(source, 'lib'));
  assert.equal(warnings.length, 1);
});
