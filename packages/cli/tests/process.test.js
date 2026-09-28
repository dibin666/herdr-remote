import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { processCommands, processStart, processStarts, stillRunning } from '../src/lib/process.js';
import { tempDir } from './helpers.js';

// A pid that is certainly not running: above the kernel maximum.
const DEAD_PID = 4194304;

function spawnSleeper(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.onTestFinished(() => child.kill('SIGKILL'));
  return child.pid;
}

test('a start token is stable for one process and differs between processes', (t) => {
  const own = processStart(process.pid);
  assert.equal(typeof own, 'string');
  assert.equal(processStart(process.pid), own);
  assert.notEqual(processStart(spawnSleeper(t)), own);
  assert.equal(processStart(DEAD_PID), null);
});

test('platforms without /proc get their start tokens from ps', (t) => {
  const own = processStart(process.pid, 'darwin');
  assert.equal(typeof own, 'string');
  assert.equal(processStart(process.pid, 'darwin'), own);
  const sleeper = spawnSleeper(t);
  const both = processStarts([process.pid, sleeper, DEAD_PID], 'darwin');
  assert.equal(both.get(process.pid), own);
  assert.ok(both.has(sleeper));
  assert.equal(both.has(DEAD_PID), false);
});

test('Windows start tokens for several pids come from one PowerShell call', () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    return `${process.pid} 133712345678901234\r\n${process.ppid} 133712345678905678\r\n`;
  };
  const starts = processStarts([process.pid, process.ppid, DEAD_PID], 'win32', run);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'powershell.exe');
  assert.equal(starts.get(process.pid), '133712345678901234');
  assert.equal(starts.get(process.ppid), '133712345678905678');
  assert.equal(starts.has(DEAD_PID), false);
});

test('a recorded pid now held by another process is not still running', () => {
  const current = { pid: process.pid, processStart: processStart(process.pid) };
  // What a reboot leaves behind: the number is live again, the process is not ours.
  const earlierBoot = { pid: process.pid, processStart: 'an-earlier-boot:1234' };
  // Written before start tokens existed, by something that is not one of our entry points.
  const unverifiable = { pid: process.pid };
  assert.deepEqual(stillRunning([current, earlierBoot, unverifiable]), [current]);
});

test('a record written before start tokens is trusted only while it runs our entry point', (t) => {
  // Shaped like the relay an older release started: node running herdr-remote-relay.js.
  const script = path.join(tempDir(t), 'herdr-remote-relay.js');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
  const relay = spawn(process.execPath, [script], { stdio: 'ignore' });
  t.onTestFinished(() => relay.kill('SIGKILL'));
  const ours = { name: 'relay', pid: relay.pid };
  const bystander = { name: 'relay', pid: spawnSleeper(t) };

  assert.deepEqual(stillRunning([ours, bystander]), [ours]);
});

test('Windows command lines for several pids come from one PowerShell call', () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    return `${process.pid} "C:\\node.exe" "C:\\herdr-remote\\bin\\herdr-remote.js" run\r\n`;
  };
  const commands = processCommands([process.pid, DEAD_PID], 'win32', run);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'powershell.exe');
  assert.equal(
    commands.get(process.pid),
    '"C:\\node.exe" "C:\\herdr-remote\\bin\\herdr-remote.js" run',
  );
  assert.equal(commands.has(DEAD_PID), false);
});
