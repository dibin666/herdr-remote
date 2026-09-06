'use strict';

/**
 * Reads the colors of the terminal the workstation is actually looking at.
 *
 * A browser cannot know what a Herdr session looks like on the host: the PTY
 * only carries color *indices*, and whoever renders them decides what "red"
 * or "the default background" means. So the host asks its own terminal, once,
 * with the standard OSC color queries every mainstream emulator answers:
 *
 *   OSC 10 ; ? — default foreground
 *   OSC 11 ; ? — default background
 *   OSC 12 ; ? — cursor
 *   OSC 4 ; n ; ? — ANSI slot n (0-15)
 *
 * The answers travel to the browser through `host_hello`, and xterm renders
 * with them. Nothing here guesses: without a terminal to ask, the result is
 * `null` and the browser keeps xterm's own defaults.
 */

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
// One definition of what a palette may contain, shared with the relay so the
// host cannot report a shape the wire rejects.
const { ANSI_PALETTE_KEYS, sanitizeTerminalPalette } = require('herdr-remote-relay/protocol');
const { runtimeStatePath, stateDir } = require('./config');
const { ensureDir, readJson, writeJsonAtomic } = require('./state');

const ANSI_SLOTS = ANSI_PALETTE_KEYS.length;
/**
 * VTIME in tenths of a second: the terminal driver returns from a read after
 * this long even with nothing to read, which is what bounds a silent terminal
 * without burning CPU in a poll loop.
 */
const READ_TIMEOUT_TENTHS = '3';
/**
 * Two empty reads in a row mean this query will not be answered.
 *
 * The resulting ~600ms per query is not padding: with a multiplexer between
 * this process and the emulator, the emulator's answer measurably arrives
 * later than 400ms, and giving up sooner makes the multiplexer answer from its
 * own configuration instead — a palette that is not the one on screen.
 */
const MAX_IDLE_READS = 2;
/**
 * The whole probe is bounded: a start must never wait on a terminal that
 * answers slowly, or not at all. Sized for the nineteen queries a fully
 * answering terminal replies to in milliseconds, with room for the mixed case
 * where the ANSI ramp is reported but the default colors are not.
 */
const TOTAL_TIMEOUT_MS = 3000;

const ANSI_KEYS = ANSI_PALETTE_KEYS;

/**
 * `rgb:RRRR/GGGG/BBBB` (and the 1/2/3-digit variants) to `#rrggbb`.
 * Terminals answer in 16-bit-per-channel notation; the top byte is the color.
 */
