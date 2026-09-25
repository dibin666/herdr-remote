// Editable settings, independent of how they are rendered.
//
// The TUI holds a *draft* copy of the config, mutates it through these pure
// functions and writes it out on save. Keeping the rules here (rather than in
// the view) means they can be tested without a terminal, and the same
// validation applies to the first-run wizard and the settings screen.

import {
  ACCESS_MODES,
  type AccessMode,
  type Config,
  KEEPALIVE_MANAGERS,
  LANGUAGES,
  OFFICIAL_RELAY_URL,
  loadConfig,
} from './config.js';
import { configDir, configPath } from './paths.js';
import {
  isLoopbackHost,
  isUnspecifiedAddress,
  isUnspecifiedHost,
  resolvePublicUrl,
} from './relay-urls.js';
import { ensureDir, readJson, writeJsonAtomic } from 'herdr-remote-relay/state';
import { preferredLanAddress } from './net-interfaces.js';

export type FieldId =
  | 'mode'
  | 'port'
  | 'lanHost'
  | 'remoteUrl'
  | 'publicUrl'
  | 'socketPath'
  | 'herdrArgs'
  | 'herdrAutoStart'
  | 'language'
  | 'keepaliveManager';

export interface FieldSpec {
  id: FieldId;
  kind: 'choice' | 'text' | 'address' | 'toggle';
  labelKey: string;
  choices?: readonly string[];
  visibleFor?: readonly AccessMode[];
}

/** What `setField` did: the new draft, or the old one and why. */
export interface FieldEdit {
  draft: Config;
  errorKey: string | null;
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return (list as readonly unknown[]).includes(value);
}

/**
 * Field metadata. `kind` drives the editor the TUI shows; `visibleFor` limits a
 * field to the access modes where it means anything.
 */
const FIELDS: FieldSpec[] = [
  { id: 'mode', kind: 'choice', choices: ACCESS_MODES, labelKey: 'field.mode' },
  { id: 'port', kind: 'text', labelKey: 'field.port', visibleFor: ['local', 'lan'] },
  { id: 'lanHost', kind: 'address', labelKey: 'field.lanHost', visibleFor: ['lan'] },
  { id: 'remoteUrl', kind: 'text', labelKey: 'field.remoteUrl', visibleFor: ['remote'] },
  { id: 'publicUrl', kind: 'text', labelKey: 'field.publicUrl' },
  { id: 'socketPath', kind: 'text', labelKey: 'field.socketPath' },
  { id: 'herdrArgs', kind: 'text', labelKey: 'field.herdrArgs' },
  { id: 'herdrAutoStart', kind: 'toggle', labelKey: 'field.herdrAutoStart' },
  { id: 'language', kind: 'choice', choices: LANGUAGES, labelKey: 'field.language' },
  {
    id: 'keepaliveManager',
    kind: 'choice',
    choices: KEEPALIVE_MANAGERS,
    labelKey: 'field.keepalive',
  },
];

const EMPTY = '';

/**
 * The access modes a *person* chooses between.
 *
 * The official relay is stored as `remote` with a known URL, because that is
 * exactly what it is and nothing downstream should have to learn a fourth mode.
 * It is still a separate answer to "how do I reach this workstation", though:
 * one option needs no server and no credentials, the other needs both. Keeping
 * that distinction here — rather than in whichever screen happens to draw it —
 * is what stops the official relay from being displayed as "self-hosted relay"
 * that merely happens to hold our address.
 */
const SELECTABLE_MODES = ['local', 'lan', 'official', 'remote'] as const;
export type SelectableMode = (typeof SELECTABLE_MODES)[number];

/** Which of `SELECTABLE_MODES` this draft represents. */
function selectedMode(draft: Config): SelectableMode {
  if (draft.relay.mode === 'remote' && draft.relay.remoteUrl === OFFICIAL_RELAY_URL)
    return 'official';
  return draft.relay.mode;
}

