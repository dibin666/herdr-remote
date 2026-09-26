#!/usr/bin/env node
/**
 * Records what Herdr really draws on the outer terminal, so the web client's
 * input-field detector is tuned against captured screens instead of guesses.
 *
 * Herdr composites every pane onto one screen and forwards only the focused
 * pane's cursor. Whether an agent's input box shows that cursor, where a
 * hidden one is parked, and how frames are fenced with ?2026 cannot be read
 * off any source here, so this script runs a throwaway Herdr session in a
 * PTY, feeds it into the same headless xterm build the browser uses, and
 * writes JSON fixtures for the unit tests.
 *
 * It never touches the user's own session: everything runs in the named
 * session `hr-probe`, which is stopped and deleted on exit. It never submits
 * a prompt to an agent: Enter is only pressed after the input row has been
 * read back and holds exactly the slash command meant to be run.
 *
 *   node scripts/capture-herdr-screens.mjs [--layout desktop|mobile|both]
 *        [--only name,name] [--explore]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupSession, Probe, probeSessionExists, sleep } from './lib/herdr-probe.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(REPO, 'packages/relay/web/src/test/fixtures/screens');
const LAYOUTS = { desktop: [120, 40], mobile: [48, 30] };

const ESC = '\x1b';
const CTRL_B = '\x02';
const CTRL_C = '\x03';
const CTRL_U = '\x15';
const BACKSPACE = '\x7f';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

// ---------------------------------------------------------------------------
// Helpers shared by the scenarios

async function shell(probe, command) {
  await probe.send(`${command}\r`);
  await probe.settle(800, 10000);
}

/**
 * Brings the probe back to a bare fish prompt. A scenario that left a Herdr
 * overlay or an agent open would otherwise swallow the next scenario's
 * command, as a rename box once swallowed `claude`.
 */
async function ensureShell(probe) {
  for (let i = 0; i < 4; i++) {
    const { y, hidden } = probe.cursor();
    const nearby = probe
      .lines()
      .slice(Math.max(0, y - 1), y + 1)
      .join('\n');
    if (!hidden && /hr-probe-\w+(?: \[\d+\])?>\s*($|\n)/.test(nearby)) return true;
    await probe.send(i < 2 ? ESC : CTRL_C);
    await probe.settle(800, 4000);
  }
  throw new Error('could not get back to a shell prompt');
}

async function startClaude(probe, capture) {
  await probe.send('claude\r');
  if (!(await probe.waitFor(/trust this folder|-- INSERT --/i, 40000)))
    throw new Error('claude did not start');
  await probe.settle(1500, 10000);
  if (/trust this folder/i.test(probe.lines().join('\n'))) {
    if (capture) await capture('claude-trust');
    // The dialog lists "No, exit" first; walk the selection onto "Yes".
    for (let i = 0; i < 3; i++) {
      if (/❯\s*Yes/.test(probe.lines().join('\n'))) break;
      await probe.send(`${ESC}[B`);
      await probe.settle(400);
    }
    if (!/❯\s*Yes/.test(probe.lines().join('\n')))
      throw new Error('could not select the trust option');
    await probe.send('\r');
  }
  if (!(await probe.waitFor(/-- INSERT --/, 40000))) throw new Error('claude input never appeared');
  await probe.settle(2500, 15000);
}

/**
 * Deletes typed input one character at a time until nothing but the prompt
 * decoration is left before the cursor. Ctrl+U only clears one visual line of
 * a wrapped Claude prompt, which once left text behind for Enter to submit.
 */
async function clearInput(probe, emptyPattern) {
  for (let i = 0; i < 400; i++) {
    if (emptyPattern.test(probe.beforeCursor())) return;
    await probe.send(BACKSPACE.repeat(8));
    await probe.settle(150, 2000);
  }
  throw new Error(`input did not clear: ${JSON.stringify(probe.beforeCursor())}`);
}

/**
 * Types a slash command and presses Enter only if the input is a single line
 * holding exactly that command: the row above the cursor must be the box's
 * top edge, and the cursor row must read prompt + command.
 */
