// Shared by the cli tests: temporary directories that clean themselves up.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A temporary directory, removed when the test finishes. */
export function tempDir(t, prefix = 'herdr-remote-test-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * Points the config and state directories at a fresh temporary directory for
 * one test, so nothing reads or writes the real home.
 */
export function isolateState(t) {
  const directory = tempDir(t, 'herdr-remote-state-');
  const previous = {
    HERDR_REMOTE_CONFIG_DIR: process.env.HERDR_REMOTE_CONFIG_DIR,
    HERDR_REMOTE_STATE_DIR: process.env.HERDR_REMOTE_STATE_DIR,
  };
  process.env.HERDR_REMOTE_CONFIG_DIR = path.join(directory, 'config');
  process.env.HERDR_REMOTE_STATE_DIR = path.join(directory, 'state');
  fs.mkdirSync(process.env.HERDR_REMOTE_CONFIG_DIR);
  fs.mkdirSync(process.env.HERDR_REMOTE_STATE_DIR);
  t.onTestFinished(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return directory;
}
