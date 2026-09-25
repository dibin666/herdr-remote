// runtime.json: this workstation's relay credentials, the processes started
// for it, and facts other modules remember there (terminal palette and font).
// Every read and write of that file goes through here.

import { ensureDir, randomToken, readJson, writeJsonAtomic } from 'herdr-remote-relay/state';
import { pidAlive } from './lib/process.js';
import { configDir, runtimeStatePath, stateDir } from './paths.js';

export const RUNTIME_VERSION = 2;

export interface ManagedPid {
  name: string;
  pid: number;
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
  const existing = Array.isArray(state.managedPids) ? state.managedPids : [];
  const kept = existing.filter((entry) => entry && entry.pid !== pid && pidAlive(entry.pid));
  // Only track something that is actually running: a pid that already exited
  // would sit in the ledger until its number is recycled by an unrelated
  // process, which we would then happily signal.
  if (Number.isInteger(pid) && pidAlive(pid)) {
    kept.push({ name, pid: pid as number, startedAt: new Date().toISOString() });
  }
  state.managedPids = kept;
  return state;
}

/** Every process we believe we started, alive right now. */
export function managedPids(state = readRuntime()): { pid: number; name: string }[] {
  const pids = new Map<number, string>();
  // Supervisor first and never overwritten: `stopServices` relies on the order
  // to signal it before its children, and one pid can appear under several
  // fields.
  for (const [name, pid] of [
    ['supervisor', state.supervisorPid],
    ['host', state.hostPid],
    ['relay', state.relayPid],
  ] as const) {
    if (pidAlive(pid) && !pids.has(pid as number)) pids.set(pid as number, name);
  }
  for (const entry of state.managedPids || []) {
    if (entry && pidAlive(entry.pid) && !pids.has(entry.pid)) pids.set(entry.pid, entry.name);
  }
  return [...pids].map(([pid, name]) => ({ pid, name }));
}
