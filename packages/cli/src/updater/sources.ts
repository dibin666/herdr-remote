// Where an update check looks: the manifest on the newest GitHub Release
// first, npm registries only when GitHub cannot be reached.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PACKAGE_NAME = 'herdr-remote';
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/**
 * A public mirror, tried last.
 *
 * `registry.npmjs.org` is not reachable from every network this runs on — in
 * mainland China it usually is not — and "could not reach npm registry" on a
 * machine that installs packages perfectly well is a bug report, not a
 * diagnosis. The mirror is read-only and only ever asked for a version number.
 */
export const MIRROR_REGISTRY = 'https://registry.npmmirror.com';

export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;

export function normalizeRegistry(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

/** The `registry=` line from an npmrc file, if it has one. */
function registryFromNpmrc(filePath: string): string | null {
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let found = null;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const match = /^registry\s*=\s*(.+)$/i.exec(line);
    // The last assignment wins, as it does for npm itself.
    if (match) found = normalizeRegistry(match[1].replace(/^["']|["']$/g, ''));
  }
  return found;
}

/**
 * Where to ask, in the order to ask.
 *
 * Whatever npm itself is configured to use comes first: a machine behind a
 * corporate proxy or on a mirror has already answered this question, and
 * ignoring that answer is what made the check fail on a machine where
 * `npm install` works. The public registry and then a public mirror follow, so
 * a private registry that does not carry this package is not the end of it.
 */
export function registryCandidates({
  env = process.env,
  home = os.homedir(),
  cwd = process.cwd(),
}: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  cwd?: string;
} = {}): string[] {
  const candidates: string[] = [];
  const add = (value: unknown) => {
    const normalized = normalizeRegistry(value);
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };

  // npm exports its whole config into the environment of anything it runs.
  add(env.npm_config_registry);
  add(env.NPM_CONFIG_REGISTRY);
  add(env.HERDR_REMOTE_REGISTRY);
  add(registryFromNpmrc(path.join(cwd, '.npmrc')));
  add(registryFromNpmrc(path.join(home, '.npmrc')));
  add(DEFAULT_REGISTRY);
  add(MIRROR_REGISTRY);
  return candidates;
}

/** One JSON request with a deadline. Never throws. */
async function fetchJson(
  url: string,
  { timeoutMs, fetchImpl }: { timeoutMs: number; fetchImpl: FetchLike },
): Promise<{ ok: true; body: unknown } | { ok: false; message: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    });
    if (!response.ok) return { ok: false, message: `HTTP ${response.status ?? '?'}` };
    return { ok: true, body: await response.json() };
  } catch (error) {
    const failure = error as Error | undefined;
    return {
      ok: false,
      message: failure?.name === 'AbortError' ? 'timed out' : String(failure?.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One registry, one question: what is the latest published version?
 *
 * The dist-tags endpoint first: a few bytes, answered fresh by npmjs and
 * npmmirror alike. `/<package>/latest` is the fallback for registries without
 * it, asked for plain JSON. It used to be asked for npm's abbreviated install
 * format, which npmjs refuses on that path with a 406, so every check quietly
 * fell through to a mirror that had not synced the release yet.
 */
export async function askRegistry(
  registry: string,
  { timeoutMs, fetchImpl }: { timeoutMs: number; fetchImpl: FetchLike },
): Promise<{ ok: true; latest: string } | { ok: false; message: string | null }> {
  type Body = { latest?: unknown; version?: unknown } | null | undefined;
  const endpoints = [
    {
      url: `${registry}/-/package/${PACKAGE_NAME}/dist-tags`,
      read: (body: unknown) => (body as Body)?.latest,
    },
    { url: `${registry}/${PACKAGE_NAME}/latest`, read: (body: unknown) => (body as Body)?.version },
  ];
  let message: string | null = null;
  for (const endpoint of endpoints) {
    const attempt = await fetchJson(endpoint.url, { timeoutMs, fetchImpl });
    if (!attempt.ok) {
      message = attempt.message;
      continue;
    }
    const latest = endpoint.read(attempt.body);
    if (typeof latest === 'string' && latest) return { ok: true, latest };
    message = 'registry answered without a version';
  }
  return { ok: false, message };
}

export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The newest GitHub Release, from the manifest every release carries. */
export async function askGithubReleases(
  manifestUrl: string,
  { timeoutMs, fetchImpl }: { timeoutMs: number; fetchImpl: FetchLike },
): Promise<{ ok: true; latest: string } | { ok: false; message: string | null }> {
  const attempt = await fetchJson(manifestUrl, { timeoutMs, fetchImpl });
  if (!attempt.ok) return attempt;
  const version = (attempt.body as { version?: unknown } | null)?.version;
  if (typeof version === 'string' && VERSION_PATTERN.test(version)) {
    return { ok: true, latest: version };
  }
  return { ok: false, message: 'release manifest has no version' };
}
