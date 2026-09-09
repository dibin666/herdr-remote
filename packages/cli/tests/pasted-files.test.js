'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  savePastedFile,
  cleanPastedDir,
  MIME_CONFIG,
  MAX_PASTE_BYTES,
} = require('../src/pasted-files');

// Valid magic byte fixtures for each supported image type
const FIXTURES = {
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
  'image/gif': Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]),
  'image/webp': Buffer.from([
    0x52, 0x49, 0x46, 0x46, // 'RIFF'
    0x20, 0x00, 0x00, 0x00, // size
    0x57, 0x45, 0x42, 0x50, // 'WEBP'
    0x56, 0x50, 0x38, 0x20, // 'VP8 '
  ]),
};

test('savePastedFile generates unpredictable filename ignoring client inputs, with extension derived from MIME', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-paste-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // Client attempts directory traversal / malicious naming
  const clientPayload = {
    mime: 'image/png',
    dataBase64: FIXTURES['image/png'].toString('base64'),
    fileName: '../../etc/passwd',
    name: 'malicious.sh',
  };

  const savedPath = savePastedFile({ ...clientPayload, dir: tmpDir });

  // 1. Must be directly inside tmpDir, never escaped
  assert.equal(path.dirname(savedPath), tmpDir);

  // 2. Filename must NOT contain any client-controlled strings
  const baseName = path.basename(savedPath);
  assert.ok(!baseName.includes('passwd'));
  assert.ok(!baseName.includes('malicious'));

  // 3. Extension must be derived strictly from MIME (.png)
  assert.ok(baseName.endsWith('.png'));

  // 4. UUID format check: 36 chars + .png = 40 chars
  const uuidPart = baseName.replace(/\.png$/, '');
  assert.match(uuidPart, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

test('savePastedFile derives appropriate extension for all supported MIME types', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-paste-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  for (const [mime, fixture] of Object.entries(FIXTURES)) {
    const savedPath = savePastedFile({
      mime,
      dataBase64: fixture.toString('base64'),
      dir: tmpDir,
    });
    const ext = MIME_CONFIG[mime].ext;
    assert.ok(savedPath.endsWith(ext), `expected ${savedPath} to end with ${ext}`);
  }
});

test('savePastedFile rejects file when magic bytes do not match declared MIME (sniffing)', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-paste-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // 1. ELF executable binary spoofed as image/png
  const fakePngElf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
  assert.throws(
    () => savePastedFile({ mime: 'image/png', dataBase64: fakePngElf.toString('base64'), dir: tmpDir }),
    /magic bytes do not match/i
  );

  // 2. Plain text spoofed as image/jpeg
  const fakeJpgText = Buffer.from('Hello world this is not a JPEG');
  assert.throws(
    () => savePastedFile({ mime: 'image/jpeg', dataBase64: fakeJpgText.toString('base64'), dir: tmpDir }),
    /magic bytes do not match/i
  );

  // 3. PNG magic bytes passed with declared image/webp
  assert.throws(
    () => savePastedFile({ mime: 'image/webp', dataBase64: FIXTURES['image/png'].toString('base64'), dir: tmpDir }),
    /magic bytes do not match/i
  );
});

test('savePastedFile re-checks size limit on host independently of relay', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-paste-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // Create oversized PNG buffer (> 3 MB)
  const oversizedBuf = Buffer.alloc(MAX_PASTE_BYTES + 1024);
  FIXTURES['image/png'].copy(oversizedBuf, 0);

  assert.throws(
    () => savePastedFile({ mime: 'image/png', dataBase64: oversizedBuf.toString('base64'), dir: tmpDir }),
    /exceeds maximum limit of 3 MB/i
  );
});

test('savePastedFile writes file with mode 0o600', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-paste-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const savedPath = savePastedFile({
    mime: 'image/png',
    dataBase64: FIXTURES['image/png'].toString('base64'),
    dir: tmpDir,
  });

  const stat = fs.statSync(savedPath);
  // On POSIX systems, verify mode permissions 0o600
  if (process.platform !== 'win32') {
    assert.equal(stat.mode & 0o777, 0o600);
  }
});

test('cleanPastedDir purges oldest files when count or byte limit is exceeded', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-paste-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const baseTime = 1700000000000;

  // Create 4 files with explicit sizes and mtimes
  const files = ['file1.png', 'file2.png', 'file3.png', 'file4.png'];
  for (let i = 0; i < files.length; i++) {
    const fullPath = path.join(tmpDir, files[i]);
    fs.writeFileSync(fullPath, Buffer.alloc(100, i));
    const mtime = new Date(baseTime + i * 1000);
    fs.utimesSync(fullPath, mtime, mtime);
  }

  // 1. Clean with maxFiles: 2 -> oldest two (file1, file2) must be deleted
  cleanPastedDir({ dir: tmpDir, maxFiles: 2, maxBytes: 1000, now: baseTime + 10000 });
  const remainingAfterCount = fs.readdirSync(tmpDir).sort();
  assert.deepEqual(remainingAfterCount, ['file3.png', 'file4.png']);

  // 2. Clean with maxBytes: 150 -> total remaining size is 200B (2 files * 100B).
  // Oldest remaining (file3.png) must be removed, leaving only file4.png
  cleanPastedDir({ dir: tmpDir, maxFiles: 10, maxBytes: 150, now: baseTime + 10000 });
  const remainingAfterBytes = fs.readdirSync(tmpDir);
  assert.deepEqual(remainingAfterBytes, ['file4.png']);
});

test('cleanPastedDir purges stale files older than 24 hours', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-paste-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const now = Date.now();
  const freshPath = path.join(tmpDir, 'fresh.png');
  const stalePath = path.join(tmpDir, 'stale.png');

  fs.writeFileSync(freshPath, Buffer.from('fresh'));
  fs.writeFileSync(stalePath, Buffer.from('stale'));

  // Fresh file: 1 hour old
  const freshTime = new Date(now - 1 * 3600 * 1000);
  fs.utimesSync(freshPath, freshTime, freshTime);

  // Stale file: 25 hours old (> 24 hours)
  const staleTime = new Date(now - 25 * 3600 * 1000);
  fs.utimesSync(stalePath, staleTime, staleTime);

  cleanPastedDir({ dir: tmpDir, now });

  assert.equal(fs.existsSync(freshPath), true, 'fresh file must remain');
  assert.equal(fs.existsSync(stalePath), false, 'stale file >24h must be deleted');
});
