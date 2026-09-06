'use strict';

// The relay lets a read-only client scroll its own PTY stream, so this matcher
// is a trust boundary: it decides which bytes a device without the control
// lease may put into a terminal. It has to admit wheel reports and nothing at
// all besides them.

const test = require('node:test');
const assert = require('node:assert/strict');
const { isWheelOnlyInput } = require('../src/scroll-input');

const bytes = (text) => Buffer.from(text, 'binary');
const ESC = '\x1b';

test('wheel reports are recognised in every encoding a terminal emits', () => {
  // SGR: wheel up and wheel down, which is all a scroll can be.
  assert.equal(isWheelOnlyInput(bytes(`${ESC}[<64;12;5M`)), true);
  assert.equal(isWheelOnlyInput(bytes(`${ESC}[<65;1;1M`)), true);
  // Modifier bits (shift 4, alt 8, ctrl 16) ride along with the wheel.
  assert.equal(isWheelOnlyInput(bytes(`${ESC}[<93;200;60M`)), true);
  // SGR-pixels reports the same code with pixel coordinates.
  assert.equal(isWheelOnlyInput(bytes(`${ESC}[<64;1024;768M`)), true);
  // Default single-byte encoding: code/col/row biased by 32.
  assert.equal(isWheelOnlyInput(Buffer.from([0x1b, 0x5b, 0x4d, 0x60, 0x30, 0x30])), true);
  assert.equal(isWheelOnlyInput(Buffer.from([0x1b, 0x5b, 0x4d, 0x61, 0xff, 0xff])), true);
  // A flick is many notches in one frame.
  assert.equal(isWheelOnlyInput(bytes(`${ESC}[<65;12;5M${ESC}[<65;12;5M${ESC}[<65;12;5M`)), true);
});

test('anything that is not purely a wheel report is refused', () => {
  assert.equal(isWheelOnlyInput(bytes('')), false);
  assert.equal(isWheelOnlyInput(null), false);

  // Ordinary typing, including the sequences a TUI treats as navigation.
  assert.equal(isWheelOnlyInput(bytes('ls\r')), false);
  assert.equal(isWheelOnlyInput(bytes('\x03')), false);
  assert.equal(isWheelOnlyInput(bytes(`${ESC}[A`)), false);
  assert.equal(isWheelOnlyInput(bytes(`${ESC}OB`)), false);

  // Other mouse activity: press, release, drag and motion are not scrolling.
  assert.equal(isWheelOnlyInput(bytes(`${ESC}[<0;12;5M`)), false);
  assert.equal(isWheelOnlyInput(bytes(`${ESC}[<0;12;5m`)), false);
  assert.equal(isWheelOnlyInput(bytes(`${ESC}[<32;12;5M`)), false);
  assert.equal(isWheelOnlyInput(bytes(`${ESC}[<35;12;5M`)), false);
  // A release terminator must not be accepted even with a wheel code.
  assert.equal(isWheelOnlyInput(bytes(`${ESC}[<65;12;5m`)), false);
  // Button 2 shares no bits with the wheel and stays out.
  assert.equal(isWheelOnlyInput(Buffer.from([0x1b, 0x5b, 0x4d, 0x22, 0x30, 0x30])), false);

  // A keystroke smuggled onto the end of a valid report rejects the frame.
  assert.equal(isWheelOnlyInput(bytes(`${ESC}[<65;12;5M\x03`)), false);
  assert.equal(isWheelOnlyInput(bytes(`\x03${ESC}[<65;12;5M`)), false);

  // Truncated or malformed reports are not "close enough".
  assert.equal(isWheelOnlyInput(bytes(`${ESC}[<65;12;5`)), false);
  assert.equal(isWheelOnlyInput(bytes(`${ESC}[<65;12M`)), false);
  assert.equal(isWheelOnlyInput(bytes(`${ESC}[<;12;5M`)), false);
  assert.equal(isWheelOnlyInput(Buffer.from([0x1b, 0x5b, 0x4d, 0x60, 0x30])), false);
  // Parameters no terminal would emit are rejected rather than parsed.
  assert.equal(isWheelOnlyInput(bytes(`${ESC}[<65;999999;5M`)), false);
});
