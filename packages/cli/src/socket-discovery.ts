import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function defaultSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'herdr', 'herdr.sock');
  }
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'herdr', 'herdr.sock');
}

function resolveSocketPath(
  configuredPath: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return configuredPath || env.HERDR_SOCKET_PATH || defaultSocketPath(env);
}

interface SocketInspection {
  ok: boolean;
  path: unknown;
  reason?: string;
  missing?: boolean;
  uid?: number;
  mode?: number;
}

function inspectSocket(
  socketPath: unknown,
  options: { requireOwner?: boolean } = {},
): SocketInspection {
  if (typeof socketPath !== 'string' || socketPath.length === 0) {
    return { ok: false, reason: 'socket path is empty', path: socketPath };
  }
  try {
    const stat = fs.statSync(socketPath);
    if (process.platform !== 'win32' && !stat.isSocket()) {
      return { ok: false, reason: 'path is not a Unix socket', path: socketPath };
    }
    if (
      options.requireOwner !== false &&
      typeof process.getuid === 'function' &&
      stat.uid !== process.getuid()
    ) {
      return {
        ok: false,
        reason: 'socket is not owned by the current user',
        path: socketPath,
        uid: stat.uid,
      };
    }
    return { ok: true, path: socketPath, uid: stat.uid, mode: stat.mode };
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException;
    return {
      ok: false,
      missing: code === 'ENOENT',
      reason: code === 'ENOENT' ? 'socket does not exist' : message,
      path: socketPath,
    };
  }
}

export { defaultSocketPath, resolveSocketPath, inspectSocket };
