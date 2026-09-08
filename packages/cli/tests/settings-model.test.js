'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDraft, fieldsForMode, getField, requiresRestart, saveDraft, setField, validateDraft } = require('../src/settings-model');
const { DEFAULTS, configPath, loadConfig, resolvePublicUrl, resolveHostRelayUrl, runsLocalRelay, bindAddress } = require('../src/config');
const { readJson } = require('../src/state');

function withTempConfig(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-settings-'));
  const previous = process.env.HERDR_REMOTE_CONFIG_DIR;
  process.env.HERDR_REMOTE_CONFIG_DIR = directory;
  try {
    return run(directory);
  } finally {
    if (previous === undefined) delete process.env.HERDR_REMOTE_CONFIG_DIR;
    else process.env.HERDR_REMOTE_CONFIG_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function baseDraft() {
  return createDraft(JSON.parse(JSON.stringify(DEFAULTS)));
}

test('settings model reads and writes each editable field', () => {
  let draft = baseDraft();

  draft = setField(draft, 'port', '9090').draft;
  assert.equal(getField(draft, 'port'), '9090');

  draft = setField(draft, 'publicUrl', 'https://remote.example.com').draft;
  assert.equal(getField(draft, 'publicUrl'), 'https://remote.example.com');

  draft = setField(draft, 'socketPath', '/tmp/custom-herdr.sock').draft;
  assert.equal(getField(draft, 'socketPath'), '/tmp/custom-herdr.sock');

  draft = setField(draft, 'herdrArgs', '--foo --bar').draft;
  assert.equal(getField(draft, 'herdrArgs'), '--foo --bar');
  assert.deepEqual(draft.herdr.args, ['--foo', '--bar']);
});

test('settings model rejects invalid values and leaves the draft untouched', () => {
  const draft = baseDraft();

  const badPort = setField(draft, 'port', '70000');
  assert.equal(badPort.errorKey, 'error.invalidPort');
  assert.equal(badPort.draft, draft);

  const badUrl = setField(draft, 'publicUrl', 'not-a-url');
  assert.equal(badUrl.errorKey, 'error.invalidPublicUrl');
  assert.equal(badUrl.draft, draft);

  const wildcardUrl = setField(draft, 'publicUrl', 'http://0.0.0.0:8787');
  assert.equal(wildcardUrl.errorKey, 'error.invalidPublicUrl');
  assert.equal(wildcardUrl.draft, draft);

  const badLanHost = setField(setField(draft, 'mode', 'lan').draft, 'lanHost', '127.0.0.1');
  assert.equal(badLanHost.errorKey, 'error.invalidLanHost');
  assert.equal(badLanHost.draft.relay.lanHost, '');

  const badRelay = setField(draft, 'remoteUrl', 'ftp://relay.example.com');
  assert.equal(badRelay.errorKey, 'error.invalidRelayUrl');

  const badMode = setField(draft, 'mode', 'sideways');
  assert.equal(badMode.errorKey, 'error.invalidMode');

  const unknownField = setField(draft, 'nonsense', 'maybe');
  assert.equal(unknownField.errorKey, 'error.unknownField');
  assert.equal(unknownField.draft, draft);
});

test('changing the access mode clears a public URL pinned for the old one', () => {
  let draft = baseDraft();
  draft = setField(draft, 'publicUrl', 'http://192.168.1.5:8787').draft;
  draft = setField(draft, 'mode', 'remote').draft;
  assert.equal(draft.relay.publicUrl, '');
});

test('remote mode requires a relay URL before it can be saved', () => {
  const draft = setField(baseDraft(), 'mode', 'remote').draft;
  assert.deepEqual(validateDraft(draft), ['error.remoteUrlRequired']);
  assert.throws(() => saveDraft(draft), /incomplete/);

  const complete = setField(draft, 'remoteUrl', 'wss://relay.example.com').draft;
  assert.deepEqual(validateDraft(complete), []);
});

test('saving writes the file atomically and drops superseded 0.1 keys', () => {
  withTempConfig(() => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify({
      relay: { local: true, host: '127.0.0.1', url: 'ws://127.0.0.1:8787', port: 8787 },
      unknownSection: { keepMe: true },
    }));

    let draft = createDraft(loadConfig());
    draft = setField(draft, 'port', '8888').draft;
    draft = setField(draft, 'mode', 'lan').draft;
    draft = setField(draft, 'lanHost', '100.101.102.103').draft;
    saveDraft(draft);

    const saved = readJson(configPath(), {});
    assert.equal(saved.relay.port, 8888);
    assert.equal(saved.relay.mode, 'lan');
    assert.equal(saved.relay.lanHost, '100.101.102.103');
    // Legacy keys would keep re-triggering the migration path on every load.
    assert.equal('local' in saved.relay, false);
    assert.equal('host' in saved.relay, false);
    assert.equal('url' in saved.relay, false);
    // Unknown sections survive a round trip through an older client.
    assert.deepEqual(saved.unknownSection, { keepMe: true });

    const reloaded = loadConfig();
    assert.equal(reloaded.relay.mode, 'lan');
    assert.equal(resolvePublicUrl(reloaded), 'http://100.101.102.103:8888');
    assert.equal(bindAddress(reloaded), '0.0.0.0');
  });
});

test('a remote relay drives the public URL and the host connector target', () => {
  withTempConfig(() => {
    let draft = createDraft(JSON.parse(JSON.stringify(DEFAULTS)));
    draft = setField(draft, 'mode', 'remote').draft;
    draft = setField(draft, 'remoteUrl', 'wss://herdr.example.com').draft;
    saveDraft(draft);

    const config = loadConfig();
    assert.equal(runsLocalRelay(config), false);
    assert.equal(resolvePublicUrl(config), 'https://herdr.example.com');
    assert.equal(resolveHostRelayUrl(config), 'wss://herdr.example.com/ws/host');
  });
});

test('only settings the services read require a restart', () => {
  const before = baseDraft();
  const languageOnly = setField(before, 'language', 'zh').draft;
  assert.equal(requiresRestart(before, languageOnly), false);

  const portChanged = setField(before, 'port', '9191').draft;
  assert.equal(requiresRestart(before, portChanged), true);

  const argsChanged = setField(before, 'herdrArgs', '--attach').draft;
  assert.equal(requiresRestart(before, argsChanged), true);
});

test('fields are limited to the modes where they apply', () => {
  const localIds = fieldsForMode('local').map((field) => field.id);
  assert.ok(localIds.includes('port'));
  assert.ok(localIds.includes('herdrArgs'));
  assert.equal(localIds.includes('remoteUrl'), false);
  assert.equal(localIds.includes('lanHost'), false);

  const remoteIds = fieldsForMode('remote').map((field) => field.id);
  assert.ok(remoteIds.includes('remoteUrl'));
  assert.equal(remoteIds.includes('port'), false);

  assert.ok(fieldsForMode('lan').map((field) => field.id).includes('lanHost'));
});

test('setting herdrArgs with --no-session is rejected and leaves the draft untouched', () => {
  const draft = baseDraft();
  const result = setField(draft, 'herdrArgs', '--no-session');
  assert.equal(result.errorKey, 'error.removedHerdrArg');
  assert.equal(result.draft, draft);
});

test('valid herdr arguments are accepted and written to the draft', () => {
  const draft = baseDraft();
  const result = setField(draft, 'herdrArgs', '--foo --bar');
  assert.equal(result.errorKey, null);
  assert.deepEqual(result.draft.herdr.args, ['--foo', '--bar']);
  assert.equal(getField(result.draft, 'herdrArgs'), '--foo --bar');
});
