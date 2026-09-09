'use strict';

// Registration with the Herdr CLI.
//
// Installing from npm puts this package somewhere under a global node_modules
// tree; Herdr learns about it with `herdr plugin link <path>`. Doing that from
// here means the user never has to find the install directory themselves.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PACKAGE_ROOT } = require('./config');
const { resolveHerdrCommand } = require('./herdr-command');

const PLUGIN_ID = 'herdr.remote.web';
const MANIFEST_NAME = 'herdr-plugin.toml';

function manifestPath() {
  return path.join(PACKAGE_ROOT, MANIFEST_NAME);
}

// Registration also runs from `herdr plugin` actions and from the service
// manager, neither of which is guaranteed the PATH the user installed with, so
// the command is resolved rather than named.
function herdrAvailable() {
  const result = spawnSync(resolveHerdrCommand(), ['--version'], { stdio: 'ignore' });
  return result.status === 0 || result.status === 1;
}

function runHerdr(args, { timeout = 15_000 } = {}) {
  const result = spawnSync(resolveHerdrCommand(), args, { encoding: 'utf8', timeout });
  if (result.error && result.error.code === 'ENOENT') {
    const error = new Error('herdr command not found');
    error.code = 'HERDR_NOT_FOUND';
    throw error;
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
function parsePluginList(output) {
  const plugins = [];
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
      warnings: rawSource && rawSource.includes(';') ? rawSource.slice(rawSource.indexOf(';') + 1).trim() : null,
      localPath: source && source.startsWith('local:') ? source.slice('local:'.length) : null,
    });
  }
  return plugins;
}

function registrationStatus() {
  if (!fs.existsSync(manifestPath())) {
    return { available: false, registered: false, reason: 'manifest missing' };
  }
  let result;
  try {
    result = runHerdr(['plugin', 'list']);
  } catch (error) {
    if (error.code === 'HERDR_NOT_FOUND') return { available: false, registered: false, reason: 'herdr not found' };
    throw error;
  }
  if (result.status !== 0) {
    return { available: true, registered: false, reason: String(result.stderr || '').trim() };
  }
  const plugins = parsePluginList(result.stdout);
  const entry = plugins.find((plugin) => plugin.id === PLUGIN_ID);
  if (!entry) return { available: true, registered: false, packageRoot: PACKAGE_ROOT };
  return {
    available: true,
    registered: true,
    enabled: entry.enabled,
    linkedPath: entry.localPath,
    // A stale link pointing at an old checkout is the main failure mode after
    // switching from a source install to npm.
    stale: Boolean(entry.localPath) && path.resolve(entry.localPath) !== path.resolve(PACKAGE_ROOT),
    packageRoot: PACKAGE_ROOT,
  };
}

function register() {
  const current = registrationStatus();
  if (current.registered && current.stale) {
    // Herdr refuses to link a second plugin with the same id, so drop the old
    // link before pointing it at this install.
    runHerdr(['plugin', 'unlink', PLUGIN_ID]);
  }
  const result = runHerdr(['plugin', 'link', PACKAGE_ROOT]);
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || '').trim() || 'herdr plugin link failed');
  }
  return { ok: true, path: PACKAGE_ROOT, output: String(result.stdout || '').trim() };
}

function unregister() {
  const result = runHerdr(['plugin', 'unlink', PLUGIN_ID]);
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || '').trim() || 'herdr plugin unlink failed');
  }
  return { ok: true, output: String(result.stdout || '').trim() };
}

module.exports = {
  PLUGIN_ID,
  manifestPath,
  herdrAvailable,
  parsePluginList,
  registrationStatus,
  register,
  unregister,
};
