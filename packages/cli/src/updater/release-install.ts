// Installing a GitHub release without npm.
//
// A release tarball carries all of herdr-remote's JavaScript, the relay
// included, bundled; the only dependency npm resolves is node-pty, which is
// native. So while a release asks for the same node-pty this install already
// has, updating is: download the tarball, unpack it beside this package, carry
// the installed node-pty over, and swap the directories. No registry, no
// dependency resolution, and seconds instead of a minute.
//
// When the dependencies or the commands differ, a swap would leave something
// missing, and npm has to install the release instead; that is reported as
// `needsNpm` rather than attempted.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PACKAGE_ROOT } from '../paths.js';
import { replaceTree } from './in-place.js';
import { extractPackage } from './tarball.js';

const HELD_DIRECTORY_CODES = ['EBUSY', 'EPERM', 'EACCES'];

export type DownloadLike = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ ok: boolean; status?: number; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface ReleaseInstall {
  ok: boolean;
  output: string;
  /** The release needs dependencies or commands only npm can set up. */
  needsNpm?: boolean;
}

interface Manifest {
  name?: string;
  version?: string;
  bin?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  bundleDependencies?: string[];
}

function readManifest(directory: string): Manifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Dependencies npm installs for a release, as opposed to the ones it carries. */
function installedDependencies(manifest: Manifest): [string, string][] {
  const bundled = new Set(manifest.bundleDependencies ?? []);
  return Object.entries(manifest.dependencies ?? {}).filter(([name]) => !bundled.has(name));
}

/**
 * Whether the release can run on the dependencies installed for this one:
 * each one it asks npm for is asked for identically here and resolves.
 */
function dependenciesMatch(current: Manifest, next: Manifest, target: string): boolean {
  if (JSON.stringify(current.bin) !== JSON.stringify(next.bin)) return false;
  const resolve = createRequire(path.join(target, 'package.json')).resolve;
  return installedDependencies(next).every(([name, range]) => {
    if (current.dependencies?.[name] !== range) return false;
    try {
      resolve(`${name}/package.json`);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * The directories under `target/node_modules` the release still needs: its
 * installed dependencies and everything they depend on that npm nested there.
 * Dependencies hoisted above `target` stay where they are.
 */
function carriedModules(next: Manifest, target: string): string[] {
  const carried: string[] = [];
  const queue = installedDependencies(next).map(([name]) => name);
  while (queue.length > 0) {
    const name = queue.shift() as string;
    const directory = path.join(target, 'node_modules', name);
    if (carried.includes(name) || !fs.existsSync(directory)) continue;
    carried.push(name);
    const manifest = readManifest(directory);
    queue.push(...Object.keys({ ...manifest?.dependencies, ...manifest?.optionalDependencies }));
  }
  return carried;
}

async function download(url: string, fetchImpl: DownloadLike, timeoutMs: number): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: 'application/octet-stream' },
    });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status ?? '?'}`);
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new Error(`${url}: timed out`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function moveModules(names: string[], from: string, to: string): void {
  for (const name of names) {
    const destination = path.join(to, 'node_modules', name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(path.join(from, 'node_modules', name), destination);
  }
}

/**
 * Put the unpacked release at `stage` in place of `target`.
 *
 * Renaming whole directories means no process ever sees half a release. On
 * Windows a directory something works in cannot be renamed; its files can
 * still be replaced, so the release is copied over it instead, keeping the
 * carried dependencies.
 */
function swap(stage: string, target: string, carried: string[], platform: NodeJS.Platform): void {
  const previous = `${target}.previous-${process.pid}`;
  try {
    fs.renameSync(target, previous);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (platform !== 'win32' || !HELD_DIRECTORY_CODES.includes(code)) throw error;
    const keep = new Set(carried.map((name) => path.join(target, 'node_modules', name)));
    replaceTree(stage, target, fs.copyFileSync, keep);
    return;
  }
  try {
    moveModules(carried, previous, stage);
    fs.renameSync(stage, target);
  } catch (error) {
    // Put the old release back as it was: everything above happened on one
    // file system, so each step can be undone by renaming.
    try {
      for (const name of carried) {
        if (fs.existsSync(path.join(stage, 'node_modules', name)))
          moveModules([name], stage, previous);
      }
      fs.renameSync(previous, target);
    } catch {
      // The original error is the one worth reporting; the rename above names
      // where the old release was left if this fails too.
    }
    throw error;
  }
  try {
    fs.rmSync(previous, { recursive: true, force: true });
  } catch {
    // Still held by a running process; it holds nothing the new release needs.
  }
}

/**
 * Download the release tarball at `url` and install it over `target`.
 * Never throws: failures come back as `{ ok: false, output }`.
 */
export async function installRelease({
  url,
  version,
  target = PACKAGE_ROOT,
  fetchImpl = globalThis.fetch as unknown as DownloadLike,
  timeoutMs = 180_000,
  platform = process.platform,
}: {
  url: string;
  version: string | null;
  target?: string;
  fetchImpl?: DownloadLike;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}): Promise<ReleaseInstall> {
  // Beside the package, so the final rename stays on one file system.
  const stage = path.join(path.dirname(target), `.herdr-remote-update-${process.pid}`);
  try {
    fs.rmSync(stage, { recursive: true, force: true });
    extractPackage(await download(url, fetchImpl, timeoutMs), stage);
    const next = readManifest(stage);
    const current = readManifest(target);
    if (next?.name !== 'herdr-remote' || (version && next.version !== version)) {
      return { ok: false, output: `${url} is not herdr-remote ${version ?? ''}`.trim() };
    }
    if (!current || !dependenciesMatch(current, next, target)) {
      return { ok: false, needsNpm: true, output: 'the release changes installed dependencies' };
    }
    swap(stage, target, carriedModules(next, target), platform);
    return { ok: true, output: `installed ${next.version} from ${url}` };
  } catch (error) {
    return { ok: false, output: String((error as Error)?.message || error) };
  } finally {
    try {
      fs.rmSync(stage, { recursive: true, force: true });
    } catch {
      // A leftover stage is removed before the next update unpacks into it.
    }
  }
}
