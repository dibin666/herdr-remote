// Installing a release when npm cannot replace this one on Windows.
//
// npm replaces a global package by renaming its directory, and Windows refuses
// while any process works in that directory or runs a file from it: a shell or
// editor left there, a program an older release started. Nobody can find and
// stop them all. The files inside can still be replaced, so npm installs the
// release into a staging prefix and it is copied over this one file by file.

import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT, stateDir } from '../paths.js';
import type { NpmRun } from './npm.js';

const HELD_FILE_CODES = ['EBUSY', 'EPERM', 'EACCES'];

type CopyFile = (source: string, target: string) => void;

/** npm could not rename the package directory because something holds it. */
export function heldByAnotherProcess(npmOutput: string | undefined): boolean {
  return /\b(EBUSY|EPERM)\b/.test(npmOutput ?? '');
}

function replaceFile(source: string, target: string, copyFile: CopyFile): void {
  try {
    copyFile(source, target);
  } catch (error) {
    if (!HELD_FILE_CODES.includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    // A running program or a loaded module cannot be overwritten, but it can be renamed.
    fs.renameSync(target, `${target}.${process.pid}.old`);
    copyFile(source, target);
  }
}

/** Make `target` hold what `source` holds, without renaming any directory. */
export function replaceTree(
  source: string,
  target: string,
  copyFile: CopyFile = fs.copyFileSync,
): void {
  fs.mkdirSync(target, { recursive: true });
  // Lowercase because Windows reads names that differ only in case as one file.
  const kept = new Set<string>();
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    kept.add(entry.name.toLowerCase());
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const existing = fs.lstatSync(to, { throwIfNoEntry: false });
    if (existing && existing.isDirectory() !== entry.isDirectory())
      fs.rmSync(to, { recursive: true, force: true });
    if (entry.isDirectory()) replaceTree(from, to, copyFile);
    else replaceFile(from, to, copyFile);
  }
  for (const name of fs.readdirSync(target)) {
    if (kept.has(name.toLowerCase())) continue;
    try {
      fs.rmSync(path.join(target, name), { recursive: true, force: true });
    } catch {
      // Still held, like a file renamed aside above; the next update removes it.
    }
  }
}

/** Run the failed `npm install -g` again into a staging prefix, then copy the result over `target`. */
export async function installInPlace(
  args: string[],
  run: (args: string[]) => Promise<NpmRun>,
  {
    target = PACKAGE_ROOT,
    stage = path.join(stateDir(), 'update-stage'),
    platform = process.platform,
  }: { target?: string; stage?: string; platform?: NodeJS.Platform } = {},
): Promise<NpmRun> {
  fs.rmSync(stage, { recursive: true, force: true });
  try {
    const result = await run([...args, '--prefix', stage]);
    if (!result.ok) return result;
    // npm's global layout under a prefix.
    const modules =
      platform === 'win32'
        ? path.join(stage, 'node_modules')
        : path.join(stage, 'lib', 'node_modules');
    try {
      replaceTree(path.join(modules, path.basename(target)), target);
    } catch (error) {
      return { ok: false, output: `${result.output}\n${(error as Error).message}` };
    }
    return result;
  } finally {
    try {
      fs.rmSync(stage, { recursive: true, force: true });
    } catch {
      // A stage left behind is emptied before the next one is used.
    }
  }
}
