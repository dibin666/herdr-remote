// What font detection reads the world through, injectable for tests, and the
// unit conversions every reader shares.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface RunResult {
  status: number | null;
  stdout: string;
}

export interface FontDeps {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  home?: string;
  run?: (command: string, args: string[]) => RunResult;
  readFile?: (filePath: string) => string | null;
  readBuffer?: (filePath: string) => Buffer | null;
  /** The emulator's own command line, for terminals configured there (xterm). */
  terminalArgs?: string[];
}

export type Deps = Required<FontDeps>;

/** A font as a terminal's settings name it. */
export interface FontSetting {
  family: string;
  sizePx?: number;
}

/** Terminals size fonts in points; CSS pixels are 1/96 inch. */
const PX_PER_PT = 96 / 72;
const COMMAND_TIMEOUT_MS = 3000;

/** Names a terminal accepts in place of a real family. */
export const GENERIC_FAMILIES = new Set([
  'monospace',
  'mono',
  'sans',
  'sans-serif',
  'serif',
  'system-ui',
  'ui-monospace',
]);

export function defaultRun(command: string, args: string[]): RunResult {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS });
    return { status: result.status, stdout: result.stdout || '' };
  } catch {
    return { status: null, stdout: '' };
  }
}

function defaultReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function defaultReadBuffer(filePath: string): Buffer | null {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

export function withDefaults(deps: FontDeps = {}): Deps {
  const env = deps.env || process.env;
  return {
    env,
    platform: deps.platform || process.platform,
    home: deps.home || env.HOME || os.homedir(),
    run: deps.run || defaultRun,
    readFile: deps.readFile || defaultReadFile,
    readBuffer: deps.readBuffer || defaultReadBuffer,
    terminalArgs: deps.terminalArgs || [],
  };
}

export function configHome(deps: Deps): string {
  return deps.env.XDG_CONFIG_HOME || path.join(deps.home, '.config');
}

export function dataHome(deps: Deps): string {
  return deps.env.XDG_DATA_HOME || path.join(deps.home, '.local', 'share');
}

export function expandHome(filePath: string, deps: Deps): string {
  return filePath.startsWith('~/') ? path.join(deps.home, filePath.slice(2)) : filePath;
}

export function pointsToPx(points: unknown): number | undefined {
  const value = Number(points);
  return Number.isFinite(value) && value > 0 ? Math.round(value * PX_PER_PT * 10) / 10 : undefined;
}

export function positiveNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}
