import assert from 'node:assert/strict';
import { test } from 'vitest';
import { runPaneAction, runPaneActionFor } from '../src/connector/pane-action.js';

function fakeHerdr(failAt = null) {
  const calls = [];
  const request = async (_socketPath, method, params) => {
    calls.push({ method, params });
    if (method === failAt) throw new Error('socket gone');
    return {};
  };
  return { calls, request };
}

test('every action focuses the pane first, and focus alone sends no keys', async () => {
  const herdr = fakeHerdr();
  await runPaneAction({
    socketPath: 'herdr.sock',
    paneId: 'w1:p9',
    action: 'focus',
    request: herdr.request,
  });
  assert.deepEqual(herdr.calls, [{ method: 'pane.focus', params: { pane_id: 'w1:p9' } }]);
});

test('approve, reject and interrupt press their canned key after the focus', async () => {
  const keys = { approve: ['enter'], reject: ['escape'], interrupt: ['ctrl+c'] };
  for (const [action, expected] of Object.entries(keys)) {
    const herdr = fakeHerdr();
    await runPaneAction({
      socketPath: 'herdr.sock',
      paneId: 'w1:p9',
      action,
      request: herdr.request,
    });
    assert.deepEqual(
      herdr.calls.map((call) => call.method),
      ['pane.focus', 'pane.send_keys'],
      action,
    );
    assert.deepEqual(herdr.calls[1].params, { pane_id: 'w1:p9', keys: expected }, action);
  }
});

test('a failed action is reported back to the window that asked', async () => {
  const sent = [];
  await runPaneActionFor(
    'stream-1',
    { type: 'pane_action', paneId: 'w1:p9', action: 'approve' },
    {
      socketPath: 'herdr.sock',
      send: (payload) => sent.push(payload),
      // The focus itself failing still reaches the window; nothing silently
      // looks like the pane answered.
      request: async () => {
        throw new Error('socket gone');
      },
    },
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'error');
  assert.equal(sent[0].clientId, 'stream-1');
  assert.equal(sent[0].code, 'pane_action_failed');
  assert.match(sent[0].message, /socket gone/);
});

test('a successful action sends nothing back', async () => {
  const herdr = fakeHerdr();
  const sent = [];
  await runPaneActionFor(
    'stream-1',
    { type: 'pane_action', paneId: 'w1:p9', action: 'reject' },
    {
      socketPath: 'herdr.sock',
      send: (payload) => sent.push(payload),
      request: herdr.request,
    },
  );
  assert.equal(sent.length, 0);
});
