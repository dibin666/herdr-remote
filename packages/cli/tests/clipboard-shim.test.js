import { test } from 'vitest';
import assert from 'node:assert/strict';
import { clipboardOp } from '../src/connector/clipboard-shim.js';

// The shapes a stand-in forwards to the window, and the ones that keep
// meaning the workstation's own clipboard.

test('the Wayland pair forwards text and stays home for images and other seats', () => {
  assert.equal(clipboardOp('wl-copy', ['--type', 'text/plain;charset=utf-8']), 'write');
  assert.equal(clipboardOp('wl-copy', []), 'write');
  assert.equal(clipboardOp('wl-copy', ['--type', 'image/png']), null);
  assert.equal(clipboardOp('wl-copy', ['--primary']), null);
  assert.equal(clipboardOp('wl-copy', ['--clear']), 'clear');
  assert.equal(clipboardOp('wl-paste', ['--type', 'text/plain;charset=utf-8']), 'read');
  assert.equal(clipboardOp('wl-paste', []), 'read');
  assert.equal(clipboardOp('wl-paste', ['--type=image/png']), null);
  assert.equal(clipboardOp('wl-paste', ['--list-types']), null);
  assert.equal(clipboardOp('wl-paste', ['--watch', 'echo']), null);
});

test('xclip needs the clipboard selection, then -in writes and -out reads', () => {
  assert.equal(clipboardOp('xclip', ['-selection', 'clipboard', '-in']), 'write');
  assert.equal(clipboardOp('xclip', ['-selection', 'clipboard', '-out']), 'read');
  assert.equal(clipboardOp('xclip', ['-selection', 'clip', '-o']), 'read');
  assert.equal(clipboardOp('xclip', ['-in']), null);
  assert.equal(clipboardOp('xclip', ['-selection', 'primary', '-out']), null);
  assert.equal(clipboardOp('xclip', ['-selection', 'clipboard']), null);
});

test('xsel needs --clipboard, then --input writes and --output reads', () => {
  assert.equal(clipboardOp('xsel', ['--clipboard', '--input']), 'write');
  assert.equal(clipboardOp('xsel', ['--clipboard', '--output']), 'read');
  assert.equal(clipboardOp('xsel', ['-b', '-i']), 'write');
  assert.equal(clipboardOp('xsel', ['--input']), null);
  assert.equal(clipboardOp('xsel', ['--clipboard', '--delete']), 'clear');
});

test('the macOS pair maps to read and write outright', () => {
  assert.equal(clipboardOp('pbcopy', []), 'write');
  assert.equal(clipboardOp('pbpaste', []), 'read');
});

test('a tool that is not a stand-in never forwards', () => {
  assert.equal(clipboardOp('cat', ['--clipboard']), null);
  assert.equal(clipboardOp('wl-copy-real', []), null);
});
