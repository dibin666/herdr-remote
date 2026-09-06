'use strict';

// The browser cannot know what a Herdr session looks like on the workstation:
// the PTY carries color indices, and whoever renders them decides what they
// mean. These tests cover the path that closes that gap — asking the host's own
// terminal, and refusing to invent an answer when there is nothing to ask.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ANSI_KEYS,
  parseXColor,
  parseOscColorReply,
  paletteFromEnvironment,
  probeTerminalPalette,
  resolveHostPalette,
} = require('../src/terminal-palette');

const FULL_ANSI = Object.fromEntries(ANSI_KEYS.map((key, index) => [
  key,
  `#${index.toString(16).repeat(6)}`,
]));

test('X11 color replies become plain hex, at any channel width', () => {
  assert.equal(parseXColor('rgb:2222/2222/2626'), '#222226');
  assert.equal(parseXColor('rgb:cc/00/00'), '#cc0000');
  assert.equal(parseXColor('rgb:f/f/f'), '#ffffff');
  assert.equal(parseXColor('rgb:ffff/ffff/ffff'), '#ffffff');
  assert.equal(parseXColor('rgb:0000/0000/0000'), '#000000');
});

test('a reply that is not a color is not a color', () => {
  assert.equal(parseXColor(''), null);
  assert.equal(parseXColor('#ffffff'), null);
  assert.equal(parseXColor('rgb:zz/00/00'), null);
  assert.equal(parseXColor(null), null);
});

test('each OSC reply is matched to the query that asked for it', () => {
  const background = '\x1b]11;rgb:2222/2222/2626\x1b\\';
  const slotOne = '\x1b]4;1;rgb:cccc/0000/0000\x1b\\';

  assert.equal(parseOscColorReply(background, '\x1b]11'), '#222226');
  assert.equal(parseOscColorReply(background, '\x1b]10'), null);
  assert.equal(parseOscColorReply(slotOne, '\x1b]4;1'), '#cc0000');
  // Slot 1 must never satisfy a query for slot 11.
  assert.equal(parseOscColorReply('\x1b]4;11;rgb:7272/9f9f/cfcf\x1b\\', '\x1b]4;1'), null);
  // A BEL-terminated reply is just as valid as an ST-terminated one.
  assert.equal(parseOscColorReply('\x1b]11;rgb:1010/1010/1414\x07', '\x1b]11'), '#101014');
});

test('a palette captured by a parent process is inherited, not re-probed', () => {
  const captured = { background: '#222226', foreground: '#ffffff', ansi: FULL_ANSI };
  const env = { HERDR_TERM_PALETTE_JSON: JSON.stringify(captured) };

  const inherited = paletteFromEnvironment(env);
  assert.equal(inherited.background, '#222226');
  assert.deepEqual(Object.keys(inherited.ansi), ANSI_KEYS);

  let probed = false;
  const resolved = resolveHostPalette({ env, probe: () => { probed = true; return null; } });
  assert.equal(resolved.background, '#222226');
  assert.equal(probed, false, 'an inherited palette must not trigger a terminal probe');
});

test('a corrupt or empty inherited palette is discarded', () => {
  assert.equal(paletteFromEnvironment({ HERDR_TERM_PALETTE_JSON: 'not json' }), null);
  assert.equal(paletteFromEnvironment({ HERDR_TERM_PALETTE_JSON: '{}' }), null);
  assert.equal(paletteFromEnvironment({}), null);
});

test('with no terminal to ask, the host reports no palette instead of guessing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-palette-'));
  const notATerminal = path.join(directory, 'regular-file');
  fs.writeFileSync(notATerminal, '');
  try {
    assert.equal(probeTerminalPalette({ ttyPath: path.join(directory, 'missing') }), null);
    assert.equal(probeTerminalPalette({ ttyPath: notATerminal }), null);
    assert.equal(resolveHostPalette({ env: {}, probe: () => null }), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a silent terminal ends the probe quickly instead of stalling the start', () => {
  // /dev/null opens and accepts the queries but never answers one.
  const started = Date.now();
  const palette = probeTerminalPalette({ ttyPath: '/dev/null', timeoutMs: 600 });
  assert.equal(palette, null);
  assert.ok(Date.now() - started < 5000, 'the probe must stay bounded');
});

/**
 * Plans a host connector with throwaway config and state directories.
 *
 * The state directory matters: a palette remembered from an earlier start is a
 * legitimate source, so a test that says "no palette" has to run somewhere the
 * developer's own remembered palette cannot leak in.
 */
