// Which terminal emulator this process is running in.

import fs from 'node:fs';
import path from 'node:path';
import { type Deps, defaultRun } from './deps.js';

/** An ancestor process. */
export interface ProcessEntry {
  pid: number;
  name: string;
}

/** Process names of the terminals this module can read, innermost wins. */
const TERMINAL_PROCESSES: [RegExp, string][] = [
  [/^gnome-terminal/, 'gnome-terminal'],
  [/^ptyxis/, 'ptyxis'],
  [/^tilix$/, 'tilix'],
  [/^konsole$/, 'konsole'],
  [/^xfce4-terminal$/, 'xfce4-terminal'],
  [/^kitty$/, 'kitty'],
  [/^alacritty$/i, 'alacritty'],
  [/^ghostty$/i, 'ghostty'],
  [/^wezterm-gui$/, 'wezterm'],
  [/^foot(client)?$/, 'foot'],
  [/^iTerm2$/, 'iterm2'],
  [/^Terminal$/, 'apple-terminal'],
  [/^xterm$/, 'xterm'],
  [/^(urxvt|urxvtd|rxvt)$/, 'urxvt'],
];

/**
 * The emulator a process runs under, from its own ancestry first.
 *
 * Environment variables leak through nested terminals — a kitty launched from
 * GNOME Terminal still carries `GNOME_TERMINAL_SCREEN` — whereas the nearest
 * emulator process above this one is the one actually drawing it. The
 * environment is the fallback for the common case where there is no such
 * ancestor: Herdr's server runs detached, so everything it starts, this
 * connector included, has lost its terminal parent but kept its variables.
 */
export function identifyTerminal({
  env = process.env,
  ancestry = [],
}: {
  env?: NodeJS.ProcessEnv;
  ancestry?: unknown[];
} = {}): string | null {
  for (const name of ancestry) {
    const base = path.basename(String(name || ''));
    for (const [pattern, id] of TERMINAL_PROCESSES) {
      if (pattern.test(base)) return id;
    }
  }

  const program = env.TERM_PROGRAM || '';
  if (program === 'vscode') return 'vscode';
  if (program === 'iTerm.app' || env.ITERM_SESSION_ID) return 'iterm2';
  if (program === 'Apple_Terminal') return 'apple-terminal';
  if (program === 'WezTerm' || env.WEZTERM_EXECUTABLE) return 'wezterm';
  if (program === 'ghostty' || env.GHOSTTY_RESOURCES_DIR) return 'ghostty';
  if (env.KITTY_WINDOW_ID || env.TERM === 'xterm-kitty') return 'kitty';
  if (env.ALACRITTY_SOCKET || env.ALACRITTY_WINDOW_ID || env.ALACRITTY_LOG) return 'alacritty';
  if (/^foot/.test(env.TERM || '')) return 'foot';
  if (env.KONSOLE_VERSION || env.KONSOLE_DBUS_SESSION) return 'konsole';
  if (env.PTYXIS_VERSION) return 'ptyxis';
  if (env.TILIX_ID) return 'tilix';
  if (env.GNOME_TERMINAL_SCREEN || env.GNOME_TERMINAL_SERVICE) return 'gnome-terminal';
  if (/^rxvt-unicode/.test(env.TERM || '')) return 'urxvt';
  // Last: a terminal started from xterm inherits this too.
  if (env.XTERM_VERSION) return 'xterm';
  return null;
}

/** This process's ancestors, nearest first: `{ pid, name }`. */
export function processLineage({
  platform = process.platform,
  pid = process.ppid,
  run = defaultRun,
}: {
  platform?: string;
  pid?: number;
  run?: Deps['run'];
} = {}): ProcessEntry[] {
  const lineage: ProcessEntry[] = [];
  if (platform === 'linux') {
    let current = pid;
    for (let depth = 0; depth < 32 && current > 1; depth += 1) {
      let stat: string;
      try {
        stat = fs.readFileSync(`/proc/${current}/stat`, 'utf8');
      } catch {
        break;
      }
      // `pid (comm) state ppid ...`, where comm may itself contain spaces.
      const open = stat.indexOf('(');
      const close = stat.lastIndexOf(')');
      if (open === -1 || close === -1) break;
      lineage.push({ pid: current, name: stat.slice(open + 1, close) });
      current = Number(stat.slice(close + 2).split(' ')[1]);
    }
    return lineage;
  }
  if (platform === 'darwin') {
    const result = run('ps', ['-axo', 'pid=,ppid=,comm=']);
    if (result.status !== 0) return lineage;
    const table = new Map<number, { ppid: number; comm: string }>();
    for (const line of result.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (match) table.set(Number(match[1]), { ppid: Number(match[2]), comm: match[3].trim() });
    }
    let current = pid;
    for (let depth = 0; depth < 32 && table.has(current) && current > 1; depth += 1) {
      const entry = table.get(current)!;
      lineage.push({ pid: current, name: entry.comm });
      current = entry.ppid;
    }
  }
  return lineage;
}

/** Names of this process's ancestors, nearest first. */
export function processAncestry(options: Parameters<typeof processLineage>[0] = {}): string[] {
  return processLineage(options).map((entry) => entry.name);
}

/** The command line of a running process, as its argument list. */
export function processArguments(pid: number, { platform = process.platform } = {}): string[] {
  if (platform !== 'linux') return [];
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

/** The ancestor process that is `source`'s emulator, if any. */
export function terminalProcess(source: string, lineage: ProcessEntry[]): ProcessEntry | null {
  return (
    lineage.find((entry) =>
      TERMINAL_PROCESSES.some(
        ([pattern, id]) => id === source && pattern.test(path.basename(String(entry.name || ''))),
      ),
    ) || null
  );
}
