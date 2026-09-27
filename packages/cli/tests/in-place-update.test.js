import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { installInPlace, replaceTree } from '../src/updater/in-place.js';
import { tempDir } from './helpers.js';

function writeTree(root, files) {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
}

function readTree(root) {
  const files = {};
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    files[path.relative(root, file).split(path.sep).join('/')] = fs.readFileSync(file, 'utf8');
  }
  return files;
}

// Windows refuses to rename a directory some process works in, so the package
// directory and every directory in it stay where they are.
test('a release replaces the package file by file, leaving its directories in place', (t) => {
  const root = tempDir(t);
  const source = path.join(root, 'new');
  const target = path.join(root, 'herdr-remote');
  writeTree(source, { 'package.json': 'new', 'dist/cli.js': 'new cli', 'dist/added.js': 'added' });
  writeTree(target, {
    'package.json': 'old',
    'dist/cli.js': 'old cli',
    'dist/removed.js': 'removed',
    'gone/file.js': 'gone',
  });
  const directories = [target, path.join(target, 'dist')].map((dir) => fs.statSync(dir).ino);

  replaceTree(source, target);

  assert.deepEqual(readTree(target), readTree(source));
  assert.equal(fs.existsSync(path.join(target, 'gone')), false);
  assert.deepEqual(
    [target, path.join(target, 'dist')].map((dir) => fs.statSync(dir).ino),
    directories,
  );
});

test('a file a running program holds is renamed aside and replaced', (t) => {
  const root = tempDir(t);
  const source = path.join(root, 'new');
  const target = path.join(root, 'herdr-remote');
  writeTree(source, { 'build/pty.node': 'new module' });
  writeTree(target, { 'build/pty.node': 'old module' });
  const held = path.join(target, 'build', 'pty.node');
  const copyFile = (from, to) => {
    if (to === held && fs.existsSync(to))
      throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
    fs.copyFileSync(from, to);
  };

  replaceTree(source, target, copyFile);

  assert.deepEqual(readTree(target), { 'build/pty.node': 'new module' });
});

test('npm installs into a staging prefix, which is copied over the package and removed', async (t) => {
  const root = tempDir(t);
  const target = path.join(root, 'global', 'node_modules', 'herdr-remote');
  const stage = path.join(root, 'stage');
  writeTree(target, { 'package.json': '{"version":"0.2.28"}', 'dist/old.js': 'old' });
  const calls = [];

  const result = await installInPlace(
    ['install', '-g', 'herdr-remote@0.2.30', '--prefer-online'],
    async (args) => {
      calls.push(args);
      writeTree(path.join(stage, 'node_modules', 'herdr-remote'), {
        'package.json': '{"version":"0.2.30"}',
        'dist/new.js': 'new',
      });
      return { ok: true, output: 'added 1 package' };
    },
    { target, stage, platform: 'win32' },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ['install', '-g', 'herdr-remote@0.2.30', '--prefer-online', '--prefix', stage],
  ]);
  assert.deepEqual(readTree(target), {
    'package.json': '{"version":"0.2.30"}',
    'dist/new.js': 'new',
  });
  assert.equal(fs.existsSync(stage), false);
});

test('nothing is touched when the staged install did not produce the package', async (t) => {
  const root = tempDir(t);
  const target = path.join(root, 'herdr-remote');
  writeTree(target, { 'package.json': 'old' });

  const result = await installInPlace(
    ['install', '-g', 'herdr-remote@0.2.30'],
    async () => ({ ok: true, output: '' }),
    { target, stage: path.join(root, 'stage'), platform: 'win32' },
  );

  assert.equal(result.ok, false);
  assert.deepEqual(readTree(target), { 'package.json': 'old' });
});
