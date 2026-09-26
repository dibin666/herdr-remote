/**
 * A throwaway Herdr session in a PTY, fed into the same headless xterm build
 * the browser uses, for scripts that need to see what Herdr really draws.
 * Everything runs in the named session `hr-probe`; callers stop and delete it
 * with `cleanupSession` when done.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { Unicode11Addon } = require('@xterm/addon-unicode11');

const SESSION = 'hr-probe';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * This script is normally launched from inside a Herdr pane running Claude
 * Code. Both leave markers in the environment that would make the probe
 * attach to the wrong server or refuse to start a nested agent.
 */
function childEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('HERDR_') || key.startsWith('CLAUDE_') || key === 'CLAUDECODE') continue;
    env[key] = value;
  }
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', SHELL: '/usr/bin/fish' };
}

function herdrCli(args) {
  try {
    return execFileSync('herdr', args, {
      env: childEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return String(error.stdout || '') + String(error.stderr || '');
  }
}

export function probeSessionExists() {
  try {
    return (JSON.parse(herdrCli(['session', 'list', '--json'])).sessions || []).some(
      (s) => s.name === SESSION,
    );
  } catch {
    return false;
  }
}

export function cleanupSession() {
  herdrCli(['session', 'stop', SESSION]);
  herdrCli(['session', 'delete', SESSION]);
}

const herdrVersion = herdrCli(['--version']).trim();

export class Probe {
  constructor(cols, rows, cwd, layout) {
    this.cols = cols;
    this.rows = rows;
    this.cwd = cwd;
    this.layout = layout;
    this.seqs = { begins: 0, ends: 0, open: false, keyboard: new Set() };
    this.lastOutputAt = Date.now();
  }

  start() {
    const term = new Terminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: 5000,
      convertEol: true,
      allowProposedApi: true,
    });
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    this.term = term;

    const seqs = this.seqs;
    const flat = (params) => params.flatMap((p) => (Array.isArray(p) ? p : [p]));
    const onMode = (set) => (params) => {
      if (flat(params).includes(2026)) {
        if (set) seqs.begins++;
        else seqs.ends++;
        seqs.open = set;
      }
      return false;
    };
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, onMode(true));
    term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, onMode(false));
    for (const prefix of ['>', '<', '=']) {
      term.parser.registerCsiHandler({ prefix, final: 'u' }, (params) => {
        seqs.keyboard.add(`${prefix}${flat(params).join(';')}u`);
        return false;
      });
    }

    this.proc = pty.spawn('herdr', ['--session', SESSION], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: childEnv(),
    });
    this.proc.onData((data) => {
      this.lastOutputAt = Date.now();
      term.write(data);
    });
    // Replies (DA, CPR, OSC colour queries) must reach Herdr exactly as the
    // browser would send them, or it waits for answers that never come.
    term.onData((data) => this.proc.write(data));
  }

  flush() {
    return new Promise((resolve) => this.term.write('', resolve));
  }

  async settle(quietMs = 600, maxMs = 8000) {
    const started = Date.now();
    await sleep(Math.min(quietMs, 100));
    while (Date.now() - started < maxMs && Date.now() - this.lastOutputAt < quietMs) {
      await sleep(50);
    }
    await this.flush();
  }

  async send(text, perCharMs = 0) {
    if (!perCharMs) {
      this.proc.write(text);
      return;
    }
    for (const ch of text) {
      this.proc.write(ch);
      await sleep(perCharMs);
    }
  }

  lines() {
    const buffer = this.term.buffer.active;
    return Array.from(
      { length: this.rows },
      (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(false) ?? '',
    );
  }

  cursor() {
    const buffer = this.term.buffer.active;
    return {
      x: buffer.cursorX,
      y: buffer.cursorY,
      hidden: Boolean(this.term._core?.coreService?.isCursorHidden),
    };
  }

  async waitFor(pattern, timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await this.flush();
      if (pattern.test(this.lines().join('\n'))) return true;
      await sleep(100);
    }
    return false;
  }

  /** First column of the focused pane: the cell after the nearest `│` left of the cursor. */
  paneStart() {
    const { x, y } = this.cursor();
    return this.lines()[y].lastIndexOf('│', x - 1) + 1;
  }

  /** What sits between the pane's left edge and the cursor on the cursor row. */
  beforeCursor() {
    const { x, y } = this.cursor();
    return [...this.lines()[y]].slice(this.paneStart(), x).join('');
  }

  snapshot(name) {
    const buffer = this.term.buffer.active;
    const cell = buffer.getNullCell();
    const attrs = [];
    const wide = [];
    for (let y = 0; y < this.rows; y++) {
      const line = buffer.getLine(buffer.baseY + y);
      let run = null;
      for (let x = 0; line && x < this.cols; x++) {
        line.getCell(x, cell);
        if (cell.getWidth() === 2) wide.push([y, x]);
        const inverse = cell.isInverse() ? 1 : 0;
        const dim = cell.isDim() ? 1 : 0;
        const bg = cell.isBgDefault() ? null : cell.getBgColor();
        if (!inverse && !dim && bg === null) {
          run = null;
          continue;
        }
        if (
          run &&
          run.inverse === inverse &&
          run.dim === dim &&
          run.bg === bg &&
          run.col + run.len === x
        ) {
          run.len++;
        } else {
          run = { row: y, col: x, len: 1, inverse, dim, bg };
          attrs.push(run);
        }
      }
    }
    return {
      schema: 1,
      name,
      source: { herdr: herdrVersion, layout: this.layout, cols: this.cols, rows: this.rows },
      cursor: { ...this.cursor(), style: this.term.options.cursorStyle ?? 'block' },
      lines: this.lines(),
      wide,
      attrs,
      sync: { begins: this.seqs.begins, ends: this.seqs.ends, openAtSnapshot: this.seqs.open },
      keyboard: [...this.seqs.keyboard],
    };
  }

  stop() {
    try {
      this.proc?.kill();
    } catch {
      // already gone
    }
    this.term?.dispose();
  }
}
