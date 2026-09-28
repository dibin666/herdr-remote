// runtime.json: this workstation's relay credentials, the processes started
// for it, and facts other modules remember there (terminal palette and font).
// Every read and write of that file goes through here.

import { ensureDir, randomToken, readJson, writeJsonAtomic } from 'herdr-remote-relay/state';
import { processStart, stillRunning } from './lib/process.js';
import { configDir, runtimeStatePath, stateDir } from './paths.js';

const RUNTIME_VERSION = 2;

interface ManagedPid {
  name: string;
  pid: number;
  /** Tells this process apart from any later one given the same pid; see `processStarts`. */
  processStart: string;
  startedAt: string;
}

export interface RuntimeState {
  version: number;
  hostId: string;
  hostToken: string;
  relayPassword?: string;
  mode?: string;
  relayPid?: number | null;
  hostPid?: number | null;
  supervisorPid?: number | null;
  startedAt?: string | null;
  managedPids?: ManagedPid[];
  terminalPalette?: unknown;
  terminalFont?: unknown;
}

export function readRuntime(): Partial<RuntimeState> {
  const state = readJson<unknown>(runtimeStatePath(), {});
  return state && typeof state === 'object' ? (state as Partial<RuntimeState>) : {};
}

export function writeRuntime(state: Partial<RuntimeState>): void {
  writeJsonAtomic(runtimeStatePath(), state);
}

/** Read, change and write back in one step, so no field another writer set is lost. */
export function updateRuntime(
  change: (state: Partial<RuntimeState>) => void,
): Partial<RuntimeState> {
  const state = readRuntime();
  change(state);
  writeRuntime(state);
  return state;
}

/**
 * Load (creating if needed) the long-lived identifiers and secrets this
 * workstation uses. These live in the state directory rather than config.json
 * because they are credentials: writeJsonAtomic stores them mode 0600.
 */
export function ensureRuntime(): RuntimeState {
  ensureDir(configDir());
  ensureDir(stateDir());
  return updateRuntime((state) => {
    if (!state.version) state.version = RUNTIME_VERSION;
    if (!state.hostId) state.hostId = `host-${randomToken(9)}`;
    if (!state.hostToken) state.hostToken = randomToken(32);
  }) as RuntimeState;
}

/**
 * Set the password used to join a relay. An empty value means "no password",
 * which is what a public relay expects.
 *
 * It lives in the state file rather than config.json because it is a secret:
 * writeJsonAtomic stores that file mode 0600.
 */
export function setRelayPassword(password: unknown): RuntimeState {
  const state = ensureRuntime();
  state.relayPassword = typeof password === 'string' ? password.trim() : '';
  writeRuntime(state);
  return state;
}

/**
 * Issue this workstation a new identity on the relay.
 *
 * The host token is what proves ownership of this workstation, so replacing it
 * means the relay no longer recognises the old one — useful if it leaked, but
 * it also orphans the previous record on a relay that already enrolled it.
 */
export function regenerateHostIdentity(): RuntimeState {
  const state = ensureRuntime();
  state.hostId = `host-${randomToken(9)}`;
  state.hostToken = randomToken(32);
  writeRuntime(state);
  return state;
}

/**
 * Remember a process we started, in a list that survives being overwritten.
 *
 * `relayPid`/`hostPid` alone were not enough: the supervisor rewrote them with
 * its own children, which orphaned anything an earlier detached start had
 * spawned. Those orphans kept the port and the host session, so the relay could
 * never bind and "stop" had nothing left to kill. The ledger is append-only
 * (minus dead entries) precisely so no writer can lose another writer's pids.
 */
export function recordManagedPid(
  state: Partial<RuntimeState>,
  name: string,
  pid: unknown,
): Partial<RuntimeState> {
  const existing = Array.isArray(state.managedPids) ? state.managedPids.filter(Boolean) : [];
  const kept = stillRunning(existing.filter((entry) => entry.pid !== pid));
  // Only track something that is actually running, and together with its start
  // token: the ledger outlives a reboot, and a bare pid it kept would then name
  // whichever unrelated process got that number next — which we would signal.
  const start = Number.isInteger(pid) ? processStart(pid as number) : null;
  if (start) {
    kept.push({
      name,
      pid: pid as number,
      processStart: start,
      startedAt: new Date().toISOString(),
    });
  }
  state.managedPids = kept;
  return state;
}

/**
 * Every process we started that is still running, and still that process.
 *
 * Only the ledger counts. `supervisorPid`, `relayPid` and `hostPid` are bare
 * numbers that survive a reboot, and trusting them would signal whichever
 * unrelated process inherited one.
 */
export function managedPids(state = readRuntime()): ManagedPid[] {
  const unique = new Map<number, ManagedPid>();
  for (const entry of state.managedPids || []) {
    if (entry && !unique.has(entry.pid)) unique.set(entry.pid, entry);
  }
  return stillRunning([...unique.values()]);
}
