'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  detectManager,
  escapeXml,
  renderLaunchdPlist,
  renderSystemdUnit,
  serviceEnvironment,
  servicePath,
  systemdEnvironmentLine,
} = require('../src/keepalive');

test('the systemd unit restarts the supervisor and installs into the user target', () => {
  const unit = renderSystemdUnit({ nodePath: '/usr/bin/node', entryPoint: '/opt/herdr-remote/bin/herdr-remote.js' });

  assert.match(unit, /ExecStart=\/usr\/bin\/node \/opt\/herdr-remote\/bin\/herdr-remote\.js run$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^RestartSec=3$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
});

test('systemd environment entries are rendered one per line', () => {
  const unit = renderSystemdUnit({ environment: { HERDR_REMOTE_LANG: 'zh', OTHER: '1' } });
  assert.match(unit, /^Environment=HERDR_REMOTE_LANG=zh$/m);
  assert.match(unit, /^Environment=OTHER=1$/m);
});

test('systemd values with spaces or specifiers survive the unit file', () => {
  assert.equal(systemdEnvironmentLine('PATH', '/usr/bin:/home/me/.local/bin'), 'Environment=PATH=/usr/bin:/home/me/.local/bin');
  assert.equal(systemdEnvironmentLine('PATH', '/opt/my tools/bin'), 'Environment="PATH=/opt/my tools/bin"');
  assert.equal(systemdEnvironmentLine('PATH', '/opt/a"b\\c'), 'Environment="PATH=/opt/a\\"b\\\\c"');
  // `%` opens a systemd specifier; a literal one has to be doubled.
  assert.equal(systemdEnvironmentLine('PATH', '/opt/100%/bin'), 'Environment="PATH=/opt/100%%/bin"');
  // A newline would end the directive and turn the rest into unit syntax.
  assert.equal(systemdEnvironmentLine('PATH', '/a\nExecStart=/evil'), 'Environment="PATH=/a ExecStart=/evil"');
});

// Issue #1: a unit installed from a shell that could run `herdr` still could
// not, because systemd hands the unit a PATH without ~/.local/bin in it.
test('the installed environment pins the Herdr binary and the PATH that found it', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-keepalive-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const directory = path.join(home, '.local', 'bin');
  fs.mkdirSync(directory, { recursive: true });
  const binary = path.join(directory, 'herdr');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const environment = serviceEnvironment({ env: { PATH: '/usr/bin' }, home });

  assert.equal(environment.HERDR_BIN_PATH, binary);
  assert.deepEqual(environment.PATH.split(path.delimiter), ['/usr/bin', directory]);

  const unit = renderSystemdUnit({ environment });
  assert.match(unit, new RegExp(`^Environment=HERDR_BIN_PATH=${binary}$`, 'm'));
  assert.match(unit, /^Environment=PATH=\/usr\/bin:/m);
});

test('a PATH that already covers Herdr is not given a duplicate entry', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-keepalive-path-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const searchPath = servicePath({
    env: { PATH: ['/usr/bin', path.join(home, 'bin'), '/usr/bin'].join(path.delimiter) },
    herdrCommand: path.join(home, 'bin', 'herdr'),
  });

  assert.deepEqual(searchPath.split(path.delimiter), ['/usr/bin', path.join(home, 'bin')]);
});

test('no Herdr install means no HERDR_BIN_PATH is invented', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-keepalive-empty-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const environment = serviceEnvironment({ env: { PATH: '' }, home, directories: [] });

  assert.equal(Object.hasOwn(environment, 'HERDR_BIN_PATH'), false);
});

test('the launchd agent runs at load and is kept alive', () => {
  const plist = renderLaunchdPlist({
    nodePath: '/usr/local/bin/node',
    entryPoint: '/opt/herdr-remote/bin/herdr-remote.js',
    outLog: '/tmp/out.log',
    errLog: '/tmp/err.log',
  });

  assert.match(plist, /<key>Label<\/key>\s*<string>dev\.herdr\.remote<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(plist, /<string>run<\/string>/);
  assert.match(plist, /<string>\/tmp\/out\.log<\/string>/);
});

test('the launchd agent carries the same environment as the systemd unit', () => {
  const plist = renderLaunchdPlist({ environment: { HERDR_BIN_PATH: '/Users/me/.local/bin/herdr', PATH: '/usr/bin:/Users/me/.local/bin' } });

  assert.match(plist, /<key>EnvironmentVariables<\/key>/);
  assert.match(plist, /<key>HERDR_BIN_PATH<\/key>\s*<string>\/Users\/me\/\.local\/bin\/herdr<\/string>/);
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/usr\/bin:\/Users\/me\/\.local\/bin<\/string>/);
});

test('plist values are XML escaped so odd paths cannot break the document', () => {
  assert.equal(escapeXml('a&b<c>"d"\'e\''), 'a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;');

  const plist = renderLaunchdPlist({ entryPoint: '/opt/herdr & co/bin/herdr-remote.js' });
  assert.match(plist, /herdr &amp; co/);
  assert.equal(plist.includes('herdr & co'), false);
});

test('an explicit manager preference overrides platform detection', () => {
  assert.equal(detectManager('supervisor'), 'supervisor');
  assert.equal(detectManager('none'), 'none');
  assert.equal(detectManager('systemd'), 'systemd');
});

test('auto detection never returns a manager the platform cannot provide', () => {
  const detected = detectManager('auto');
  assert.ok(['systemd', 'launchd', 'supervisor'].includes(detected));
  if (process.platform !== 'linux') assert.notEqual(detected, 'systemd');
  if (process.platform !== 'darwin') assert.notEqual(detected, 'launchd');
});
