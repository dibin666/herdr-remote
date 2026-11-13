import { test } from 'vitest';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PasteUploads } from '../src/pasted-files.js';
import { PASTE_CHUNK_BYTES } from 'herdr-remote-relay/protocol';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function setup(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-upload-test-'));
  t.onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const sent = [];
  const uploads = new PasteUploads((payload) => sent.push(payload), tmpDir);
  return { uploads, sent, tmpDir };
}

const pulls = (sent) => sent.filter((m) => m.type === 'paste_file_chunk_request');

/** Feed `uploads` every slice it pulls for, taken in order from `bytes`. */
function feedAll(uploads, sent, streamId, requestId, bytes) {
  let answered = 0;
  for (;;) {
    const all = pulls(sent).filter((m) => m.requestId === requestId);
    if (all.length <= answered) break;
    const pull = all[answered];
    const offset = pull.index * PASTE_CHUNK_BYTES;
    const slice = bytes.subarray(offset, Math.min(bytes.length, offset + PASTE_CHUNK_BYTES));
    uploads.chunk(streamId, {
      requestId,
      index: pull.index,
      dataBase64: Buffer.from(slice).toString('base64'),
    });
    answered += 1;
  }
}

test('a chunked upload is saved slice by slice and answers its path', (t) => {
  const { uploads, sent, tmpDir } = setup(t);
  const bytes = crypto.randomBytes(PASTE_CHUNK_BYTES * 4 + 1234);

  uploads.begin('stream-1', {
    requestId: 'up1',
    mime: 'application/octet-stream',
    name: 'blob.bin',
    size: bytes.length,
  });

  // The host pulls a window of slices, not the file at once.
  const firstPulls = pulls(sent);
  assert.equal(firstPulls.length, 4);
  assert.deepEqual(
    firstPulls.map((m) => m.index),
    [0, 1, 2, 3],
  );

  feedAll(uploads, sent, 'stream-1', 'up1', bytes);

  const ready = sent.find((m) => m.type === 'paste_file_ready');
  assert.ok(ready, 'expected paste_file_ready');
  assert.equal(ready.requestId, 'up1');
  assert.equal(ready.clientId, 'stream-1');
  assert.equal(path.dirname(ready.path), tmpDir);
  assert.match(path.basename(ready.path), /-blob\.bin$/);
  assert.deepEqual(fs.readFileSync(ready.path), bytes);
});

test('a file well over the old 3 MB cap uploads fine chunked', (t) => {
  const { uploads, sent } = setup(t);
  const bytes = crypto.randomBytes(6 * 1024 * 1024);

  uploads.begin('stream-1', {
    requestId: 'big1',
    mime: 'application/octet-stream',
    name: 'huge.iso',
    size: bytes.length,
  });
  feedAll(uploads, sent, 'stream-1', 'big1', bytes);

  const ready = sent.find((m) => m.type === 'paste_file_ready');
  assert.ok(ready, 'expected paste_file_ready');
  assert.equal(fs.statSync(ready.path).size, bytes.length);
  assert.deepEqual(fs.readFileSync(ready.path), bytes);
});

test('a slice that is the wrong size aborts the upload and removes the file', (t) => {
  const { uploads, sent, tmpDir } = setup(t);
  uploads.begin('stream-1', {
    requestId: 'up2',
    mime: 'application/octet-stream',
    name: 'a.bin',
    size: 100,
  });

  const pull = pulls(sent)[0];
  uploads.chunk('stream-1', {
    requestId: 'up2',
    index: pull.index,
    dataBase64: Buffer.from('way too many bytes for this upload').toString('base64'),
  });

  const err = sent.find((m) => m.type === 'error');
  assert.ok(err, 'expected an error');
  assert.equal(err.code, 'paste_file_corrupt');
  assert.equal(err.requestId, 'up2');
  assert.equal(fs.readdirSync(tmpDir).length, 0, 'partial file must be removed');
  assert.equal(
    sent.some((m) => m.type === 'paste_file_ready'),
    false,
  );
});

test('an image whose first slice lies about its type is rejected', (t) => {
  const { uploads, sent, tmpDir } = setup(t);
  uploads.begin('stream-1', { requestId: 'up3', mime: 'image/png', size: 64 });

  const pull = pulls(sent)[0];
  uploads.chunk('stream-1', {
    requestId: 'up3',
    index: pull.index,
    dataBase64: Buffer.alloc(64, 0x41).toString('base64'),
  });

  const err = sent.find((m) => m.type === 'error');
  assert.equal(err?.code, 'paste_file_corrupt');
  assert.equal(fs.readdirSync(tmpDir).length, 0);
});

test('a valid image signature passes; files are never sniffed', (t) => {
  const { uploads, sent } = setup(t);
  const bytes = Buffer.concat([PNG_HEADER, crypto.randomBytes(56)]);
  uploads.begin('stream-1', { requestId: 'up4', mime: 'image/png', size: bytes.length });
  feedAll(uploads, sent, 'stream-1', 'up4', bytes);
  const ready = sent.find((m) => m.type === 'paste_file_ready');
  assert.ok(ready, 'expected paste_file_ready');
  assert.ok(ready.path.endsWith('.png'));
});

test('a duplicate or uninvited slice is ignored, not written twice', (t) => {
  const { uploads, sent } = setup(t);
  const bytes = Buffer.from('hello world, this is one small file');
  uploads.begin('stream-1', {
    requestId: 'up5',
    mime: 'application/octet-stream',
    name: 'a.txt',
    size: bytes.length,
  });

  // A slice pushed before any pull does nothing.
  uploads.chunk('stream-1', {
    requestId: 'up5',
    index: 0,
    dataBase64: bytes.toString('base64'),
  });
  assert.equal(
    sent.some((m) => m.type === 'error'),
    false,
  );

  feedAll(uploads, sent, 'stream-1', 'up5', bytes);
  const ready = sent.find((m) => m.type === 'paste_file_ready');
  assert.deepEqual(fs.readFileSync(ready.path), bytes);

  // A slice arriving after completion finds no upload.
  uploads.chunk('stream-1', {
    requestId: 'up5',
    index: 0,
    dataBase64: bytes.toString('base64'),
  });
  assert.equal(sent.filter((m) => m.type === 'error').length, 0);
});

test('dropping a stream erases its partial upload', (t) => {
  const { uploads, tmpDir } = setup(t);
  uploads.begin('stream-1', {
    requestId: 'up6',
    mime: 'application/octet-stream',
    name: 'a.bin',
    size: 500_000,
  });
  assert.ok(fs.readdirSync(tmpDir).length > 0);
  uploads.drop('stream-1');
  assert.equal(fs.readdirSync(tmpDir).length, 0, 'partial file must be removed');
});

test('begin with a bad mime or empty size is refused without touching disk', (t) => {
  const { uploads, sent, tmpDir } = setup(t);
  uploads.begin('stream-1', { requestId: 'bad1', mime: 'text/html', size: 10 });
  uploads.begin('stream-1', { requestId: 'bad2', mime: 'application/octet-stream', size: 0 });
  const codes = sent.filter((m) => m.type === 'error').map((m) => m.code);
  assert.deepEqual(codes, ['paste_file_unsupported', 'paste_file_empty']);
  assert.equal(fs.readdirSync(tmpDir).length, 0);
});