/** True when the relay is the one we run, so its address and password are ours. */
function isOfficialRelay(draft: Config): boolean {
  return selectedMode(draft) === 'official';
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function createDraft(config: Config = loadConfig()): Config {
  return clone(config);
}

function fieldsForMode(mode: AccessMode): FieldSpec[] {
  return FIELDS.filter((field) => !field.visibleFor || field.visibleFor.includes(mode));
}

/** Current value of a field as an editable string. */
function getField(draft: Config, id: string): string {
  switch (id) {
    case 'mode':
      return draft.relay.mode;
    case 'port':
      return String(draft.relay.port);
    case 'lanHost':
      return draft.relay.lanHost || EMPTY;
    case 'remoteUrl':
      return draft.relay.remoteUrl || EMPTY;
    case 'publicUrl':
      return draft.relay.publicUrl || EMPTY;
    case 'socketPath':
      return draft.herdr.socketPath || EMPTY;
    case 'herdrArgs':
      return (draft.herdr.args || []).join(' ');
    case 'herdrAutoStart':
      return draft.herdr.autoStart ? 'on' : 'off';
    case 'language':
      return draft.ui.language;
    case 'keepaliveManager':
      return draft.keepalive.manager;
    default:
      return EMPTY;
  }
}

/**
 * What the field shows when it is empty: the value that will actually be used.
 * Displaying the derived value beats an empty box the user cannot interpret.
 */
function getFieldPlaceholder(draft: Config, id: string): string {
  switch (id) {
    case 'lanHost':
      return preferredLanAddress() || '0.0.0.0';
    case 'publicUrl':
      return resolvePublicUrl(draft, preferredLanAddress());
    case 'socketPath':
      return 'placeholder.autoDiscovered';
    case 'herdrArgs':
      return 'placeholder.none';
    case 'remoteUrl':
      return 'wss://relay.example.com';
    default:
      return EMPTY;
  }
}

function isValidUrl(value: string, protocols: string[]): boolean {
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol);
  } catch {
    return false;
  }
}

/**
 * Apply a value to a copy of the draft.
 *
 * Returns `{ draft, errorKey }`. On a validation failure the draft comes back
 * unchanged and `errorKey` names a translatable message, so callers never have
 * to guess whether the edit landed.
 */
