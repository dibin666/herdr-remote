// Registration with the Herdr CLI.
//
// Installing from npm puts this package somewhere under a global node_modules
// tree; Herdr learns about it with `herdr plugin link <path>`. Doing that from
// here means the user never has to find the install directory themselves.

import fs from 'node:fs';
import path from 'node:path';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { PACKAGE_ROOT } from './paths.js';
import { herdrVersion, resolveHerdrCommand } from './herdr-command.js';

const PLUGIN_ID = 'herdr.remote.web';
const MANIFEST_NAME = 'herdr-plugin.toml';

/** One line of `herdr plugin list`. */
export interface PluginListEntry {
  id: string;
  name: string;
  enabled: boolean;
  source: string | null;
  warnings: string | null;
  localPath: string | null;
}

/** Whether and where this package is linked into Herdr. */
export interface RegistrationStatus {
  available: boolean;
  registered: boolean;
  reason?: string;
  enabled?: boolean;
  linkedPath?: string | null;
  stale?: boolean;
  packageRoot?: string;
  version?: string | null;
  versionSupported?: boolean;
}

function manifestPath(): string {
  return path.join(PACKAGE_ROOT, MANIFEST_NAME);
}

// Registration also runs from `herdr plugin` actions and from the service
// manager, neither of which is guaranteed the PATH the user installed with, so
// the command is resolved rather than named.
function runHerdr(args: string[], { timeout = 15_000 } = {}): SpawnSyncReturns<string> {
  const result = spawnSync(resolveHerdrCommand(), args, { encoding: 'utf8', timeout });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    throw Object.assign(new Error('herdr command not found'), { code: 'HERDR_NOT_FOUND' });
  }
  return result;
}

/**
 * Parse `herdr plugin list`. Lines look like:
 *   - herdr.remote.web (Herdr Remote Web) enabled [local:/path/to/package]
 *
 * Herdr appends diagnostics inside the brackets when something is wrong, e.g.
 * `[local:/path; 1 warning(s)]`, so everything from the first `;` is dropped
 * before the path is read.
 */
function parsePluginList(output: unknown): PluginListEntry[] {
  const plugins: PluginListEntry[] = [];
  for (const line of String(output || '').split('\n')) {
    const match = /^-\s+(\S+)\s+\((.*?)\)\s+(\S+)(?:\s+\[(.*)\])?/.exec(line.trim());
    if (!match) continue;
    const [, id, name, state, rawSource] = match;
    const source = rawSource ? rawSource.split(';')[0].trim() : null;
    plugins.push({
      id,
      name,
      enabled: state === 'enabled',
      source,
      warnings:
        rawSource && rawSource.includes(';')
          ? rawSource.slice(rawSource.indexOf(';') + 1).trim()
          : null,
      localPath: source && source.startsWith('local:') ? source.slice('local:'.length) : null,
    });
  }
  return plugins;
}

function registrationStatus(): RegistrationStatus {
  if (!fs.existsSync(manifestPath())) {
    return { available: false, registered: false, reason: 'manifest missing' };
  }
  // Carried on every answer: the screen that shows registration is also the one
  // that has to say the installed Herdr is too old for this plugin.
  const { version, supported } = herdrVersion();
  const installed = { version, versionSupported: supported };
  let result: SpawnSyncReturns<string>;
  try {
    result = runHerdr(['plugin', 'list']);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'HERDR_NOT_FOUND')
      return { available: false, registered: false, reason: 'herdr not found' };
    throw error;
  }
  if (result.status !== 0) {
    return {
      available: true,
      registered: false,
      reason: String(result.stderr || '').trim(),
      ...installed,
    };
  }
  const plugins = parsePluginList(result.stdout);
  const entry = plugins.find((plugin) => plugin.id === PLUGIN_ID);
  if (!entry)
    return { available: true, registered: false, packageRoot: PACKAGE_ROOT, ...installed };
  return {
    available: true,
    registered: true,
    enabled: entry.enabled,
    linkedPath: entry.localPath,
    // A stale link pointing at an old checkout is the main failure mode after
    // switching from a source install to npm.
    stale: entry.localPath ? path.resolve(entry.localPath) !== path.resolve(PACKAGE_ROOT) : false,
    packageRoot: PACKAGE_ROOT,
    ...installed,
  };
}

function register(): { ok: true; path: string; output: string } {
  const current = registrationStatus();
  if (current.registered && current.stale) {
    // Herdr refuses to link a second plugin with the same id, so drop the old
    // link before pointing it at this install.
    runHerdr(['plugin', 'unlink', PLUGIN_ID]);
  }
  const result = runHerdr(['plugin', 'link', PACKAGE_ROOT]);
  if (result.status !== 0) {
    throw new Error(
      String(result.stderr || result.stdout || '').trim() || 'herdr plugin link failed',
    );
  }
  return { ok: true, path: PACKAGE_ROOT, output: String(result.stdout || '').trim() };
}

function unregister(): { ok: true; output: string } {
  const result = runHerdr(['plugin', 'unlink', PLUGIN_ID]);
  if (result.status !== 0) {
    throw new Error(
      String(result.stderr || result.stdout || '').trim() || 'herdr plugin unlink failed',
    );
  }
  return { ok: true, output: String(result.stdout || '').trim() };
}

export { PLUGIN_ID, manifestPath, parsePluginList, registrationStatus, register, unregister };
