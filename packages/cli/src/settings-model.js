'use strict';

// Editable settings, independent of how they are rendered.
//
// The TUI holds a *draft* copy of the config, mutates it through these pure
// functions and writes it out on save. Keeping the rules here (rather than in
// the view) means they can be tested without a terminal, and the same
// validation applies to the first-run wizard and the settings screen.

const {
  ACCESS_MODES,
  KEEPALIVE_MANAGERS,
  LANGUAGES,
  OFFICIAL_RELAY_URL,
  configDir,
  configPath,
  isLoopbackHost,
  isUnspecifiedAddress,
  isUnspecifiedHost,
  loadConfig,
  resolvePublicUrl,
} = require('./config');
const { ensureDir, readJson, writeJsonAtomic } = require('./state');
const { preferredLanAddress } = require('./net-interfaces');

/**
 * Field metadata. `kind` drives the editor the TUI shows; `visibleFor` limits a
 * field to the access modes where it means anything.
 */
const FIELDS = [
  { id: 'mode', kind: 'choice', choices: ACCESS_MODES, labelKey: 'field.mode' },
  { id: 'port', kind: 'text', labelKey: 'field.port', visibleFor: ['local', 'lan'] },
  { id: 'lanHost', kind: 'address', labelKey: 'field.lanHost', visibleFor: ['lan'] },
  { id: 'remoteUrl', kind: 'text', labelKey: 'field.remoteUrl', visibleFor: ['remote'] },
  { id: 'publicUrl', kind: 'text', labelKey: 'field.publicUrl' },
  { id: 'socketPath', kind: 'text', labelKey: 'field.socketPath' },
  { id: 'herdrArgs', kind: 'text', labelKey: 'field.herdrArgs' },
  { id: 'language', kind: 'choice', choices: LANGUAGES, labelKey: 'field.language' },
  { id: 'keepaliveManager', kind: 'choice', choices: KEEPALIVE_MANAGERS, labelKey: 'field.keepalive' },
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
const SELECTABLE_MODES = ['local', 'lan', 'official', 'remote'];

/** Which of `SELECTABLE_MODES` this draft represents. */
function selectedMode(draft) {
  if (draft.relay.mode === 'remote' && draft.relay.remoteUrl === OFFICIAL_RELAY_URL) return 'official';
  return draft.relay.mode;
}

/** True when the relay is the one we run, so its address and password are ours. */
function isOfficialRelay(draft) {
  return selectedMode(draft) === 'official';
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createDraft(config = loadConfig()) {
  return clone(config);
}

function fieldsForMode(mode) {
  return FIELDS.filter((field) => !field.visibleFor || field.visibleFor.includes(mode));
}

/** Current value of a field as an editable string. */
function getField(draft, id) {
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
function getFieldPlaceholder(draft, id) {
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

function isValidUrl(value, protocols) {
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
function setField(draft, id, rawValue) {
  const next = clone(draft);
  const value = typeof rawValue === 'string' ? rawValue.trim() : rawValue;

  switch (id) {
    case 'mode': {
      if (!SELECTABLE_MODES.includes(value)) return { draft, errorKey: 'error.invalidMode' };
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
      if (value === 'lan'
        && (isLoopbackHost(next.relay.lanHost) || isUnspecifiedAddress(next.relay.lanHost))) {
        next.relay.lanHost = EMPTY;
      }
      // A public URL pinned for one mode is wrong for the next one; clearing it
      // lets derivation produce the right address again.
      next.relay.publicUrl = EMPTY;
      break;
    }
    case 'port': {
      const port = Number.parseInt(value, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { draft, errorKey: 'error.invalidPort' };
      next.relay.port = port;
      break;
    }
    case 'lanHost': {
      if (value && (isLoopbackHost(value) || isUnspecifiedAddress(value))) {
        return { draft, errorKey: 'error.invalidLanHost' };
      }
      next.relay.lanHost = value || EMPTY;
      break;
    }
    case 'remoteUrl': {
      if (value && !isValidUrl(value, ['ws:', 'wss:', 'http:', 'https:'])) {
        return { draft, errorKey: 'error.invalidRelayUrl' };
      }
      next.relay.remoteUrl = value.replace(/\/+$/, '');
      break;
    }
    case 'publicUrl': {
      if (value && (!isValidUrl(value, ['http:', 'https:']) || isUnspecifiedHost(value))) {
        return { draft, errorKey: 'error.invalidPublicUrl' };
      }
      next.relay.publicUrl = value.replace(/\/+$/, '');
      break;
    }
    case 'socketPath': {
      next.herdr.socketPath = value || null;
      break;
    }
    case 'herdrArgs': {
      next.herdr.args = value ? value.split(/\s+/).filter(Boolean) : [];
      break;
    }
    case 'language': {
      if (!LANGUAGES.includes(value)) return { draft, errorKey: 'error.invalidLanguage' };
      next.ui.language = value;
      break;
    }
    case 'keepaliveManager': {
      if (!KEEPALIVE_MANAGERS.includes(value)) return { draft, errorKey: 'error.invalidKeepalive' };
      next.keepalive.manager = value;
      break;
    }
    default:
      return { draft, errorKey: 'error.unknownField' };
  }
  return { draft: next, errorKey: null };
}

/** Problems that should block saving, as translatable keys. */
function validateDraft(draft) {
  const problems = [];
  if (draft.relay.mode === 'remote' && !draft.relay.remoteUrl) problems.push('error.remoteUrlRequired');
  return problems;
}

/**
 * Persist a draft, merging into whatever is already on disk so keys this
 * version does not know about survive the round trip.
 */
function saveDraft(draft) {
  const problems = validateDraft(draft);
  if (problems.length > 0) {
    const error = new Error(`configuration is incomplete: ${problems.join(', ')}`);
    error.problems = problems;
    throw error;
  }

  const current = readJson(configPath(), {}) || {};
  const merged = { ...current };
  merged.ui = { ...(current.ui || {}), language: draft.ui.language };
  merged.relay = {
    ...(current.relay || {}),
    mode: draft.relay.mode,
    port: draft.relay.port,
    lanHost: draft.relay.mode === 'lan'
      && (isLoopbackHost(draft.relay.lanHost) || isUnspecifiedAddress(draft.relay.lanHost))
      ? EMPTY
      : draft.relay.lanHost,
    publicUrl: draft.relay.publicUrl,
    remoteUrl: draft.relay.remoteUrl,
  };
  // Fields from the 0.1 schema would otherwise keep overriding the new ones on
  // the next load.
  delete merged.relay.local;
  delete merged.relay.host;
  delete merged.relay.url;
  // The optional Herdr source patch is gone. Nothing reads this section any
  // more, so the next save is where a config written by an older build sheds
  // it rather than carrying stale checksums and paths forever.
  delete merged.patch;
  merged.herdr = {
    ...(current.herdr || {}),
    socketPath: draft.herdr.socketPath,
    args: draft.herdr.args,
  };
  if (!merged.herdr.socketPath) delete merged.herdr.socketPath;
  merged.keepalive = { ...(current.keepalive || {}), manager: draft.keepalive.manager };

  ensureDir(configDir());
  writeJsonAtomic(configPath(), merged);
  return { ok: true, path: configPath() };
}

/**
 * Settings that only take effect after the services restart. Used to show a
 * "restart required" hint rather than silently doing nothing.
 */
function requiresRestart(before, after) {
  return before.relay.mode !== after.relay.mode
    || before.relay.port !== after.relay.port
    || before.relay.lanHost !== after.relay.lanHost
    || before.relay.remoteUrl !== after.relay.remoteUrl
    || before.relay.publicUrl !== after.relay.publicUrl
    || before.herdr.socketPath !== after.herdr.socketPath
    || before.herdr.args.join(' ') !== after.herdr.args.join(' ');
}

module.exports = {
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