async function runSlashCommand(probe, emptyPattern, command) {
  await clearInput(probe, emptyPattern);
  await probe.send(command, 60);
  await probe.settle();
  const { y } = probe.cursor();
  const above = [...probe.lines()[y - 1]].slice(probe.paneStart()).join('');
  const typed = probe.beforeCursor().replace(/^[❯›>│]?\s*/, '');
  if (typed !== command || !/^[─╭┌]/.test(above)) {
    throw new Error(`input holds ${JSON.stringify(probe.beforeCursor())}; refusing to press Enter`);
  }
  await probe.send('\r');
}

async function quitAgent(probe) {
  for (let i = 0; i < 3; i++) {
    await probe.send(CTRL_C);
    await sleep(300);
  }
  await probe.settle(1000, 8000);
}

// ---------------------------------------------------------------------------
// Scenarios. They run in order inside one probe session per layout.

const CLAUDE_EMPTY = /^❯\s*$/;

const scenarios = [
  {
    name: 'fish',
    async run({ probe, capture }) {
      await capture('fish-empty');
      await probe.send('echo hello', 60);
      await capture('fish-typed');
      await probe.send('\r');
      await probe.settle();
      await probe.send('ec', 60);
      await capture('fish-autosuggest');
      await probe.send(CTRL_U);
      await shell(probe, "read -s -P 'Password: ' secret");
      await capture('fish-password');
      await probe.send(CTRL_C);
      await probe.settle();
      await shell(probe, 'clear');
    },
  },
  {
    name: 'vim',
    async run({ probe, capture }) {
      await shell(probe, 'vim -u NONE notes.txt');
      await capture('vim-normal');
      await probe.send('o');
      await probe.send('typed', 60);
      await capture('vim-insert');
      await probe.send(ESC);
      await sleep(300);
      await probe.send(':q!\r');
      await probe.settle();
    },
  },
  {
    name: 'less',
    async run({ probe, capture }) {
      await shell(probe, 'less notes.txt');
      await capture('less');
      await probe.send('q');
      await probe.settle();
      await shell(probe, 'clear');
    },
  },
  {
    name: 'herdr-ui',
    async run({ probe, capture }) {
      await probe.send(`${CTRL_B}?`);
      await capture('herdr-help');
      await probe.send(ESC);
      await probe.settle();
      await probe.send(`${CTRL_B}w`);
      await capture('herdr-workspaces');
      await probe.send(ESC);
      await probe.settle();
    },
  },
  {
    name: 'claude',
    async run({ probe, capture }) {
      await startClaude(probe, capture);
      await capture('claude-empty');
      await probe.send('hello wor', 80);
      await capture('claude-typed');
      // Claude waits well over half a second before treating ESC as a key.
      await probe.send(ESC);
      await sleep(2000);
      await capture('claude-normal');
      await probe.send('0');
      await sleep(500);
      await capture('claude-normal-home');
      await probe.send('A');
      await capture('claude-insert-again');
      await clearInput(probe, CLAUDE_EMPTY);
      await capture('claude-cleared');
      await probe.send('你好');
      await capture('claude-cjk');
      await probe.send('世界', 120);
      await capture('claude-cjk-more');
      await clearInput(probe, CLAUDE_EMPTY);
      await probe.send('the quick brown fox jumps over the lazy dog '.repeat(3), 5);
      await capture('claude-wrapped');
      await clearInput(probe, CLAUDE_EMPTY);
      await probe.send('/mod', 80);
      await capture('claude-slash-suggest');
      await runSlashCommand(probe, CLAUDE_EMPTY, '/model');
      await capture('claude-model-menu', { settleMs: 1200 });
      await probe.send(ESC);
      await sleep(1500);
      await probe.settle(1000);
      await clearInput(probe, CLAUDE_EMPTY);
      await probe.send('?');
      await capture('claude-question');
      await probe.send(BACKSPACE);
      await sleep(500);
      await probe.settle();
      await probe.send('!');
      await capture('claude-bang');
      await probe.send('ls', 80);
      await capture('claude-bang-typed');
      await probe.send(BACKSPACE.repeat(3));
      await probe.settle();
      await quitAgent(probe);
      await shell(probe, 'clear');
    },
  },
  {
    name: 'split',
    async run({ probe, capture, layout }) {
      if (layout !== 'desktop') return;
      await probe.send(`${CTRL_B}v`);
      await probe.settle(1200);
      await capture('split-fish');
      await startClaude(probe, null);
      await capture('split-claude');
      await probe.send('split pane text', 60);
      await capture('split-claude-typed');
      await clearInput(probe, CLAUDE_EMPTY);
      await quitAgent(probe);
      await probe.send(`${CTRL_B}x`);
      await probe.settle(1200);
    },
  },
  {
    name: 'codex',
    async run({ probe, capture }) {
      await probe.send('codex\r');
      await probe.waitFor(/Trust this folder|›/, 30000);
      await probe.settle(2000, 15000);
      if (/Trust this folder/.test(probe.lines().join('\n'))) {
        await capture('codex-trust');
        if (!/› 1\. Trust and continue/.test(probe.lines().join('\n')))
          throw new Error('unexpected codex trust menu');
        await probe.send('\r');
        await probe.settle(3000, 20000);
      }
      await capture('codex-empty');
      await probe.send('hello codex', 80);
      await capture('codex-typed');
      await probe.send(BACKSPACE.repeat(11));
      await probe.settle();
      await quitAgent(probe);
      await shell(probe, 'clear');
    },
  },
  {
    name: 'pi',
    async run({ probe, capture }) {
      await probe.send('pi\r');
      await probe.settle(5000, 25000);
      await capture('pi-empty');
      await probe.send('hello pi', 80);
      await capture('pi-typed');
      // The nearest `│` left of pi's cursor is its own box edge, not a pane border.
      await runSlashCommand(probe, /^\s*$/, '/settings');
      await capture('pi-settings', { settleMs: 1200 });
      await probe.send(ESC);
      await probe.settle();
      await quitAgent(probe);
    },
  },
];

