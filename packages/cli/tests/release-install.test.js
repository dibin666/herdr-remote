import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { test } from 'vitest';
import { installRelease } from '../src/updater/release-install.js';
import { extractPackage } from '../src/updater/tarball.js';
import { tempDir } from './helpers.js';

const URL = 'https://github.com/dibin666/herdr-remote/releases/download/x/herdr-remote.tgz';

function header(name, size, type, mode = 0o644) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100);
  block.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  block.write(type, 156);
  block.write('ustar\0', 257);
  return block;
}

function padded(content) {
  return Buffer.concat([content, Buffer.alloc((512 - (content.length % 512)) % 512)]);
}

/** A gzipped tarball the way npm writes one: ustar, long paths in pax headers. */
function tarball(files, { modes = {}, raw = [] } = {}) {
  const blocks = [];
  for (const [name, text] of Object.entries(files)) {
    const content = Buffer.from(text);
    const full = `package/${name}`;
    if (full.length > 100) {
      const record = ` path=${full}\n`;
      // The length prefix counts its own digits.
      let length = record.length + 1;
      while (String(length).length + record.length !== length) length += 1;
      const pax = Buffer.from(`${length}${record}`);
      blocks.push(header('PaxHeader', pax.length, 'x'), padded(pax));
    }
    blocks.push(header(full.slice(0, 100), content.length, '0', modes[name]), padded(content));
  }
  for (const entry of raw) blocks.push(entry);
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

function writeTree(root, files) {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
}

const manifest = (version, dependencies, extra = {}) =>
  JSON.stringify({
    name: 'herdr-remote',
    version,
    bin: { 'herdr-remote': './bin/herdr-remote.js' },
    dependencies,
    ...extra,
  });

/** An installed herdr-remote from before bundling: npm installed every dependency. */
function installed(t) {
  const root = tempDir(t);
  const target = path.join(root, 'herdr-remote');
  writeTree(target, {
    'package.json': manifest('1.0.0', { 'node-pty': '^1.1.0', ink: '^7.1.1' }),
    'dist/old.js': 'old',
    'node_modules/node-pty/package.json': JSON.stringify({
      name: 'node-pty',
      dependencies: { 'node-addon-api': '^7.1.0' },
    }),
    'node_modules/node-pty/build/Release/pty.node': 'native',
    'node_modules/node-addon-api/package.json': '{"name":"node-addon-api"}',
    'node_modules/ink/package.json': '{"name":"ink"}',
  });
  return { root, target };
}

// Longer than ustar's 100-character name field.
const FONT =
  'node_modules/herdr-remote-relay/web/dist/fonts/maple-mono/a-rather-long-font-file-name-that-needs-a-pax-header.woff2';

const RELEASE = {
  'package.json': manifest(
    '1.1.0',
    { 'herdr-remote-relay': '1.1.0', 'node-pty': '^1.1.0' },
    { bundleDependencies: ['herdr-remote-relay'] },
  ),
  'bin/herdr-remote.js': '#!/usr/bin/env node\n',
  'dist/new.js': 'new',
  'node_modules/herdr-remote-relay/package.json': '{"name":"herdr-remote-relay"}',
  [FONT]: 'font',
};

const serve = (archive) => async () => ({
  ok: true,
  arrayBuffer: async () =>
    archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.length),
});

test('a release is unpacked beside the package and swapped in, keeping its native dependency', async (t) => {
  const { root, target } = installed(t);

  const result = await installRelease({
    url: URL,
    version: '1.1.0',
    target,
    fetchImpl: serve(tarball(RELEASE, { modes: { 'bin/herdr-remote.js': 0o755 } })),
  });

  assert.equal(result.ok, true, result.output);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'))).version, '1.1.0');
  assert.equal(fs.readFileSync(path.join(target, 'dist/new.js'), 'utf8'), 'new');
  assert.equal(fs.existsSync(path.join(target, 'dist/old.js')), false);
  // node-pty, and what it depends on, come along; what the bundle replaced does not.
  assert.equal(
    fs.readFileSync(path.join(target, 'node_modules/node-pty/build/Release/pty.node'), 'utf8'),
    'native',
  );
  assert.equal(fs.existsSync(path.join(target, 'node_modules/node-addon-api')), true);
  assert.equal(fs.existsSync(path.join(target, 'node_modules/ink')), false);
  assert.equal(fs.readFileSync(path.join(target, FONT), 'utf8'), 'font');
  if (process.platform !== 'win32')
    assert.equal(fs.statSync(path.join(target, 'bin/herdr-remote.js')).mode & 0o111, 0o111);
  assert.deepEqual(fs.readdirSync(root), ['herdr-remote'], 'no stage or previous copy is left');
});

test('a release that asks for a different native dependency is left to npm', async (t) => {
  const { root, target } = installed(t);
  const release = {
    ...RELEASE,
    'package.json': manifest(
      '1.1.0',
      { 'herdr-remote-relay': '1.1.0', 'node-pty': '^1.2.0' },
      { bundleDependencies: ['herdr-remote-relay'] },
    ),
  };

  const result = await installRelease({
    url: URL,
    version: '1.1.0',
    target,
    fetchImpl: serve(tarball(release)),
  });

  assert.equal(result.ok, false);
  assert.equal(result.needsNpm, true);
  assert.equal(fs.readFileSync(path.join(target, 'dist/old.js'), 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(root), ['herdr-remote']);
});

test('a tarball that is not the release asked for changes nothing', async (t) => {
  const { target } = installed(t);

  const wrongVersion = await installRelease({
    url: URL,
    version: '1.2.0',
    target,
    fetchImpl: serve(tarball(RELEASE)),
  });
  const unreachable = await installRelease({
    url: URL,
    version: '1.1.0',
    target,
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });

  assert.equal(wrongVersion.ok, false);
  assert.equal(wrongVersion.needsNpm, undefined);
  assert.equal(unreachable.ok, false);
  assert.match(unreachable.output, /HTTP 404/);
  assert.equal(fs.readFileSync(path.join(target, 'dist/old.js'), 'utf8'), 'old');
});

test('an archive path that leaves the package is refused', (t) => {
  const into = path.join(tempDir(t), 'stage');
  const evil = Buffer.from('evil');
  const archive = tarball(
    {},
    { raw: [header('package/../../escaped', evil.length, '0'), padded(evil)] },
  );

  assert.throws(() => extractPackage(archive, into), /escapes/);
  assert.equal(fs.existsSync(path.join(into, '..', 'escaped')), false);
});

test('links in an archive are refused rather than followed', (t) => {
  const into = path.join(tempDir(t), 'stage');
  const archive = tarball({}, { raw: [header('package/link', 0, '2')] });

  assert.throws(() => extractPackage(archive, into), /unsupported entry type/);
});
