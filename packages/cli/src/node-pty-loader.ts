// Where node-pty is loaded from.
//
// npm updates this package by renaming its directory and deleting the old one,
// and Windows refuses both while a process has a file in it loaded: node-pty's
// .node modules, or the OpenConsole.exe that ConPTY starts from beside them.
// The host connector and the admin broker hold those for as long as they run,
// so on Windows node-pty is loaded from a copy in the state directory, one per
// build. Copies are never deleted: a process of an older release may still
// have one loaded, and a build is a few megabytes.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { stateDir } from './paths.js';

type NodePty = typeof import('node-pty');

const require = createRequire(import.meta.url);

/** What node-pty loads or starts; debug symbols are most of the prebuilds' size. */
const BINARY_EXTENSIONS = ['.node', '.dll', '.exe'];

/** The files a running node-pty needs, relative to its package directory. */
function runtimeFiles(source: string, platform: string, arch: string): string[] {
  const files = ['package.json'];
  const collect = (directory: string, keep: (name: string) => boolean) => {
    const absolute = path.join(source, directory);
    if (!fs.existsSync(absolute)) return;
    for (const entry of fs.readdirSync(absolute, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && keep(entry.name))
        files.push(path.relative(source, path.join(entry.parentPath, entry.name)));
    }
  };
  collect('lib', (name) => name.endsWith('.js') && !name.endsWith('.test.js'));
  const binary = (name: string) => BINARY_EXTENSIONS.includes(path.extname(name));
  // Where node-pty looks for its modules: a local build, then the prebuilds.
  collect(path.join('build', 'Release'), binary);
  collect(path.join('prebuilds', `${platform}-${arch}`), binary);
  return files;
}

/** Copy node-pty's run-time files under `directory`, once per build; returns the copy. */
export function copyNodePty(
  source: string,
  directory: string,
  platform: string,
  arch: string,
): string {
  const files = runtimeFiles(source, platform, arch);
  const hash = createHash('sha256');
  for (const file of files)
    hash.update(`${file}\0`).update(fs.readFileSync(path.join(source, file)));
  const target = path.join(directory, hash.digest('hex').slice(0, 16));
  if (fs.existsSync(target)) return target;

  // Renamed into place whole, so a copy that exists is complete.
  const staging = `${target}.${process.pid}.tmp`;
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(staging, file)), { recursive: true });
    fs.copyFileSync(path.join(source, file), path.join(staging, file));
  }
  try {
    fs.renameSync(staging, target);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    // Another process put the same build in place first.
    if (!fs.existsSync(target)) throw error;
  }
  return target;
}

export function loadNodePty({
  platform = process.platform,
  arch = process.arch,
  source = path.dirname(require.resolve('node-pty/package.json')),
  directory = path.join(stateDir(), 'node-pty'),
  warn = (message: string) => process.stderr.write(`${message}\n`),
}: {
  platform?: string;
  arch?: string;
  source?: string;
  directory?: string;
  warn?: (message: string) => void;
} = {}): NodePty {
  if (platform !== 'win32') return require(source);
  try {
    return require(copyNodePty(source, directory, platform, arch));
  } catch (error) {
    // Terminals still work from the package; only an update has to wait for them to end.
    warn(`herdr-remote: could not copy node-pty out of the package: ${(error as Error).message}`);
    return require(source);
  }
}

let loaded: NodePty | null = null;

/** node-pty, loaded on first use: only processes that start terminals pay for it. */
export function nodePty(): NodePty {
  loaded ??= loadNodePty();
  return loaded;
}
