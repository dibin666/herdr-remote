import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  parseWindowsTaskState,
  renderWindowsTaskLaunchScript,
  renderWindowsTaskRegistrationScript,
  windowsTaskName,
} from '../src/keepalive/windows-task.js';

test('task launch script pins user paths and safely quotes executable paths', () => {
  const script = renderWindowsTaskLaunchScript({
    nodePath: "C:\\Program Files\\Node\\O'Neil\\node.exe",
    entryPoint: "C:\\Users\\O'Neil\\herdr remote\\bin\\herdr-remote.js",
    workingDirectory: "C:\\Users\\O'Neil\\AppData\\Local\\herdr-remote",
    configDirectory: "C:\\Users\\O'Neil\\AppData\\Roaming\\herdr-remote",
    stateDirectory: "C:\\Users\\O'Neil\\AppData\\Local\\herdr-remote",
    environment: { PATH: 'C:\\Program Files\\Herdr\\bin' },
  });

  assert.match(script, /HERDR_REMOTE_CONFIG_DIR = 'C:\\Users\\O''Neil/);
  assert.match(script, /HERDR_REMOTE_STATE_DIR = 'C:\\Users\\O''Neil/);
  assert.match(script, /HERDR_REMOTE_SERVICE = '1'/);
  assert.match(script, /& 'C:\\Program Files\\Node\\O''Neil\\node\.exe'/);
  assert.match(script, /run --daemon/);
});

test('task registration uses an interactive logon trigger without account credentials', () => {
  const script = renderWindowsTaskRegistrationScript({
    taskName: 'herdr-remote-alice',
    account: 'DESKTOP\\alice',
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    workingDirectory: 'C:\\Users\\alice\\AppData\\Local\\herdr-remote',
    launchScript: "$env:HERDR_REMOTE_SERVICE = '1'",
  });

  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn -User 'DESKTOP\\alice'/);
  assert.match(
    script,
    /New-ScheduledTaskPrincipal -UserId 'DESKTOP\\alice' -LogonType Interactive -RunLevel Limited/,
  );
  assert.match(script, /Register-ScheduledTask/);
  assert.match(script, /Start-ScheduledTask/);
  assert.doesNotMatch(script, /-Password|-Credential|StartPassword/);
});

test('task state parsing handles scheduler output and absent tasks', () => {
  assert.equal(parseWindowsTaskState('{"State":"Running"}'), 'Running');
  assert.equal(parseWindowsTaskState('{"State":"Ready"}'), 'Ready');
  assert.equal(parseWindowsTaskState('{"State":"Queued"}'), 'Queued');
  assert.equal(parseWindowsTaskState('{"State":"Disabled"}'), 'Disabled');
  assert.equal(parseWindowsTaskState('{"State":"Absent"}'), 'Absent');
  assert.equal(parseWindowsTaskState('\uFEFF{"State":"Running"}'), 'Running');
  assert.equal(parseWindowsTaskState('localized output'), 'Absent');
});

test('scheduled task names are stable per Windows account', () => {
  assert.equal(windowsTaskName('Alex Doe/测试'), 'herdr-remote-Alex_Doe___');
});
