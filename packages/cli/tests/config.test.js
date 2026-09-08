'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  advertisedHost,
  bindAddress,
  configPath,
  loadConfig,
  migrateLegacyConfig,
  resolveAdminOrigin,
  resolveHostRelayUrl,
  resolvePublicUrl,
  runsLocalRelay,
  validate,
} = require('../src/config');

function withEnvironment(overrides, run) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withConfig(contents, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-config-'));
  return withEnvironment(
    { HERDR_REMOTE_CONFIG_DIR: directory, HERDR_SOCKET_PATH: undefined, RELAY_PORT: undefined, HERDR_REMOTE_MODE: undefined },
    () => {
      try {
        if (contents !== null) {
          fs.mkdirSync(directory, { recursive: true });
          fs.writeFileSync(configPath(), JSON.stringify(contents));
        }
        return run(directory);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
}

test('a fresh install is loopback only', () => {
  withConfig(null, () => {
    const config = loadConfig();
    assert.equal(config.relay.mode, 'local');
    assert.equal(bindAddress(config), '127.0.0.1');
    assert.equal(resolvePublicUrl(config), 'http://127.0.0.1:8787');
    assert.equal(runsLocalRelay(config), true);
  });
});

test('lan mode binds every interface and advertises the chosen address', () => {
  withConfig({ relay: { mode: 'lan', port: 9000, lanHost: '100.64.0.7' } }, () => {
    const config = loadConfig();
    assert.equal(bindAddress(config), '0.0.0.0');
    assert.equal(advertisedHost(config), '100.64.0.7');
    assert.equal(resolvePublicUrl(config), 'http://100.64.0.7:9000');
    // Admin calls still go over loopback even when the relay listens wider.
    assert.equal(resolveAdminOrigin(config), 'http://127.0.0.1:9000');
  });
});

test('lan mode falls back to a discovered address when the pinned one is gone', () => {
  withConfig({ relay: { mode: 'lan', port: 8787, lanHost: '' } }, () => {
    const config = loadConfig();
    assert.equal(resolvePublicUrl(config, '192.168.1.20'), 'http://192.168.1.20:8787');
    // With nothing to fall back to, loopback beats advertising 0.0.0.0.
    assert.equal(resolvePublicUrl(config, null), 'http://127.0.0.1:8787');
  });
});

test('an unspecified bind wildcard is never used as a browser URL', () => {
  withConfig({ relay: { mode: 'lan', port: 8787, publicUrl: 'http://0.0.0.0:8787' } }, () => {
    const config = loadConfig();
    assert.equal(config.relay.publicUrl, '');
    assert.equal(resolvePublicUrl(config, '192.168.1.20'), 'http://192.168.1.20:8787');
  });
});

test('a stale loopback LAN browser address is cleared and replaced by a real interface', () => {
  withConfig({ relay: { mode: 'lan', port: 8787, lanHost: '127.0.0.1' } }, () => {
    const config = loadConfig();
    assert.equal(config.relay.lanHost, '');
    assert.equal(resolvePublicUrl(config, '192.168.6.144'), 'http://192.168.6.144:8787');
    assert.equal(advertisedHost({ relay: { mode: 'lan', lanHost: '127.0.0.1' } }, '192.168.6.144'), '192.168.6.144');
  });
});

test('remote mode never binds locally and points the host connector outward', () => {
  withConfig({ relay: { mode: 'remote', remoteUrl: 'wss://herdr.example.com' } }, () => {
    const config = loadConfig();
    assert.equal(runsLocalRelay(config), false);
    assert.equal(resolveHostRelayUrl(config), 'wss://herdr.example.com/ws/host');
    assert.equal(resolvePublicUrl(config), 'https://herdr.example.com');
    assert.equal(resolveAdminOrigin(config), 'https://herdr.example.com');
  });
});

test('remote mode without a URL degrades to local instead of dialling nowhere', () => {
  withConfig({ relay: { mode: 'remote', remoteUrl: '' } }, () => {
    const config = loadConfig();
    assert.equal(config.relay.mode, 'local');
    assert.equal(runsLocalRelay(config), true);
  });
});

test('a non-loopback bind address is honoured rather than rewritten', () => {
  // The 0.1 config validator forced relay.host back to 127.0.0.1, which made
  // Tailscale and LAN access impossible no matter what the user configured.
  withConfig({ relay: { mode: 'lan', lanHost: '100.100.100.100' } }, () => {
    const config = loadConfig();
    assert.equal(config.relay.lanHost, '100.100.100.100');
    assert.equal(bindAddress(config), '0.0.0.0');
  });
});

test('0.1 configs are read without losing their meaning', () => {
  withConfig({ relay: { local: false, url: 'ws://relay.example.com:8787', publicUrl: 'https://relay.example.com' } }, () => {
    const config = loadConfig();
    assert.equal(config.relay.mode, 'remote');
    assert.equal(config.relay.remoteUrl, 'ws://relay.example.com:8787');
    assert.equal(resolvePublicUrl(config), 'https://relay.example.com');
  });

  withConfig({ relay: { local: true, host: '0.0.0.0', port: 8787 } }, () => {
    assert.equal(loadConfig().relay.mode, 'lan');
  });

  // The old default publicUrl was the loopback URL; keeping it would pin the
  // address and defeat derivation after a mode change.
  withConfig({ relay: { local: true, host: '127.0.0.1', publicUrl: 'http://127.0.0.1:8787' } }, () => {
    const config = loadConfig();
    assert.equal(config.relay.publicUrl, '');
    assert.equal(config.relay.mode, 'local');
  });
});

test('the plugin-scoped config from an older install is imported once', () => {
  const legacyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-legacy-'));
  const targetDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-target-'));
  fs.writeFileSync(path.join(legacyDirectory, 'config.json'), JSON.stringify({ relay: { port: 9999 } }));

  withEnvironment({ HERDR_REMOTE_CONFIG_DIR: targetDirectory, HERDR_PLUGIN_CONFIG_DIR: legacyDirectory }, () => {
    try {
      const first = migrateLegacyConfig();
      assert.equal(first.migrated, true);
      assert.equal(loadConfig().relay.port, 9999);

      // Running again must not clobber edits made since the import.
      fs.writeFileSync(configPath(), JSON.stringify({ relay: { port: 7777 } }));
      const second = migrateLegacyConfig();
      assert.equal(second.migrated, false);
      assert.equal(loadConfig().relay.port, 7777);
    } finally {
      fs.rmSync(legacyDirectory, { recursive: true, force: true });
      fs.rmSync(targetDirectory, { recursive: true, force: true });
    }
  });
});

test('the config directory ignores the Herdr plugin variable', () => {
  // Honouring $HERDR_PLUGIN_CONFIG_DIR gave "herdr-remote" in a shell and the
  // same tool inside a Herdr pane two different config files.
  withConfig({ relay: { port: 4242 } }, (directory) => {
    withEnvironment({ HERDR_PLUGIN_CONFIG_DIR: '/nonexistent/plugin/config' }, () => {
      assert.equal(configPath(), path.join(directory, 'config.json'));
      assert.equal(loadConfig().relay.port, 4242);
    });
  });
});

test('invalid values fall back to the defaults instead of throwing', () => {
  withConfig({ relay: { mode: 'sideways', port: 999999 }, ui: { language: 'klingon' } }, () => {
    const config = loadConfig();
    assert.equal(config.relay.mode, 'local');
    assert.equal(config.relay.port, 8787);
    assert.equal(config.ui.language, 'auto');
  });
});

test('a removed --no-session argument is stripped from herdr args while preserving others', () => {
  withConfig({ herdr: { args: ['--foo', '--no-session', '--bar'] } }, () => {
    const config = loadConfig();
    assert.deepEqual(config.herdr.args, ['--foo', '--bar']);
  });

  const parsed = validate({
    relay: { mode: 'local' },
    ui: { language: 'auto' },
    keepalive: { manager: 'auto' },
    cleanup: {},
    auth: {},
    herdr: { args: ['--first', '--no-session', '--second'] },
  });
  assert.deepEqual(parsed.herdr.args, ['--first', '--second']);
});
