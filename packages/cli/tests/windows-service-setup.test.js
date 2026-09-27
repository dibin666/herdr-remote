import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  configureAndStartServiceAccount,
  renderSetServiceAccountScript,
} from '../src/keepalive/windows-service-setup.js';

test('service account script reads the secret from stdin and escapes its account and ID', () => {
  const password = 'Secret "Passphrase" 123';
  const script = renderSetServiceAccountScript({
    id: "herdr-remote-O'Neil",
    account: "DOMAIN\\O'Neil",
  });

  assert.match(script, /\[Console\]::In\.ReadLine\(\)/);
  assert.match(script, /Name='herdr-remote-O''Neil'/);
  assert.match(script, /StartName = 'DOMAIN\\O''Neil'/);
  assert.match(script, /StartPassword = \$password/);
  assert.equal(script.includes(password), false);
});

test('service installation tries an empty account password before prompting', async () => {
  const passwords = [];
  let promptCount = 0;

  const started = await configureAndStartServiceAccount(
    'herdr-remote-alice',
    'alice',
    (key) => key,
    {
      setAccount: (_id, _account, password) => {
        passwords.push(password);
        return { status: 0, stdout: '', stderr: '' };
      },
      start: () => ({ code: 0, stdout: '', stderr: '' }),
      prompt: async () => {
        promptCount += 1;
        return null;
      },
      write: () => {},
    },
  );

  assert.equal(started, true);
  assert.deepEqual(passwords, ['']);
  assert.equal(promptCount, 0);
});

test('service installation prompts only after Windows rejects the empty password', async () => {
  const passwords = [];
  const messages = [];

  const started = await configureAndStartServiceAccount(
    'herdr-remote-alice',
    'alice',
    (key) => key,
    {
      setAccount: (_id, _account, password) => {
        passwords.push(password);
        return { status: 0, stdout: '', stderr: '' };
      },
      start: () => ({ code: passwords.length === 1 ? 1069 : 0, stdout: '', stderr: '' }),
      prompt: async () => 'real-account-password',
      write: (message) => messages.push(message),
    },
  );

  assert.equal(started, true);
  assert.deepEqual(passwords, ['', 'real-account-password']);
  assert.deepEqual(messages, ['keepalive.passwordRejected\n']);
});