function setField(draft: Config, id: string, rawValue: string | boolean): FieldEdit {
  const next = clone(draft);
  const value = typeof rawValue === 'string' ? rawValue.trim() : rawValue;
  // Every field but the toggle is edited as text.
  const text = value as string;

  switch (id) {
    case 'mode': {
      if (!isOneOf(SELECTABLE_MODES, value)) return { draft, errorKey: 'error.invalidMode' };
      // Picking the official relay fills in its address in the same edit: a
      // remote mode with no URL is not a valid state, and asking for the
      // address we already know would be asking the user to do our filing.
      if (value === 'official') {
        next.relay.mode = 'remote';
        next.relay.remoteUrl = OFFICIAL_RELAY_URL;
        next.relay.publicUrl = EMPTY;
        break;
      }
      // Leaving the official relay clears its address, so the self-hosted URL
      // field is empty and asking to be filled in rather than pre-loaded with
      // an address that belongs to somebody else's server.
      if (value === 'remote' && next.relay.remoteUrl === OFFICIAL_RELAY_URL) {
        next.relay.remoteUrl = EMPTY;
      }
      next.relay.mode = value;
      if (
        value === 'lan' &&
        (isLoopbackHost(next.relay.lanHost) || isUnspecifiedAddress(next.relay.lanHost))
      ) {
        next.relay.lanHost = EMPTY;
      }
      // A public URL pinned for one mode is wrong for the next one; clearing it
      // lets derivation produce the right address again.
      next.relay.publicUrl = EMPTY;
      break;
    }
    case 'port': {
      const port = Number.parseInt(text, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        return { draft, errorKey: 'error.invalidPort' };
      next.relay.port = port;
      break;
    }
    case 'lanHost': {
      if (text && (isLoopbackHost(text) || isUnspecifiedAddress(text))) {
        return { draft, errorKey: 'error.invalidLanHost' };
      }
      next.relay.lanHost = text || EMPTY;
      break;
    }
    case 'remoteUrl': {
      if (text && !isValidUrl(text, ['ws:', 'wss:', 'http:', 'https:'])) {
        return { draft, errorKey: 'error.invalidRelayUrl' };
      }
      next.relay.remoteUrl = text.replace(/\/+$/, '');
      break;
    }
    case 'publicUrl': {
      if (text && (!isValidUrl(text, ['http:', 'https:']) || isUnspecifiedHost(text))) {
        return { draft, errorKey: 'error.invalidPublicUrl' };
      }
      next.relay.publicUrl = text.replace(/\/+$/, '');
      break;
    }
    case 'socketPath': {
      next.herdr.socketPath = text || null;
      break;
    }
    case 'herdrArgs': {
      const args = text ? text.split(/\s+/).filter(Boolean) : [];
      if (args.includes('--no-session')) {
        return { draft, errorKey: 'error.removedHerdrArg' };
      }
      next.herdr.args = args;
      break;
    }
    case 'herdrAutoStart': {
      if (value !== true && value !== false && value !== 'on' && value !== 'off') {
        return { draft, errorKey: 'error.unknownField' };
      }
      next.herdr.autoStart = value === true || value === 'on';
      break;
    }
    case 'language': {
      if (!isOneOf(LANGUAGES, value)) return { draft, errorKey: 'error.invalidLanguage' };
      next.ui.language = value;
      break;
    }
    case 'keepaliveManager': {
      if (!isOneOf(KEEPALIVE_MANAGERS, value)) return { draft, errorKey: 'error.invalidKeepalive' };
      next.keepalive.manager = value;
      break;
    }
    default:
      return { draft, errorKey: 'error.unknownField' };
  }
  return { draft: next, errorKey: null };
}

/** Problems that should block saving, as translatable keys. */
function validateDraft(draft: Config): string[] {
  const problems: string[] = [];
  if (draft.relay.mode === 'remote' && !draft.relay.remoteUrl)
    problems.push('error.remoteUrlRequired');
  return problems;
}

/**
 * Persist a draft, merging into whatever is already on disk so keys this
 * version does not know about survive the round trip.
 */
function saveDraft(draft: Config): { ok: true; path: string } {
  const problems = validateDraft(draft);
  if (problems.length > 0) {
    throw Object.assign(new Error(`configuration is incomplete: ${problems.join(', ')}`), {
      problems,
    });
  }

  type Section = Record<string, unknown>;
  const current = (readJson<Record<string, unknown> | null>(configPath(), {}) || {}) as Record<
    string,
    Section | undefined
  >;
  const merged: Record<string, unknown> = { ...current };
  merged.ui = { ...(current.ui || {}), language: draft.ui.language };
  const relay: Section = {
    ...(current.relay || {}),
    mode: draft.relay.mode,
    port: draft.relay.port,
    lanHost:
      draft.relay.mode === 'lan' &&
      (isLoopbackHost(draft.relay.lanHost) || isUnspecifiedAddress(draft.relay.lanHost))
        ? EMPTY
        : draft.relay.lanHost,
    publicUrl: draft.relay.publicUrl,
    remoteUrl: draft.relay.remoteUrl,
  };
  merged.relay = relay;
  // Fields from the 0.1 schema would otherwise keep overriding the new ones on
  // the next load.
  delete relay.local;
  delete relay.host;
  delete relay.url;
  // The optional Herdr source patch is gone. Nothing reads this section any
  // more, so the next save is where a config written by an older build sheds
  // it rather than carrying stale checksums and paths forever.
  delete merged.patch;
  const herdr: Section = {
    ...(current.herdr || {}),
    socketPath: draft.herdr.socketPath,
    args: draft.herdr.args,
    autoStart: draft.herdr.autoStart === true,
  };
  merged.herdr = herdr;
  if (!herdr.socketPath) delete herdr.socketPath;
  merged.keepalive = { ...(current.keepalive || {}), manager: draft.keepalive.manager };

  ensureDir(configDir());
  writeJsonAtomic(configPath(), merged);
  return { ok: true, path: configPath() };
}

/**
 * Settings that only take effect after the services restart. Used to show a
 * "restart required" hint rather than silently doing nothing.
 */
function requiresRestart(before: Config, after: Config): boolean {
  return (
    before.relay.mode !== after.relay.mode ||
    before.relay.port !== after.relay.port ||
    before.relay.lanHost !== after.relay.lanHost ||
    before.relay.remoteUrl !== after.relay.remoteUrl ||
    before.relay.publicUrl !== after.relay.publicUrl ||
    before.herdr.socketPath !== after.herdr.socketPath ||
    before.herdr.args.join(' ') !== after.herdr.args.join(' ')
  );
}

export {
  FIELDS,
  SELECTABLE_MODES,
  createDraft,
  fieldsForMode,
  isOfficialRelay,
  selectedMode,
  getField,
  getFieldPlaceholder,
  setField,
  validateDraft,
  saveDraft,
  requiresRestart,
};