function planHostSpec(paletteJson) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-palette-spec-'));
  const previous = {
    palette: process.env.HERDR_TERM_PALETTE_JSON,
    config: process.env.HERDR_REMOTE_CONFIG_DIR,
    state: process.env.HERDR_REMOTE_STATE_DIR,
  };
  process.env.HERDR_REMOTE_CONFIG_DIR = path.join(directory, 'config');
  process.env.HERDR_REMOTE_STATE_DIR = path.join(directory, 'state');
  if (paletteJson === null) delete process.env.HERDR_TERM_PALETTE_JSON;
  else process.env.HERDR_TERM_PALETTE_JSON = paletteJson;
  // Required: the module caches the first palette it resolves.
  delete require.cache[require.resolve('../src/service')];
  try {
    const { serviceSpecs } = require('../src/service');
    const state = { hostId: 'host-test', hostToken: 'a'.repeat(32) };
    const config = JSON.parse(JSON.stringify(require('../src/config').DEFAULTS));
    return serviceSpecs(config, state).find((spec) => spec.name === 'host');
  } finally {
    for (const [key, value] of [
      ['HERDR_TERM_PALETTE_JSON', previous.palette],
      ['HERDR_REMOTE_CONFIG_DIR', previous.config],
      ['HERDR_REMOTE_STATE_DIR', previous.state],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve('../src/service')];
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('a start hands the captured palette to the host connector', () => {
  // `serviceSpecs` runs where a terminal may still be attached; the connector
  // itself is usually detached and has nothing to ask.
  const host = planHostSpec(JSON.stringify({ background: '#222226', ansi: FULL_ANSI }));

  const forwarded = JSON.parse(host.env.HERDR_TERM_PALETTE_JSON);
  assert.equal(forwarded.background, '#222226');
  assert.deepEqual(Object.keys(forwarded.ansi), ANSI_KEYS);
});

test('a start with no palette adds no palette variable at all', () => {
  // No terminal in a test runner and no remembered palette in a fresh state
  // directory, so nothing may be claimed about the host's colors.
  const host = planHostSpec(null);
  assert.equal(host.env.HERDR_TERM_PALETTE_JSON, undefined);
});

test('a start with no terminal reuses the palette an earlier start remembered', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-palette-state-'));
  const previous = {
    palette: process.env.HERDR_TERM_PALETTE_JSON,
    config: process.env.HERDR_REMOTE_CONFIG_DIR,
    state: process.env.HERDR_REMOTE_STATE_DIR,
  };
  delete process.env.HERDR_TERM_PALETTE_JSON;
  process.env.HERDR_REMOTE_CONFIG_DIR = path.join(directory, 'config');
  process.env.HERDR_REMOTE_STATE_DIR = path.join(directory, 'state');
  delete require.cache[require.resolve('../src/service')];
  try {
    const { runtimeStatePath } = require('../src/config');
    const { ensureDir, writeJsonAtomic, readJson } = require('../src/state');
    ensureDir(path.join(directory, 'state'));
    writeJsonAtomic(runtimeStatePath(), {
      ...readJson(runtimeStatePath(), {}),
      terminalPalette: { background: '#222226', ansi: FULL_ANSI },
    });

    // A service manager start has no terminal to ask, but the workstation has
    // not changed color since the start that did.
    const { hostTerminalPalette } = require('../src/service');
    assert.equal(hostTerminalPalette().background, '#222226');
  } finally {
    for (const [key, value] of [
      ['HERDR_TERM_PALETTE_JSON', previous.palette],
      ['HERDR_REMOTE_CONFIG_DIR', previous.config],
      ['HERDR_REMOTE_STATE_DIR', previous.state],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve('../src/service')];
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the entry point captures once, before the TUI owns the screen', () => {
  const { captureTerminalPalette } = require('../src/terminal-palette');
  const probed = { background: '#222226', ansi: FULL_ANSI };

  // An answer already in the environment is reused; no second probe.
  let probes = 0;
  const inheritedEnv = { HERDR_TERM_PALETTE_JSON: JSON.stringify(probed) };
  const inherited = captureTerminalPalette({
    env: inheritedEnv,
    probe: () => { probes += 1; return probed; },
  });
  assert.equal(inherited.background, '#222226');
  assert.equal(probes, 0);

  // A captured palette is published for every child of this process.
  const freshEnv = {};
  const captured = captureTerminalPalette({ env: freshEnv, probe: () => probed });
  if (process.stdin.isTTY && process.stdout.isTTY) {
    assert.equal(captured.background, '#222226');
    assert.equal(JSON.parse(freshEnv.HERDR_TERM_PALETTE_JSON).background, '#222226');
  } else {
    // A test runner has no terminal, and nothing may be claimed about one.
    assert.equal(captured, null);
    assert.equal(freshEnv.HERDR_TERM_PALETTE_JSON, undefined);
  }
});

test('a palette captured at the entry point survives a start handed to a service manager', () => {
  // `herdr-remote start` may hand the work to systemd, which launches the
  // services outside this process tree: the environment does not reach them,
  // so the answer has to be written down.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-palette-handoff-'));
  const previous = {
    palette: process.env.HERDR_TERM_PALETTE_JSON,
    config: process.env.HERDR_REMOTE_CONFIG_DIR,
    state: process.env.HERDR_REMOTE_STATE_DIR,
  };
  delete process.env.HERDR_TERM_PALETTE_JSON;
  process.env.HERDR_REMOTE_CONFIG_DIR = path.join(directory, 'config');
  process.env.HERDR_REMOTE_STATE_DIR = path.join(directory, 'state');
  delete require.cache[require.resolve('../src/terminal-palette')];
  try {
    const {
      rememberTerminalPalette,
      rememberedTerminalPalette,
    } = require('../src/terminal-palette');

    assert.equal(rememberedTerminalPalette(), null);
    rememberTerminalPalette({ background: '#222226', foreground: '#ffffff', ansi: FULL_ANSI });

    const remembered = rememberedTerminalPalette();
    assert.equal(remembered.background, '#222226');
    assert.deepEqual(Object.keys(remembered.ansi), ANSI_KEYS);

    // A state file is not a trusted wire: junk in it is re-validated out.
    rememberTerminalPalette({ background: 'url(javascript:alert(1))' });
    assert.equal(rememberedTerminalPalette().background, '#222226');
  } finally {
    for (const [key, value] of [
      ['HERDR_TERM_PALETTE_JSON', previous.palette],
      ['HERDR_REMOTE_CONFIG_DIR', previous.config],
      ['HERDR_REMOTE_STATE_DIR', previous.state],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve('../src/terminal-palette')];
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const { collectPalette, takeOscColorReply } = require('../src/terminal-palette');

/** Formats a hex color the way a terminal answers: `rgb:RRRR/GGGG/BBBB`. */
function asXColor(hex) {
  return `rgb:${[1, 3, 5].map((index) => hex.slice(index, index + 2).repeat(2)).join('/')}`;
}

test('a terminal that reports its ANSI ramp but not its default colors still yields a palette', () => {
  // Exactly what a multiplexer between this process and the emulator did:
  // it answered every OSC 4 query and ignored OSC 10, 11 and 12.
  const answered = [];
  const palette = collectPalette((query, prefix) => {
    answered.push(prefix);
    const slot = /^\x1b\]4;(\d+)$/.exec(prefix);
    if (!slot) return null;
    const color = FULL_ANSI[ANSI_KEYS[Number(slot[1])]];
    // Answered the way a terminal answers, so the parser is exercised too.
    return parseOscColorReply(`${prefix};${asXColor(color)}\x1b\\`, prefix);
  });

  assert.deepEqual(palette.ansi, FULL_ANSI);
  assert.equal(palette.background, undefined);
  // The ramp is asked for whatever the first three queries did, so an
  // unanswered background never costs the sixteen colors that were available.
  assert.deepEqual(answered.slice(0, 3), ['\x1b]10', '\x1b]11', '\x1b]12']);
  assert.equal(answered.length, ANSI_KEYS.length + 3);
});

test('a terminal that answers nothing is dropped after four questions', () => {
  let asked = 0;
  const palette = collectPalette(() => { asked += 1; return null; });
  assert.equal(palette, null);
  // Three defaults and the first ANSI slot. Every further query would only add
  // its own timeout to a start that already knows the answer is "nothing".
  assert.equal(asked, 4, 'a silent terminal must not be asked nineteen times');
});

test('several replies in one read are consumed one at a time', () => {
  const state = {
    pending: '\x1b]4;0;rgb:2e2e/3434/3636\x1b\\\x1b]4;1;rgb:cccc/0000/0000\x07\x1b]11;rgb:2222/2222/2626\x1b\\',
  };

  assert.equal(takeOscColorReply(state, '\x1b]4;0'), '#2e3436');
  // Taking one answer must not throw away the ones behind it.
  assert.equal(takeOscColorReply(state, '\x1b]4;1'), '#cc0000');
  assert.equal(takeOscColorReply(state, '\x1b]11'), '#222226');
  assert.equal(state.pending, '');
  assert.equal(takeOscColorReply(state, '\x1b]10'), null);
});

test('a reply still arriving is not parsed out of a fragment', () => {
  const state = { pending: '\x1b]11;rgb:2222/2222' };
  assert.equal(takeOscColorReply(state, '\x1b]11'), null);
  state.pending += '/2626\x1b\\';
  assert.equal(takeOscColorReply(state, '\x1b]11'), '#222226');
});
