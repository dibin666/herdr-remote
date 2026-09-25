// What a supervised copy needs from the shell that installed it.

import os from 'node:os';
import path from 'node:path';
import { findHerdrCommand } from '../herdr-command.js';
import { PACKAGE_ROOT } from '../paths.js';

export function cliEntryPoint(): string {
  return path.join(PACKAGE_ROOT, 'bin', 'herdr-remote.js');
}

/**
 * `PATH` for the unit: the one that is resolving commands right now, plus the
 * directory Herdr was found in.
 *
 * A service manager does not inherit the shell's environment. `systemd --user`
 * hands a unit something close to `/usr/local/bin:/usr/bin:/bin` and `launchd`
 * is no more generous, so a copy that works from a terminal loses `~/.local/bin`
 * — and with it `herdr` — the moment it is installed as a service. Freezing the
 * installing shell's `PATH` into the unit keeps the supervised copy able to find
 * Herdr, and Herdr able to find the tools it spawns in turn.
 */
export function servicePath({
  env = process.env,
  herdrCommand = null,
}: {
  env?: NodeJS.ProcessEnv;
  herdrCommand?: string | null;
} = {}): string {
  const entries = String(env.PATH || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  // The override already pins the exact binary; this is only so the session
  // itself can still reach it by name.
  if (herdrCommand) entries.push(path.dirname(herdrCommand));
  return [...new Set(entries)].join(path.delimiter);
}

/**
 * What has to be written into the unit file for a supervised start to behave
 * like the one the user just ran by hand.
 */
export function serviceEnvironment({
  env = process.env,
  home = os.homedir(),
  directories,
}: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  directories?: string[];
} = {}): Record<string, string> {
  const environment: Record<string, string> = {};
  const herdr = findHerdrCommand({ env, home, ...(directories ? { directories } : {}) });
  if (herdr.found) environment.HERDR_BIN_PATH = herdr.command;
  const searchPath = servicePath({ env, herdrCommand: herdr.found ? herdr.command : null });
  if (searchPath) environment.PATH = searchPath;
  return environment;
}
