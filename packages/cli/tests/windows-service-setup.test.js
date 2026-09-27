import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderSetServiceAccountScript } from '../src/keepalive/windows-service-setup.js';

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
