import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createTranslator } from '../src/i18n/index.js';
import { runUpdate } from '../src/update-command.js';

const t = createTranslator('en');

/** Every dependency faked, with each call recorded in order. */
function harness({
  platform = 'linux',
  cli = { ok: true, current: '1.0.0', latest: '1.1.0', updateAvailable: true, sources: [] },
  relay = { ok: true, current: '0.3.0', latest: '0.3.0', updateAvailable: false },
  running = true,
  install = { ok: true, installed: '1.1.0' },
  restart = { ok: true, message: '' },
  broker = 'unavailable',
  brokerBack = true,
} = {}) {
  const calls = [];
  const lines = [];
  const options = {
    platform,
    checkCli: async () => cli,
    checkRelay: async () => relay,
    installCli: async (check) => {
      calls.push(`install herdr-remote ${check.latest}`);
      return install;
    },
    installRelay: async (check) => {
      calls.push(`install relay ${check.latest}`);
      return install;
    },
    isRunning: () => running,
    stop: () => calls.push('stop'),
    start: () => calls.push('start'),
    restartInstalled: () => {
      calls.push('restart with the installed release');
      return restart;
    },
    stopBroker: async () => {
      calls.push(`ask the broker to stop: ${broker}`);
      return broker;
    },
    startBroker: async () => {
      calls.push('start the broker');
      return brokerBack;
    },
    report: (line) => lines.push(line),
  };
  return { options, calls, lines };
}

test('a newer release is installed and the running services restart on it', async () => {
  const { options, calls } = harness();

  const outcome = await runUpdate(t, options);

  assert.deepEqual(calls, ['install herdr-remote 1.1.0', 'restart with the installed release']);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.updated, 'cli');
  assert.equal(outcome.restarted, true);
});

test('Windows stops the services before npm replaces their files', async () => {
  const { options, calls } = harness({ platform: 'win32' });

  await runUpdate(t, options);

  assert.deepEqual(calls, [
    'stop',
    'ask the broker to stop: unavailable',
    'install herdr-remote 1.1.0',
    'restart with the installed release',
  ]);
});

test('a failed install on Windows brings the old services back and names the lock', async () => {
  const { options, calls, lines } = harness({
    platform: 'win32',
    install: {
      ok: false,
      errorKey: 'update.errorFailed',
      summary: 'code EBUSY syscall rename',
      output:
        "npm error EBUSY: resource busy or locked, rename 'C:\\npm\\node_modules\\herdr-remote'",
    },
  });

  const outcome = await runUpdate(t, options);

  assert.deepEqual(calls, [
    'stop',
    'ask the broker to stop: unavailable',
    'install herdr-remote 1.1.0',
    'start',
  ]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.restarted, false);
  assert.ok(lines.includes(t('update.errorBusy')));
});

test('services that were not running are left stopped', async () => {
  const { options, calls, lines } = harness({ platform: 'win32', running: false });

  const outcome = await runUpdate(t, options);

  assert.deepEqual(calls, ['ask the broker to stop: unavailable', 'install herdr-remote 1.1.0']);
  assert.equal(outcome.restarted, false);
  assert.ok(lines.includes(t('update.notRunning')));
});

test('with herdr-remote current, a newer relay in range is installed on its own', async () => {
  const { options, calls } = harness({
    cli: { ok: true, current: '1.0.0', latest: '1.0.0', updateAvailable: false },
    relay: { ok: true, current: '0.3.0', latest: '0.3.4', updateAvailable: true },
    install: { ok: true, installed: '0.3.4' },
  });

  const outcome = await runUpdate(t, options);

  assert.deepEqual(calls, ['install relay 0.3.4', 'restart with the installed release']);
  assert.equal(outcome.updated, 'relay');
});

test('nothing is installed or restarted when everything is current', async () => {
  const { options, calls, lines } = harness({
    cli: { ok: true, current: '1.0.0', latest: '1.0.0', updateAvailable: false },
  });

  const outcome = await runUpdate(t, options);

  assert.deepEqual(calls, []);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.updated, null);
  assert.ok(lines.includes(t('update.upToDate', { version: '1.0.0' })));
});

test('an unreachable registry fails without touching the services', async () => {
  const { options, calls } = harness({
    cli: { ok: false, current: '1.0.0', errorKey: 'update.errorNetwork', message: 'timed out' },
  });

  const outcome = await runUpdate(t, options);

  assert.deepEqual(calls, []);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorKey, 'update.errorNetwork');
});

test('a restart that fails after the install is reported as a failure', async () => {
  const { options, lines } = harness({ restart: { ok: false, message: 'port in use' } });

  const outcome = await runUpdate(t, options);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.installed, '1.1.0');
  assert.ok(lines.includes(t('update.restartFailed', { message: 'port in use' })));
});

test('Windows restarts the admin broker so its task runs the new release', async () => {
  const { options, calls, lines } = harness({ platform: 'win32', broker: 'stopped' });

  const outcome = await runUpdate(t, options);

  assert.deepEqual(calls, [
    'stop',
    'ask the broker to stop: stopped',
    'install herdr-remote 1.1.0',
    'restart with the installed release',
    'start the broker',
  ]);
  assert.equal(outcome.adminBroker, 'restarted');
  assert.ok(lines.includes(t('update.brokerRestarted')));
});

test('a broker stopped for a failed install is started again', async () => {
  const { options, calls } = harness({
    platform: 'win32',
    broker: 'stopped',
    install: { ok: false, errorKey: 'update.errorFailed', output: 'npm error ETIMEDOUT' },
  });

  await runUpdate(t, options);

  assert.deepEqual(calls.slice(-2), ['start', 'start the broker']);
});

test('a broker serving an open admin terminal is left running and the user told', async () => {
  const { options, calls, lines } = harness({ platform: 'win32', broker: 'busy' });

  const outcome = await runUpdate(t, options);

  assert.ok(!calls.includes('start the broker'));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.adminBroker, 'busy');
  assert.ok(lines.includes(t('update.brokerBusy')));
});

test('a broker that does not come back is reported without failing the update', async () => {
  const { options, lines } = harness({ platform: 'win32', broker: 'stopped', brokerBack: false });

  const outcome = await runUpdate(t, options);

  assert.equal(outcome.ok, true);
  assert.equal(outcome.adminBroker, 'failed');
  assert.ok(lines.includes(t('update.brokerRestartFailed')));
});

test('only Windows has an admin broker to stop', async () => {
  const { options, calls } = harness({ platform: 'darwin' });

  await runUpdate(t, options);

  assert.ok(!calls.some((call) => call.includes('broker')));
});
