// Updating the relay a local or LAN workstation runs, on its own.
//
// The relay is a package of its own that herdr-remote installs. A release of
// the relay alone leaves herdr-remote's version where it was, so the update
// check for herdr-remote says "up to date" while the relay on disk falls
// behind. This checks the relay by itself, and installs the newest relay that
// this herdr-remote's dependency range allows.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PACKAGE_ROOT } from './paths.js';
import {
  checkForUpdate,
  compareVersions,
  currentVersion,
  performUpdate,
  type UpdateCheck,
} from './updater.js';

const RELAY_PACKAGE = 'herdr-remote-relay';

export interface RelayUpdateCheck extends UpdateCheck {
  /** The newest relay needs a newer herdr-remote: its update brings it. */
  needsNewerCli?: boolean;
}

/** The relay installed under this herdr-remote, read from disk: an update moves it. */
export function installedRelayVersion(): string | null {
  try {
    const manifest = createRequire(import.meta.url).resolve(`${RELAY_PACKAGE}/package.json`);
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
  } catch {
    return null;
  }
}

/** The relay versions this herdr-remote declares it works with, e.g. `^0.3.9`. */
function relayRange(): string | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    return manifest.dependencies?.[RELAY_PACKAGE] ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether `version` is inside a caret range, the only kind herdr-remote
 * declares. Below 1.0 a caret holds the minor version (`^0.3.9` is `0.3.x`
 * from `0.3.9`), which is exactly the line a relay must not cross alone.
 */
export function withinCaretRange(version: string, range: string): boolean {
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  if (!match) return false;
  const floor = `${match[1]}.${match[2]}.${match[3]}`;
  const [major, minor] = version.split('.').map((part) => Number.parseInt(part, 10));
  const [floorMajor, floorMinor] = [Number(match[1]), Number(match[2])];
  if (compareVersions(version, floor) < 0 || major !== floorMajor) return false;
  return floorMajor > 0 || minor === floorMinor;
}

/** Whether a newer relay than the installed one is out, and whether this herdr-remote can take it. */
export async function checkForRelayUpdate(
  options: Omit<Parameters<typeof checkForUpdate>[0] & object, 'packageName' | 'current'> = {},
): Promise<RelayUpdateCheck> {
  const installed = installedRelayVersion();
  const result = await checkForUpdate({
    ...options,
    packageName: RELAY_PACKAGE,
    current: installed ?? '0.0.0',
  });
  if (!result.ok || !result.updateAvailable || !result.latest) return result;
  const range = relayRange();
  if (range && !withinCaretRange(result.latest, range)) {
    return { ...result, updateAvailable: false, needsNewerCli: true };
  }
  return result;
}

/**
 * Install the newest relay this herdr-remote allows: the same herdr-remote,
 * reinstalled, which npm resolves afresh, relay included. The installed
 * herdr-remote does not change, and neither does anything it was tested with
 * but the relay. Success is the relay on disk, not npm's exit code.
 */
export async function performRelayUpdate({
  relayVersion,
  readRelayVersion = installedRelayVersion,
  ...options
}: Omit<NonNullable<Parameters<typeof performUpdate>[0]>, 'version'> & {
  relayVersion: string;
  readRelayVersion?: () => string | null;
}): Promise<Awaited<ReturnType<typeof performUpdate>>> {
  const result = await performUpdate({ ...options, version: currentVersion() });
  if (!result.ok) return result;
  const installed = readRelayVersion();
  if (!installed || compareVersions(installed, relayVersion) < 0) {
    return { ok: false, errorKey: 'relayUpdate.errorNotApplied', installed, output: result.output };
  }
  return { ...result, installed };
}
