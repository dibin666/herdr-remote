import { test } from 'vitest';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { detectManager } from '../src/keepalive/index.js';
import { detachedLogsHint } from '../src/keepalive/detached.js';
import {
  classifyStartResult,
  currentServiceAccount,
  encodePowerShellCommand,
  escapePowerShellSingleQuoted,
  parseWhoamiSid,
  parseWinswState,
  renderElevationScript,
  renderWinswConfig,
  serviceId,
  serviceState,
  startService,
  stopService,
  windowsServiceSddl,
  windowsServicePaths,
  waitForState,
} from '../src/keepalive/windows-service.js';

test('service IDs replace characters that SCM does not accept', () => {
  assert.equal(serviceId('Alex Doe/测试'), 'herdr-remote-Alex_Doe___');
});

test('service setup exports its account, paths and lifecycle operations', () => {
  for (const operation of [
    currentServiceAccount,
    windowsServicePaths,
    serviceState,
    waitForState,
    startService,
    stopService,
  ])
    assert.equal(typeof operation, 'function');
});

test('whoami CSV parsing takes the final SID field for comma and Unicode usernames', () => {
  assert.equal(
    parseWhoamiSid('"DOMAIN, North\\alice","S-1-5-21-100-200-300-1001"\r\n'),
    'S-1-5-21-100-200-300-1001',
  );
  assert.equal(
    parseWhoamiSid('"设备域\\用户","S-1-5-21-100-200-300-1002"\n'),
    'S-1-5-21-100-200-300-1002',
  );
  assert.equal(parseWhoamiSid('"DOMAIN\\alice","not-a-sid"'), null);
});

test('WinSW status parsing takes the last nonempty line and rejects unknown output', () => {
  assert.equal(parseWinswState('Started'), 'Started');
  assert.equal(parseWinswState('banner\n\nStopped\n'), 'Stopped');
  assert.equal(parseWinswState('NonExistent'), 'NonExistent');
  assert.equal(parseWinswState(''), 'NonExistent');
  assert.equal(parseWinswState('localized output'), 'NonExistent');
});

test('start result classification handles already-running and bad-account codes', () => {
  assert.equal(classifyStartResult({ code: 0, stdout: '', stderr: '' }), 'ok');
  assert.equal(classifyStartResult({ code: 1056, stdout: '', stderr: '' }), 'ok');
  assert.equal(classifyStartResult({ code: 1069, stdout: '', stderr: '' }), 'logon-failed');
  const failure = classifyStartResult({ code: 5, stdout: 'access denied', stderr: '' });
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /failed \(5\): access denied/);
});

test('the WinSW descriptor grants the installing user direct service control', () => {
  assert.equal(
    windowsServiceSddl('S-1-5-21-100-200-300-1001'),
    'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)(A;;CCLCSWRPWPDTLOCRRC;;;S-1-5-21-100-200-300-1001)',
  );
});

test('WinSW XML escapes values, includes its environment, and contains no password', () => {
  const xml = renderWinswConfig({
    id: 'herdr-remote-alice',
    user: 'A&B <User>',
    domain: 'D&MAIN',
    userSid: 'S-1-5-21-100-200-300-1001',
    nodePath: 'C:\\Program Files\\Node\\node.exe',
    entryPoint: 'C:\\Program Files\\Herdr\\bin\\herdr-remote.js',
    workingDirectory: 'C:\\Users\\A&B\\AppData\\Local\\herdr-remote',
    environment: {
      HERDR_BIN_PATH: 'C:\\Herdr & Tools\\herdr.exe',
      PATH: 'C:\\Windows\\System32;C:\\Herdr & Tools',
      HERDR_REMOTE_SERVICE: '1',
    },
  });

  for (const fragment of [
    '<id>herdr-remote-alice</id>',
    '<name>Herdr Remote (A&amp;B &lt;User&gt;)</name>',
    'running as D&amp;MAIN\\A&amp;B &lt;User&gt;.',
    '<executable>C:\\Program Files\\Node\\node.exe</executable>',
    '<arguments>&quot;C:\\Program Files\\Herdr\\bin\\herdr-remote.js&quot; run --daemon</arguments>',
    '<workingdirectory>C:\\Users\\A&amp;B\\AppData\\Local\\herdr-remote</workingdirectory>',
    '<startmode>Automatic</startmode>',
    '<delayedAutoStart/>',
    '<onfailure action="restart" delay="3 sec"/>',
    '<resetfailure>1 hour</resetfailure>',
    '<stoptimeout>15 sec</stoptimeout>',
    '<logpath>C:\\Users\\A&amp;B\\AppData\\Local\\herdr-remote</logpath>',
    '<logname>supervisor</logname>',
    '<log mode="append"/>',
    '<env name="HERDR_BIN_PATH" value="C:\\Herdr &amp; Tools\\herdr.exe"/>',
    '<env name="PATH" value="C:\\Windows\\System32;C:\\Herdr &amp; Tools"/>',
    '<env name="HERDR_REMOTE_SERVICE" value="1"/>',
    '<domain>D&amp;MAIN</domain>',
    '<user>A&amp;B &lt;User&gt;</user>',
    '<allowservicelogon>true</allowservicelogon>',
    '<securityDescriptor>D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)',
    'S-1-5-21-100-200-300-1001',
  ])
    assert.ok(xml.includes(fragment), fragment);
  assert.equal(xml.includes('<password>'), false);
});

test('PowerShell elevation uses UTF-16LE and escapes single quotes in paths', () => {
  const nodePath = "C:\\Program Files\\O'Neil\\node.exe";
  const entryPoint = "C:\\Users\\A O'Neil\\herdr remote\\bin\\cli.js";
  const script = renderElevationScript({ nodePath, entryPoint });

  assert.match(script, /-FilePath 'C:\\Program Files\\O''Neil\\node\.exe'/);
  assert.match(
    script,
    /-ArgumentList '"C:\\Users\\A O''Neil\\herdr remote\\bin\\cli\.js" keepalive install --elevated'/,
  );
  assert.match(script, /-Verb RunAs -Wait -PassThru/);
  assert.equal(Buffer.from(encodePowerShellCommand(script), 'base64').toString('utf16le'), script);
  assert.equal(escapePowerShellSingleQuoted("C:\\O'Neil path"), "C:\\O''Neil path");
});

test('Windows detection and keep-alive log hints use the Windows manager', () => {
  assert.equal(detectManager('auto', 'win32'), 'windows-service');
  assert.equal(detectManager('supervisor', 'win32'), 'supervisor');
  assert.equal(detectManager('none', 'win32'), 'none');
  const logFile = path.join(os.tmpdir(), 'herdr-remote', 'supervisor.log');
  assert.equal(detachedLogsHint('win32', logFile), `Get-Content -Wait -Tail 40 "${logFile}"`);
  assert.equal(detachedLogsHint('linux', logFile), `tail -f ${logFile}`);
});
