'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { describeStatus, parseArgs } = require('../bin/herdr-remote');
const { createTranslator } = require('../src/i18n');
const { parsePluginList } = require('../src/herdr-plugin');
const { serviceSpecs, relayBinPath } = require('../src/service');
const { DEFAULTS } = require('../src/config');

const ENTRY_POINT = path.join(__dirname, '..', 'bin', 'herdr-remote.js');

function runCli(args, extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-cli-'));
  try {
    return spawnSync(process.execPath, [ENTRY_POINT, ...args], {
      encoding: 'utf8',
      input: '',
      env: {
        ...process.env,
        HERDR_REMOTE_CONFIG_DIR: path.join(directory, 'config'),
        HERDR_REMOTE_STATE_DIR: path.join(directory, 'state'),
        ...extraEnv,
      },
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('argument parsing separates commands from flags', () => {
  assert.deepEqual(parseArgs(['status', '--json']), { positional: ['status'], flags: { json: true } });
  assert.deepEqual(parseArgs(['--lang', 'zh']).flags.lang, 'zh');
  assert.deepEqual(parseArgs(['--lang=en']).flags.lang, 'en');
  assert.deepEqual(parseArgs(['keepalive', 'install']).positional, ['keepalive', 'install']);
  assert.equal(parseArgs(['run', '--daemon']).flags.daemon, true);
});

test('--help exits cleanly and names the commands', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /herdr-remote/);
  assert.match(result.stdout, /Open the configuration TUI/);
  assert.match(result.stdout, /keepalive <action>/);
});

test('without a terminal the bare command reports status as JSON', () => {
  // Herdr runs plugin panes and actions with no TTY attached; painting an
  // interface into a pipe would produce escape-sequence noise instead of
  // something a caller can read.
  const result = runCli([]);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.relay);
  assert.ok(parsed.host);
  assert.ok(parsed.keepalive);
});

test('status honours the language flag', () => {
  const english = runCli(['status', '--lang', 'en']);
  assert.equal(english.status, 0);
  assert.match(english.stdout, /Access mode/);

  const chinese = runCli(['status', '--lang', 'zh']);
  assert.equal(chinese.status, 0);
  assert.match(chinese.stdout, /访问方式/);
});

test('an unknown command fails loudly', () => {
  const result = runCli(['definitely-not-a-command']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command/);
});

test('status output renders every service line', () => {
  const t = createTranslator('en');
  const text = describeStatus({
    mode: 'lan',
    relay: { local: true, alive: true, bind: '0.0.0.0', port: 8787, pid: 42, remoteUrl: null, health: { ok: true } },
    host: { alive: true, pid: 43, socketPath: '/tmp/herdr.sock', socketExists: true },
    publicUrl: 'http://100.64.0.7:8787',
    keepalive: { manager: 'systemd', installed: true, active: true },
  }, t);

  assert.match(text, /Local network \/ Tailscale/);
  assert.match(text, /0\.0\.0\.0:8787/);
  assert.match(text, /http:\/\/100\.64\.0\.7:8787/);
  assert.match(text, /systemd/);
});

test('herdr plugin list output is parsed, warnings and all', () => {
  const plugins = parsePluginList([
    '2 plugins installed:',
    '- herdr.auto-title (Auto Title) enabled [github:owner/repo@abc123]',
    '  config: /home/user/.config/herdr/plugins/config/herdr.auto-title',
    '- herdr.remote.web (Herdr Remote Web) enabled [local:/opt/herdr-remote; 1 warning(s)]',
    '  warning: manifest unavailable',
  ].join('\n'));

  assert.equal(plugins.length, 2);
  const remote = plugins.find((plugin) => plugin.id === 'herdr.remote.web');
  // The diagnostics Herdr appends inside the brackets must not end up glued to
  // the path, or the "is this link stale?" comparison never matches.
  assert.equal(remote.localPath, '/opt/herdr-remote');
  assert.equal(remote.warnings, '1 warning(s)');
  assert.equal(remote.enabled, true);
  assert.equal(plugins[0].localPath, null);
});

test('the local relay is spawned from the separate relay package', () => {
  const state = { hostId: 'host-test', hostToken: 'a'.repeat(32) };
  const config = JSON.parse(JSON.stringify(DEFAULTS));
  const specs = serviceSpecs(config, state);

  assert.deepEqual(specs.map((spec) => spec.name), ['relay', 'host']);
  const relay = specs[0];
  assert.equal(relay.args[0], relayBinPath());
  assert.match(relay.args[0], /herdr-remote-relay/);
  assert.equal(relay.env.RELAY_DEPLOYMENT_MODE, 'local');
  assert.equal(relay.env.RELAY_BIND, '127.0.0.1');
  // A relay we start ourselves is closed to anything but this workstation.
  assert.equal(relay.env.RELAY_PASSWORD, state.hostToken);

  const host = specs[1];
  assert.equal(host.env.RELAY_URL, 'ws://127.0.0.1:8787/ws/host');
  assert.equal(host.env.RELAY_HOST_TOKEN, state.hostToken);
});

test('remote mode plans a host connector only', () => {
  const state = { hostId: 'host-test', hostToken: 'a'.repeat(32), relayPassword: 'hunter2' };
  const config = JSON.parse(JSON.stringify(DEFAULTS));
  config.relay.mode = 'remote';
  config.relay.remoteUrl = 'wss://relay.example.com';

  const specs = serviceSpecs(config, state);
  assert.deepEqual(specs.map((spec) => spec.name), ['host']);
  assert.equal(specs[0].env.RELAY_URL, 'wss://relay.example.com/ws/host');
  // The password joins the relay; the host token identifies this workstation.
  assert.equal(specs[0].env.RELAY_PASSWORD, 'hunter2');
  assert.equal(specs[0].env.RELAY_HOST_TOKEN, state.hostToken);
});

test('the plugin manifest version matches package.json', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  );
  const manifest = fs.readFileSync(
    path.join(__dirname, '..', 'herdr-plugin.toml'),
    'utf8'
  );
  const match = /^version\s*=\s*"([^"]+)"/m.exec(manifest);
  assert.ok(match, 'herdr-plugin.toml is missing a version field');
  assert.equal(match[1], packageJson.version);
});
