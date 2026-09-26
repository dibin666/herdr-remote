import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {
    // Some filesystems (Windows, some mounts) ignore modes; mkdir already asked for 0700.
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(tempPath, 0o600);
  } catch {
    // Some filesystems ignore modes; the file was written with 0600 already.
  }
  fs.renameSync(tempPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Some filesystems ignore modes; the file was written with 0600 already.
  }
}

/** Parsed JSON at `filePath`, or `fallback` when it is missing or unreadable. */
function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException;
    if (code !== 'ENOENT') {
      process.stderr.write(`herdr-remote: invalid state at ${filePath}: ${message}\n`);
    }
    return fallback;
  }
}

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export { ensureDir, writeJsonAtomic, readJson, randomToken };