function parseXColor(value) {
  if (typeof value !== 'string') return null;
  const match = /^rgba?:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(value.trim());
  if (!match) return null;
  const channels = match.slice(1, 4).map((raw) => {
    const width = raw.length;
    if (width === 0 || width > 4) return null;
    const scaled = Math.round((parseInt(raw, 16) / (16 ** width - 1)) * 255);
    return Math.max(0, Math.min(255, scaled));
  });
  if (channels.some((channel) => channel === null)) return null;
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Locates one complete OSC reply, e.g. `ESC ] 11 ; rgb:2222/2222/2626 ESC \`.
 *
 * A reply is only complete once its terminator arrives, so a half-read answer
 * waits for the rest of the bytes instead of being parsed out of a fragment.
 */
function findOscColorReply(text, expectedPrefix) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf(`${expectedPrefix};`);
  if (start === -1) return null;

  const stringTerminator = text.indexOf('\x1b\\', start);
  const bell = text.indexOf('\x07', start);
  let bodyEnd = -1;
  let end = -1;
  if (stringTerminator !== -1 && (bell === -1 || stringTerminator < bell)) {
    bodyEnd = stringTerminator;
    end = stringTerminator + 2;
  } else if (bell !== -1) {
    bodyEnd = bell;
    end = bell + 1;
  } else {
    return null;
  }

  const color = parseXColor(text.slice(start + expectedPrefix.length + 1, bodyEnd).trim());
  return color ? { color, start, end } : null;
}

/** Pulls the color out of one OSC reply. */
function parseOscColorReply(reply, expectedPrefix) {
  return findOscColorReply(reply, expectedPrefix)?.color ?? null;
}

/** A palette is only usable if every field it claims to have is a real color. */
const sanitizePalette = sanitizeTerminalPalette;

/** Reads a palette a parent process already captured, so children never re-probe. */
function paletteFromEnvironment(env = process.env) {
  const raw = env.HERDR_TERM_PALETTE_JSON;
  if (!raw) return null;
  try {
    return sanitizePalette(JSON.parse(raw));
  } catch {
    return null;
  }
}

function runStty(args, ttyPath) {
  return spawnSync('stty', [...args, '-F', ttyPath], { encoding: 'utf8', timeout: 1000 });
}

/**
 * Takes one reply out of the buffered bytes, leaving the rest.
 *
 * One read can carry several answers, and a terminal is free to volunteer
 * bytes of its own; dropping everything on a match would throw away replies
 * the next query is still waiting for.
 */
function takeOscColorReply(state, expectedPrefix) {
  const found = findOscColorReply(state.pending, expectedPrefix);
  if (!found) return null;
  state.pending = state.pending.slice(0, found.start) + state.pending.slice(found.end);
  return found.color;
}

/**
 * Runs the color conversation over an injected `ask(query, prefix)`.
 *
 * Order is not cosmetic here, and it was settled by measurement rather than by
 * reasoning. Asking the default colors (OSC 10/11/12) first and the ANSI ramp
 * afterwards makes a multiplexer between this process and the emulator pass
 * the whole conversation through, and all nineteen answers then come from the
 * emulator that is actually painting the screen — one coherent palette, in a
 * few milliseconds. Asking the ramp first instead had the multiplexer answer
 * OSC 4 from its own configuration while the default colors went unanswered:
 * sixteen colors from one source, no background from the other.
 *
 * The ramp is asked for unconditionally, so a terminal that reports its colors
 * but not its defaults (or the reverse) still contributes what it knows. A
 * terminal that answers none of the first four questions is left alone rather
 * than asked fifteen more times.
 */
function collectPalette(ask) {
  const palette = {};

  const foreground = ask('\x1b]10;?\x1b\\', '\x1b]10');
  if (foreground) palette.foreground = foreground;
  const background = ask('\x1b]11;?\x1b\\', '\x1b]11');
  if (background) palette.background = background;
  const cursor = ask('\x1b]12;?\x1b\\', '\x1b]12');
  if (cursor) palette.cursor = cursor;

  const ansi = {};
  for (let slot = 0; slot < ANSI_SLOTS; slot += 1) {
    const color = ask(`\x1b]4;${slot};?\x1b\\`, `\x1b]4;${slot}`);
    if (!color) break;
    ansi[ANSI_KEYS[slot]] = color;
  }
  if (Object.keys(ansi).length === ANSI_SLOTS) palette.ansi = ansi;

  return sanitizePalette(palette);
}

/**
 * Asks one question and waits for that answer, on an already-raw terminal.
 * Anything the terminal volunteers in the meantime is kept in `pending` so a
 * late reply is still matched to the query it belongs to.
 */
function askTerminal(fd, query, expectedPrefix, state) {
  fs.writeSync(fd, query);
  const buffer = Buffer.alloc(256);
  let idleReads = 0;

  while (idleReads < MAX_IDLE_READS && Date.now() < state.overallDeadline) {
    const matched = takeOscColorReply(state, expectedPrefix);
    if (matched) return matched;
    let bytesRead = 0;
    try {
      // Blocking, but bounded by VTIME: it returns 0 when the terminal is quiet.
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error.code === 'EAGAIN') {
        idleReads += 1;
        continue;
      }
      return null;
    }
    if (bytesRead > 0) {
      state.pending += buffer.toString('latin1', 0, bytesRead);
      idleReads = 0;
    } else {
      idleReads += 1;
    }
  }

  return takeOscColorReply(state, expectedPrefix);
}

/**
 * Queries the controlling terminal for its colors.
 *
 * Returns `null` — never a guess — when there is no terminal, when the
 * terminal stays silent, or when anything about the exchange goes wrong.
 */
function probeTerminalPalette({ ttyPath = '/dev/tty', timeoutMs = TOTAL_TIMEOUT_MS } = {}) {
  if (process.platform === 'win32') return null;

  let fd = null;
  let savedMode = null;
  try {
    fd = fs.openSync(ttyPath, 'r+');
  } catch {
    return null;
  }

  try {
    const saved = runStty(['-g'], ttyPath);
    if (saved.status !== 0) return null;
    savedMode = saved.stdout.trim();
    // The reply is written to the terminal, not echoed by a line discipline:
    // raw mode is what lets this process read it instead of the user's shell.
    if (runStty(['raw', '-echo', 'min', '0', 'time', READ_TIMEOUT_TENTHS], ttyPath).status !== 0) return null;

    const state = { pending: '', overallDeadline: Date.now() + timeoutMs };
    return collectPalette((query, prefix) => askTerminal(fd, query, prefix, state));
  } catch {
    return null;
  } finally {
    if (savedMode) runStty([savedMode], ttyPath);
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

/**
 * Remembers a palette for the next start that has no terminal to ask.
 *
 * A service manager launches the services with no terminal at all, and the
 * workstation has not changed color just because systemd, rather than a
 * person, started it this time.
 */
function rememberTerminalPalette(palette) {
  const clean = sanitizePalette(palette);
  if (!clean) return null;
  try {
    ensureDir(stateDir());
    const state = readJson(runtimeStatePath(), {});
    writeJsonAtomic(runtimeStatePath(), { ...state, terminalPalette: clean });
  } catch {
    // A palette is a nicety; failing to remember it must not break a start.
  }
  return clean;
}

/** The palette a previous start captured from a terminal, if any. */
function rememberedTerminalPalette() {
  try {
    return sanitizePalette(readJson(runtimeStatePath(), {}).terminalPalette);
  } catch {
    return null;
  }
}

/**
 * The palette a service start should hand to its children: whatever a parent
 * already captured, otherwise a fresh probe of this process's terminal.
 */
function resolveHostPalette({ env = process.env, probe = probeTerminalPalette } = {}) {
  return paletteFromEnvironment(env) || probe() || null;
}

/**
 * Capture the terminal's colors at the entry point, before anything else takes
 * the screen.
 *
 * The configuration TUI owns the terminal once it starts, and a probe issued
 * underneath it would race its input handling for the reply. Asking here, at
 * the very start of the command, means every later caller in this process tree
 * simply inherits the answer through the environment.
 */
function captureTerminalPalette({ env = process.env, probe = probeTerminalPalette } = {}) {
  if (env.HERDR_TERM_PALETTE_JSON) return paletteFromEnvironment(env);
  // Without both ends on a terminal there is nobody to answer the query.
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;

  const palette = probe();
  if (!palette) return null;

  env.HERDR_TERM_PALETTE_JSON = JSON.stringify(palette);
  // The environment only reaches children of this process. A start handed to
  // systemd or launchd runs outside that tree, so the answer is written down
  // as well and picked up from there.
  rememberTerminalPalette(palette);
  return palette;
}

module.exports = {
  ANSI_KEYS,
  ANSI_SLOTS,
  parseXColor,
  parseOscColorReply,
  takeOscColorReply,
  collectPalette,
  sanitizePalette,
  paletteFromEnvironment,
  probeTerminalPalette,
  resolveHostPalette,
  captureTerminalPalette,
  rememberTerminalPalette,
  rememberedTerminalPalette,
};
