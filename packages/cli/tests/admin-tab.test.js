import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ADMIN_TAB_ENV, adminShellCommand, openAdminTab } from '../src/connector/admin-tab.js';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const ENTRY = "C:\\Users\\O'Neil\\herdr-remote\\bin\\herdr-remote.js";

test('the admin-shell command is written in the syntax of the tab shell', () => {
  assert.equal(
    adminShellCommand('powershell.exe', NODE, ENTRY),
    "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\O''Neil\\herdr-remote\\bin\\herdr-remote.js' admin-shell",
  );
  assert.equal(
    adminShellCommand('C:\\Program Files\\PowerShell\\7\\pwsh.exe', NODE, ENTRY).startsWith('& '),
    true,
  );
  assert.equal(adminShellCommand('cmd.exe', NODE, ENTRY), `"${NODE}" "${ENTRY}" admin-shell`);
  assert.equal(
    adminShellCommand('bash.exe', NODE, ENTRY),
    "'C:/Program Files/nodejs/node.exe' 'C:/Users/O'\\''Neil/herdr-remote/bin/herdr-remote.js' admin-shell",
  );
});

function fakeHerdr(shellAfterPolls = 2) {
  const calls = [];
  let polls = 0;
  const request = async (_socketPath, method, params) => {
    calls.push({ method, params });
    if (method === 'tab.create')
      return { tab: { tab_id: 'w1:t4' }, root_pane: { pane_id: 'w1:p9' } };
    if (method === 'pane.process_info') {
      polls += 1;
      return {
        process_info: {
          foreground_processes: polls >= shellAfterPolls ? [{ name: 'powershell.exe' }] : [],
        },
      };
    }
    return {};
  };
  return { calls, request };
}

test('an admin tab opens focused, and admin-shell is typed once its shell runs', async () => {
  const herdr = fakeHerdr();
  await openAdminTab({
    socketPath: 'herdr.sock',
    label: 'Admin',
    request: herdr.request,
    brokerReady: async () => true,
  });
  assert.deepEqual(
    herdr.calls.map((call) => call.method),
    ['tab.create', 'tab.focus', 'pane.process_info', 'pane.process_info', 'pane.send_input'],
  );
  assert.deepEqual(herdr.calls[0].params, {
    label: 'Admin',
    focus: false,
    env: { [ADMIN_TAB_ENV]: '1' },
  });
  assert.deepEqual(herdr.calls[1].params, { tab_id: 'w1:t4' });
  const typed = herdr.calls[4].params;
  assert.equal(typed.pane_id, 'w1:p9');
  assert.match(typed.text, /^& '.+' '.+herdr-remote\.js' admin-shell$/);
  assert.deepEqual(typed.keys, ['enter']);
});

test('no tab opens while the admin broker is not running', async () => {
  const herdr = fakeHerdr();
  await assert.rejects(
    openAdminTab({
      socketPath: 'herdr.sock',
      label: 'Admin',
      request: herdr.request,
      brokerReady: async () => false,
    }),
    { code: 'admin_broker_unavailable' },
  );
  assert.equal(herdr.calls.length, 0);
});
