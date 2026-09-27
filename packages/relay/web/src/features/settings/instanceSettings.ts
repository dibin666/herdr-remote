// The settings every saved Herdr instance keeps for itself.
//
// A Windows workstation and a Linux one want different key bars and agent
// shortcuts, and a font sized for one screen is wrong on the other, so none of
// these is shared between instances. Each lives in a map keyed by profile id.

import type { StoredSettings } from './storage';

/**
 * Per instance, and per window on top of that: two windows on one instance may
 * still size their text differently. A window keeps its own copy in
 * sessionStorage; localStorage holds the copy a newly opened window starts from.
 */
const VIEW_KEYS = [
  'fontSize',
  'fontSizeFollowsHost',
  'fontFamily',
  'toolbarVisible',
  'toolbarPosition',
  'vibrateOnKeyPress',
  'predictiveEcho',
  'virtualKeys',
  'agentAlertBadge',
  'agentAlertSound',
  'agentAlertVibrate',
  'agentAlertNotify',
] as const satisfies ReadonlyArray<keyof StoredSettings>;

/**
 * Per instance, the same in every window: a rebound agent shortcut is a fact
 * about the workstation's agents, not about one window's view of them.
 */
const SHARED_KEYS = ['agentKeymaps'] as const satisfies ReadonlyArray<keyof StoredSettings>;

type ViewKey = (typeof VIEW_KEYS)[number];
type SharedKey = (typeof SHARED_KEYS)[number];
export type InstanceSettings = Partial<Pick<StoredSettings, ViewKey | SharedKey>>;
export type InstanceSettingsMap = Record<string, InstanceSettings>;

const MAX_INSTANCES = 64;

function pick(source: object, keys: ReadonlyArray<string>): InstanceSettings {
  const record = source as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of keys) if (record[key] !== undefined) output[key] = record[key];
  return output as InstanceSettings;
}

/** The instance settings in `source`: every kind for localStorage, view ones for a window. */
export function pickInstanceSettings(source: object, scope: 'local' | 'session') {
  return pick(source, scope === 'local' ? [...VIEW_KEYS, ...SHARED_KEYS] : VIEW_KEYS);
}

/**
 * A stored map, cut down to the instances still saved and the keys this build
 * knows. Values are cleaned where settings are loaded, as the rest are.
 *
 * `''` holds what a window changed before there was any instance, and is kept
 * until there is one to take it over.
 */
export function readInstanceSettingsMap(
  value: unknown,
  profileIds: string[],
  scope: 'local' | 'session',
): InstanceSettingsMap {
  // No prototype: ids are whatever a stored profile says, `__proto__` included.
  const output: InstanceSettingsMap = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
  for (const [id, settings] of Object.entries(value as Record<string, unknown>).slice(
    0,
    MAX_INSTANCES,
  )) {
    if (id === '' ? profileIds.length > 0 : !profileIds.includes(id)) continue;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) continue;
    output[id] = pickInstanceSettings(settings, scope);
  }
  return output;
}
