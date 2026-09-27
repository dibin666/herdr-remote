import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderAdminBrokerElevationScript } from '../src/connector/admin-broker-setup.js';

test('TUI setup requests UAC without combining RunAs with redirected streams', () => {
  const script = renderAdminBrokerElevationScript({
    action: 'install',
    nodePath: "C:\\Program Files\\Dibin's Node\\node.exe",
    entryPoint: 'C:\\Program Files\\Herdr Remote\\bin\\herdr-remote.js',
  });

  assert.match(script, /-Verb RunAs -Wait -PassThru -WindowStyle Hidden/);
  assert.match(script, /Dibin''s Node/);
  assert.match(script, /admin-broker install --elevated/);
  assert.match(script, /HResult -band 65535\) -eq 1223/);
  assert.doesNotMatch(script, /RedirectStandard(?:Output|Error)/);
});
