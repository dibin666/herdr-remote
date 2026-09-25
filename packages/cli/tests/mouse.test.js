// The mouse layer is TypeScript; vitest compiles it directly.

import { test } from 'vitest';
import assert from 'node:assert/strict';

const ESC = String.fromCharCode(27);

function loadMouse() {
  return import('../src/tui/mouse/index.tsx');
}

test('SGR press, release and motion reports are decoded', async () => {
  const { splitMouseInput } = await loadMouse();

  const press = splitMouseInput(`${ESC}[<0;12;5M`);
  assert.equal(press.events.length, 1);
  assert.deepEqual(
    {
      type: press.events[0].type,
      button: press.events[0].button,
      x: press.events[0].x,
      y: press.events[0].y,
    },
    { type: 'press', button: 'left', x: 12, y: 5 },
  );

  const release = splitMouseInput(`${ESC}[<0;12;5m`);
  assert.equal(release.events[0].type, 'release');

  // Bit 32 marks motion, which is what drives hover.
  const move = splitMouseInput(`${ESC}[<35;7;9M`);
  assert.equal(move.events[0].type, 'move');
  assert.equal(move.events[0].x, 7);
  assert.equal(move.events[0].y, 9);

  const wheel = splitMouseInput(`${ESC}[<64;1;1M`);
  assert.equal(wheel.events[0].type, 'wheel');
  assert.equal(wheel.events[0].button, 'wheel-up');
  assert.equal(
    (await loadMouse()).splitMouseInput(`${ESC}[<65;1;1M`).events[0].button,
    'wheel-down',
  );
});

test('modifier bits are reported', async () => {
  const { splitMouseInput } = await loadMouse();
  const { events } = splitMouseInput(`${ESC}[<28;3;4M`); // 16 ctrl + 8 alt + 4 shift
  assert.equal(events[0].ctrl, true);
  assert.equal(events[0].alt, true);
  assert.equal(events[0].shift, true);
});

test('key input is passed through untouched', async () => {
  const { splitMouseInput } = await loadMouse();

  // Ink's key parser knows nothing about mouse reports; an unfiltered click
  // would reach useInput as a stray Escape and cancel whatever was being
  // edited. Everything else has to survive the filter byte for byte.
  const arrows = `${ESC}[A${ESC}[B`;
  const result = splitMouseInput(arrows);
  assert.equal(result.events.length, 0);
  assert.equal(result.passthrough, arrows);

  const mixed = splitMouseInput(`ab${ESC}[<0;1;1Mcd${ESC}[Aef`);
  assert.equal(mixed.events.length, 1);
  assert.equal(mixed.passthrough, `abcd${ESC}[Aef`);

  assert.equal(splitMouseInput('plain text').passthrough, 'plain text');
  assert.equal(splitMouseInput(`${ESC}`).pending, `${ESC}`);
});

test('a report split across chunks is reassembled', async () => {
  const { createMouseSplitter } = await loadMouse();
  const split = createMouseSplitter();

  const first = split(`${ESC}[<0;10`);
  assert.equal(first.events.length, 0);
  assert.equal(first.passthrough, '');

  const second = split(';20M');
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].x, 10);
  assert.equal(second.events[0].y, 20);
});

test('containment is half-open, so neighbouring rows never both match', async () => {
  const { rectContains } = await loadMouse();

  // The regression this guards: @ink-tools/ink-mouse tests `y <= top + height`,
  // so a one-row item at row 3 also claimed row 4 and two adjacent menu entries
  // fired for a single click — the mouse appeared to select the wrong line.
  const row3 = { left: 1, top: 3, width: 20, height: 1 };
  const row4 = { left: 1, top: 4, width: 20, height: 1 };

  assert.equal(rectContains(row3, 5, 3), true);
  assert.equal(rectContains(row3, 5, 4), false);
  assert.equal(rectContains(row4, 5, 4), true);
  assert.equal(rectContains(row4, 5, 3), false);

  // Columns behave the same way at the right edge.
  assert.equal(rectContains(row3, 20, 3), true);
  assert.equal(rectContains(row3, 21, 3), false);
  assert.equal(rectContains(row3, 0, 3), false);
});