function printScreen(fixture) {
  const { cursor } = fixture;
  process.stdout.write(
    `\n=== ${fixture.name} cursor=${cursor.x},${cursor.y} hidden=${cursor.hidden} sync=${fixture.sync.begins}/${fixture.sync.ends}\n`,
  );
  fixture.lines.forEach((line, y) => {
    if (Math.abs(y - cursor.y) <= 5)
      process.stdout.write(`${y === cursor.y ? '>' : ' '}${String(y).padStart(2)}|${line}|\n`);
  });
}

async function main() {
  if (probeSessionExists()) cleanupSession();
  const layoutArg = option('layout', 'desktop');
  const layouts = layoutArg === 'both' ? ['desktop', 'mobile'] : [layoutArg];
  const only = option('only', '').split(',').filter(Boolean);
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-probe-'));
  fs.writeFileSync(
    path.join(workdir, 'notes.txt'),
    Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n'),
  );
  fs.mkdirSync(OUT_DIR, { recursive: true });

  try {
    for (const layout of layouts) {
      const [cols, rows] = LAYOUTS[layout];
      const probe = new Probe(cols, rows, workdir, layout);
      probe.start();
      const capture = async (name, { settleMs = 700 } = {}) => {
        await probe.settle(settleMs);
        const fixture = probe.snapshot(name);
        if (flag('explore')) printScreen(fixture);
        fs.writeFileSync(
          path.join(OUT_DIR, `${layout}-${name}.json`),
          `${JSON.stringify(fixture)}\n`,
        );
      };
      try {
        await probe.settle(1500, 15000);
        await ensureShell(probe);
        for (const scenario of scenarios) {
          if (only.length && !only.includes(scenario.name)) continue;
          process.stderr.write(`[capture] ${layout}: ${scenario.name}\n`);
          try {
            await ensureShell(probe);
            await scenario.run({ probe, capture, layout });
          } catch (error) {
            // One broken scenario must not cost the rest of the run.
            process.stderr.write(
              `[capture] ${layout}: ${scenario.name} failed: ${error.message}\n`,
            );
            await quitAgent(probe);
          }
        }
      } finally {
        probe.stop();
        cleanupSession();
      }
    }
  } finally {
    cleanupSession();
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`[capture] ${error.stack || error}\n`);
  cleanupSession();
  process.exit(1);
});
