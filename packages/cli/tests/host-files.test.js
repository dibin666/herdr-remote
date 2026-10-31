import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { HostFiles } from '../src/connector/host-files.js';
import { FS_DOWNLOAD_CHUNK_BYTES } from 'herdr-remote-relay/protocol';
import { tempDir } from './helpers.js';

function makeFiles(directory, overrides = {}) {
  const sent = [];
  const files = new HostFiles(
    {
      socketPath: path.join(directory, 'herdr.sock'),
      fallbackCwd: directory,
      downloadsDir: path.join(directory, 'downloads'),
      requestHerdr: overrides.requestHerdr || (() => Promise.resolve({ pane: null })),
      ...overrides,
    },
    (payload) => sent.push(payload),
  );
  return { files, sent };
}

/** The entries of a parsed zip archive: name → uncompressed bytes. */
function unzip(archive) {
  const entries = new Map();
  let offset = 0;
  for (;;) {
    const signature = archive.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;
    const method = archive.readUInt16LE(offset + 8);
    const compressed = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const name = archive.toString('utf8', offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength + extraLength;
    const payload = archive.subarray(start, start + compressed);
    const data = method === 8 ? zlib.inflateRawSync(payload) : method === 0 ? payload : null;
    assert.ok(data !== null, `unknown zip method ${method}`);
    entries.set(name, data);
    offset = start + compressed;
  }
  assert.equal(archive.readUInt32LE(offset), 0x02014b50, 'central directory follows entries');
  return entries;
}

test('list answers the pane directory entries with file and dir kinds', async (t) => {
  const directory = tempDir(t, 'host-files-list-');
  const cwd = path.join(directory, 'workdir');
  fs.mkdirSync(path.join(cwd, 'subdir'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(cwd, 'b.bin'), Buffer.alloc(10));
  fs.symlinkSync('a.txt', path.join(cwd, 'link'));

  const { files, sent } = makeFiles(directory, {
    requestHerdr: () => Promise.resolve({ pane: { foreground_cwd: cwd, cwd } }),
  });
  await files.list('stream-1', 'req-1');

  assert.equal(sent.length, 1);
  const message = sent[0];
  assert.equal(message.type, 'fs_list_response');
  assert.equal(message.clientId, 'stream-1');
  assert.equal(message.requestId, 'req-1');
  assert.equal(message.cwd, cwd);
  const byName = Object.fromEntries(message.entries.map((entry) => [entry.name, entry]));
  assert.deepEqual(
    Object.keys(byName).sort(),
    ['a.txt', 'b.bin', 'subdir'],
    'symlinks are not listed',
  );
  assert.equal(byName['a.txt'].kind, 'file');
  assert.equal(byName['a.txt'].size, 5);
  assert.equal(byName.subdir.kind, 'dir');
});

test('list falls back to the session cwd when Herdr cannot answer', async (t) => {
  const directory = tempDir(t, 'host-files-fallback-');
  const { files, sent } = makeFiles(directory, {
    requestHerdr: () => Promise.reject(new Error('socket refused')),
  });
  await files.list('stream-1', 'req-1');
  assert.equal(sent[0].type, 'fs_list_response');
  assert.equal(sent[0].cwd, directory);
});

test('a missing directory answers fs_list_failed with the request id', async (t) => {
  const directory = tempDir(t, 'host-files-error-');
  const { files, sent } = makeFiles(directory, {
    fallbackCwd: path.join(directory, 'gone'),
  });
  await files.list('stream-1', 'req-9');
  assert.equal(sent[0].type, 'error');
  assert.equal(sent[0].code, 'fs_list_failed');
  assert.equal(sent[0].requestId, 'req-9');
});

test('one file downloads as itself, a slice at a time', async (t) => {
  const directory = tempDir(t, 'host-files-single-');
  const payload = Buffer.alloc(FS_DOWNLOAD_CHUNK_BYTES + 123, 0x61);
  fs.writeFileSync(path.join(directory, 'big.bin'), payload);

  const { files, sent } = makeFiles(directory);
  await files.list('stream-1', 'list-1');
  await files.download('stream-1', 'dl-1', ['big.bin']);

  const ready = sent.find((m) => m.type === 'fs_download_ready');
  assert.equal(ready.requestId, 'dl-1');
  assert.equal(ready.name, 'big.bin');
  assert.equal(ready.size, payload.length);
  assert.equal(ready.totalChunks, 2);

  files.sendChunk('stream-1', 'dl-1', 0);
  files.sendChunk('stream-1', 'dl-1', 1);
  const chunks = sent.filter((m) => m.type === 'fs_download_chunk');
  assert.equal(chunks.length, 2);
  const received = Buffer.concat(chunks.map((m) => Buffer.from(m.dataBase64, 'base64')));
  assert.deepEqual(received, payload);
  // The transfer is done: its fd and registration are gone.
  assert.equal(files.transfers.size, 0);
});

test('several names arrive as a zip with every file inside', async (t) => {
  const directory = tempDir(t, 'host-files-zip-');
  fs.mkdirSync(path.join(directory, 'sub'));
  fs.writeFileSync(path.join(directory, 'one.txt'), 'first');
  fs.writeFileSync(path.join(directory, 'two.txt'), 'second');
  fs.writeFileSync(path.join(directory, 'sub', 'three.txt'), 'third');

  const { files, sent } = makeFiles(directory);
  await files.list('stream-1', 'list-1');
  await files.download('stream-1', 'dl-1', ['one.txt', 'two.txt', 'sub']);

  const ready = sent.find((m) => m.type === 'fs_download_ready');
  assert.equal(ready.requestId, 'dl-1');
  assert.ok(ready.name.endsWith('.zip'), `zip name, got ${ready.name}`);

  const parts = [];
  for (let index = 0; index < ready.totalChunks; index++) {
    files.sendChunk('stream-1', 'dl-1', index);
  }
  for (const message of sent.filter((m) => m.type === 'fs_download_chunk')) {
    parts.push(Buffer.from(message.dataBase64, 'base64'));
  }
  const entries = unzip(Buffer.concat(parts));
  assert.equal(entries.get('one.txt').toString(), 'first');
  assert.equal(entries.get('two.txt').toString(), 'second');
  assert.equal(entries.get('sub/three.txt').toString(), 'third');
  // The staged zip was cleaned up once the last slice went out.
  assert.equal(fs.readdirSync(path.join(directory, 'downloads')).length, 0);
});

test('a name outside the listing is refused, paths included', async (t) => {
  const directory = tempDir(t, 'host-files-traversal-');
  fs.writeFileSync(path.join(directory, 'ok.txt'), 'ok');
  const { files, sent } = makeFiles(directory);
  await files.list('stream-1', 'list-1');

  for (const name of ['../secret', 'ok.txt/../../secret', 'not-listed.txt']) {
    const before = sent.length;
    await files.download('stream-1', `dl-${name}`, [name]);
    const error = sent.slice(before).find((m) => m.type === 'error');
    assert.ok(error, `rejected ${name}`);
    assert.equal(error.code === 'fs_not_found' || error.code === 'fs_download_failed', true);
  }
  assert.equal(sent.filter((m) => m.type === 'fs_download_ready').length, 0);
});

test('downloading before any listing fails instead of reading a path', async (t) => {
  const directory = tempDir(t, 'host-files-nolist-');
  const { files, sent } = makeFiles(directory);
  await files.download('stream-1', 'dl-1', ['anything']);
  assert.equal(sent[0].type, 'error');
  assert.equal(sent[0].code, 'fs_download_failed');
  assert.equal(sent[0].requestId, 'dl-1');
});

test('an empty file still transfers, as one empty slice', async (t) => {
  const directory = tempDir(t, 'host-files-empty-');
  fs.writeFileSync(path.join(directory, 'empty.txt'), '');
  const { files, sent } = makeFiles(directory);
  await files.list('stream-1', 'list-1');
  await files.download('stream-1', 'dl-1', ['empty.txt']);
  const ready = sent.find((m) => m.type === 'fs_download_ready');
  assert.equal(ready.size, 0);
  assert.equal(ready.totalChunks, 1);
  files.sendChunk('stream-1', 'dl-1', 0);
  const chunk = sent.find((m) => m.type === 'fs_download_chunk');
  assert.equal(chunk.dataBase64, '');
});

test('dir steps into a listed subdirectory, back up, and re-reads', async (t) => {
  const directory = tempDir(t, 'host-files-nav-');
  const cwd = path.join(directory, 'workdir');
  fs.mkdirSync(path.join(cwd, 'sub', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'sub', 'inside.txt'), 'in');
  const { files, sent } = makeFiles(directory, {
    requestHerdr: () => Promise.resolve({ pane: { foreground_cwd: cwd } }),
  });

  await files.list('stream-1', 'list-1');
  await files.list('stream-1', 'list-2', 'sub');
  const into = sent.find((m) => m.requestId === 'list-2');
  assert.equal(into.cwd, path.join(cwd, 'sub'));
  assert.deepEqual(into.entries.map((e) => e.name).sort(), ['deep', 'inside.txt']);

  await files.list('stream-1', 'list-3', '..');
  const up = sent.find((m) => m.requestId === 'list-3');
  assert.equal(up.cwd, cwd);

  await files.list('stream-1', 'list-4', '.');
  const again = sent.find((m) => m.requestId === 'list-4');
  assert.equal(again.cwd, cwd);
});

test('dir names outside the last listing are refused', async (t) => {
  const directory = tempDir(t, 'host-files-navrefuse-');
  fs.mkdirSync(path.join(directory, 'real'));
  fs.writeFileSync(path.join(directory, 'a.txt'), 'a');
  const { files, sent } = makeFiles(directory);
  await files.list('stream-1', 'list-1');

  for (const dir of ['a.txt', 'ghost', '../outside', '..\\up', '/abs']) {
    const before = sent.length;
    await files.list('stream-1', `nav-${dir}`, dir);
    const error = sent.slice(before).find((m) => m.type === 'error');
    assert.ok(error, `rejected dir ${dir}`);
    assert.equal(error.code, 'fs_not_found');
  }
  // No listing yet at all: navigation has nothing to stand on.
  const { files: fresh, sent: sent2 } = makeFiles(directory);
  await fresh.list('stream-9', 'nav-fresh', '..');
  assert.equal(sent2[0].type, 'error');
  assert.equal(sent2[0].code, 'fs_list_failed');
});

test('preview returns a listed file text, cut at the cap', async (t) => {
  const directory = tempDir(t, 'host-files-preview-');
  const text = 'hello world '.repeat(10);
  fs.writeFileSync(path.join(directory, 'a.txt'), text);
  const { files, sent } = makeFiles(directory);
  await files.list('stream-1', 'list-1');
  files.preview('stream-1', 'pv-1', 'a.txt');
  const message = sent.find((m) => m.requestId === 'pv-1');
  assert.equal(message.type, 'fs_preview_response');
  assert.equal(message.text, text);
  assert.equal(message.truncated, false);
  assert.equal(message.name, 'a.txt');
});

test('preview refuses binary bytes and unlisted names', async (t) => {
  const directory = tempDir(t, 'host-files-notext-');
  fs.writeFileSync(
    path.join(directory, 'bin.dat'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
  );
  fs.writeFileSync(path.join(directory, 'a.txt'), 'text');
  fs.mkdirSync(path.join(directory, 'sub'));
  const { files, sent } = makeFiles(directory);
  await files.list('stream-1', 'list-1');

  files.preview('stream-1', 'pv-bin', 'bin.dat');
  assert.equal(sent.find((m) => m.requestId === 'pv-bin').code, 'fs_not_text');

  for (const name of ['sub', 'ghost', '../x']) {
    const before = sent.length;
    files.preview('stream-1', `pv-${name}`, name);
    assert.equal(sent.slice(before)[0].code, 'fs_not_found', `rejected ${name}`);
  }
});

test('rename moves a listed entry and keeps the download whitelist true', async (t) => {
  const directory = tempDir(t, 'host-files-rename-');
  fs.writeFileSync(path.join(directory, 'old.txt'), 'data');
  const { files, sent } = makeFiles(directory);
  await files.list('stream-1', 'list-1');

  files.rename('stream-1', 'mv-1', 'old.txt', 'new.txt');
  assert.equal(sent.find((m) => m.requestId === 'mv-1').type, 'fs_mutation_done');
  assert.ok(fs.existsSync(path.join(directory, 'new.txt')));
  assert.ok(!fs.existsSync(path.join(directory, 'old.txt')));

  // The new name downloads; the old one is refused.
  await files.download('stream-1', 'dl-1', ['new.txt']);
  assert.equal(sent.find((m) => m.requestId === 'dl-1').type, 'fs_download_ready');
  const before = sent.length;
  await files.download('stream-1', 'dl-2', ['old.txt']);
  assert.equal(sent.slice(before).find((m) => m.type === 'error').code, 'fs_not_found');
});

test('rename onto an existing name is refused', async (t) => {
  const directory = tempDir(t, 'host-files-exists-');
  fs.writeFileSync(path.join(directory, 'a.txt'), 'a');
  fs.writeFileSync(path.join(directory, 'b.txt'), 'b');
  const { files, sent } = makeFiles(directory);
  await files.list('stream-1', 'list-1');

  files.rename('stream-1', 'mv-1', 'a.txt', 'b.txt');
  assert.equal(sent.find((m) => m.requestId === 'mv-1').code, 'fs_exists');
  assert.equal(fs.readFileSync(path.join(directory, 'b.txt'), 'utf8'), 'b');
});

test('delete removes a listed file, and a directory with everything inside', async (t) => {
  const directory = tempDir(t, 'host-files-delete-');
  fs.mkdirSync(path.join(directory, 'sub', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'sub', 'deep', 'x.txt'), 'x');
  fs.writeFileSync(path.join(directory, 'a.txt'), 'a');
  const { files, sent } = makeFiles(directory);
  await files.list('stream-1', 'list-1');

  files.remove('stream-1', 'rm-1', 'sub');
  assert.equal(sent.find((m) => m.requestId === 'rm-1').type, 'fs_mutation_done');
  assert.ok(!fs.existsSync(path.join(directory, 'sub')));

  files.remove('stream-1', 'rm-2', 'a.txt');
  assert.equal(sent.find((m) => m.requestId === 'rm-2').type, 'fs_mutation_done');
  assert.ok(!fs.existsSync(path.join(directory, 'a.txt')));

  const before = sent.length;
  await files.download('stream-1', 'dl-1', ['a.txt']);
  assert.equal(sent.slice(before).find((m) => m.type === 'error').code, 'fs_not_found');
});

test('mutations before any listing fail instead of touching a path', async (t) => {
  const directory = tempDir(t, 'host-files-nolist2-');
  const { files, sent } = makeFiles(directory);
  files.rename('stream-1', 'mv-1', 'a', 'b');
  files.remove('stream-1', 'rm-1', 'a');
  files.preview('stream-1', 'pv-1', 'a');
  assert.deepEqual(
    sent.map((m) => m.code),
    ['fs_not_found', 'fs_not_found', 'fs_not_found'],
  );
});
