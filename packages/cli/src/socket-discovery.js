'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function defaultSocketPath(env = process.env, platform = process.platform) {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'herdr', 'herdr.sock');
  }
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'herdr', 'herdr.sock');
}

function resolveSocketPath(configuredPath = null, env = process.env) {
  return configuredPath || env.HERDR_SOCKET_PATH || defaultSocketPath(env);
}

function inspectSocket(socketPath, options = {}) {
  if (typeof socketPath !== 'string' || socketPath.length === 0) {
    return { ok: false, reason: 'socket path is empty', path: socketPath };
  }
  try {
    const stat = fs.statSync(socketPath);
    if (process.platform !== 'win32' && !stat.isSocket()) {
      return { ok: false, reason: 'path is not a Unix socket', path: socketPath };
    }
    if (options.requireOwner !== false && typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      return { ok: false, reason: 'socket is not owned by the current user', path: socketPath, uid: stat.uid };
    }
    return { ok: true, path: socketPath, uid: stat.uid, mode: stat.mode };
  } catch (error) {
    return { ok: false, reason: error.code === 'ENOENT' ? 'socket does not exist' : error.message, path: socketPath };
  }
}

function assertSocket(socketPath, options = {}) {
  const result = inspectSocket(socketPath, options);
  if (!result.ok) {
    const error = new Error(`Herdr socket unavailable at ${socketPath}: ${result.reason}`);
    error.code = 'HERDR_SOCKET_UNAVAILABLE';
    error.details = result;
    throw error;
  }
  return result;
}

module.exports = {
  defaultSocketPath,
  resolveSocketPath,
  inspectSocket,
  assertSocket,
};
