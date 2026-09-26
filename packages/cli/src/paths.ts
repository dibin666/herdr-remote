// Where herdr-remote keeps its files: the package itself, the configuration
// directory and the state directory.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Locate the package directory by walking up to our own package.json.
 *
 * This module runs from src/ under the tests and from dist/ once built.
 * Everything that matters — the plugin manifest, the host connector entry
 * point, the systemd unit's ExecStart — is resolved from this value, so it has
 * to be independent of where the code happens to be loaded from.
 */
function findPackageRoot(start: string): string {
  let directory = start;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(directory, 'package.json');
    try {
      if (JSON.parse(fs.readFileSync(candidate, 'utf8')).name === 'herdr-remote') return directory;
    } catch {
      // Keep climbing: a missing or unrelated package.json is expected.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return path.resolve(start, '..');
}

const PACKAGE_ROOT = findPackageRoot(import.meta.dirname);

/**
 * The canonical configuration directory.
 *
 * Deliberately NOT $HERDR_PLUGIN_CONFIG_DIR: Herdr sets that variable only when
 * it launches the plugin itself, so honouring it would give "herdr-remote" run
 * from a shell and the same tool run from a Herdr pane two different config
 * files. One path, one config; `migrateLegacyConfig()` imports the old one.
 */
function configDir(): string {
  return process.env.HERDR_REMOTE_CONFIG_DIR || path.join(os.homedir(), '.config', 'herdr-remote');
}

function stateDir(): string {
  return (
    process.env.HERDR_REMOTE_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'herdr-remote')
  );
}

function configPath(): string {
  return path.join(configDir(), 'config.json');
}

function runtimeStatePath(): string {
  return path.join(stateDir(), 'runtime.json');
}

/** Where a service (relay, host, supervisor) writes its output. */
function logPath(name: string): string {
  return path.join(stateDir(), `${name}.log`);
}

function legacyConfigPath(): string | null {
  return process.env.HERDR_PLUGIN_CONFIG_DIR
    ? path.join(process.env.HERDR_PLUGIN_CONFIG_DIR, 'config.json')
    : null;
}

export {
  PACKAGE_ROOT,
  configDir,
  stateDir,
  configPath,
  runtimeStatePath,
  logPath,
  legacyConfigPath,
};
