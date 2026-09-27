import { test } from 'vitest';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { configDir, stateDir } from '../src/paths.js';

test('Windows config and state directories follow AppData conventions', () => {
  const appData = path.join(os.tmpdir(), 'herdr-remote-roaming');
  const localAppData = path.join(os.tmpdir(), 'herdr-remote-local');

  assert.equal(configDir({ APPDATA: appData }, 'win32'), path.join(appData, 'herdr-remote'));
  assert.equal(
    stateDir({ LOCALAPPDATA: localAppData }, 'win32'),
    path.join(localAppData, 'herdr-remote'),
  );
});

test('Windows directories fall back under the home directory when AppData is missing', () => {
  assert.equal(
    configDir({}, 'win32'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'herdr-remote'),
  );
  assert.equal(stateDir({}, 'win32'), path.join(os.homedir(), 'AppData', 'Local', 'herdr-remote'));
});

test('explicit config and state directory overrides take priority', () => {
  const env = {
    HERDR_REMOTE_CONFIG_DIR: path.join(os.tmpdir(), 'herdr-remote-config-override'),
    HERDR_REMOTE_STATE_DIR: path.join(os.tmpdir(), 'herdr-remote-state-override'),
    APPDATA: path.join(os.tmpdir(), 'herdr-remote-roaming'),
    LOCALAPPDATA: path.join(os.tmpdir(), 'herdr-remote-local'),
  };

  assert.equal(configDir(env, 'win32'), env.HERDR_REMOTE_CONFIG_DIR);
  assert.equal(stateDir(env, 'win32'), env.HERDR_REMOTE_STATE_DIR);
});

test('Linux config and state directories remain unchanged', () => {
  assert.equal(configDir({}, 'linux'), path.join(os.homedir(), '.config', 'herdr-remote'));
  assert.equal(stateDir({}, 'linux'), path.join(os.homedir(), '.local', 'state', 'herdr-remote'));
});
