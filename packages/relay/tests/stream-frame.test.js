'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { packStreamFrame, unpackStreamFrame } = require('../src/stream-frame');

test('stream frames route without changing the raw payload', () => {
  const payload = Buffer.from('\x1b[2J\x1b[H你好\0\xff', 'utf8');
  const frame = packStreamFrame('output', 'client-1', payload);
  const unpacked = unpackStreamFrame(frame);
  assert.equal(unpacked.type, 'output');
  assert.equal(unpacked.streamId, 'client-1');
  assert.deepEqual(unpacked.payload, payload);
});

test('stream frames reject malformed headers', () => {
  assert.throws(() => unpackStreamFrame(Buffer.from([0, 0, 0, 0])), /header is invalid/);
  assert.throws(() => unpackStreamFrame(Buffer.from([0, 0, 0, 5, 123])), /truncated|invalid/);
});
