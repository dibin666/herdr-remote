'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectManager, escapeXml, renderLaunchdPlist, renderSystemdUnit } = require('../src/keepalive');

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
