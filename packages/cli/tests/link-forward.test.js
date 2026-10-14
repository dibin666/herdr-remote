import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LinkForward, shimScript } from '../src/connector/link-forward.js';
import { runLinkShim } from '../src/connector/link-shim.js';
import { tempDir } from './helpers.js';

const unix = process.platform !== 'win32';

/** A forwarder with its relay able to take links, and what it sent. */
async function forwarder(t, { streams = ['session-1'], capabilities = ['open_link'] } = {}) {
  const directory = tempDir(t, 'herdr-remote-links-');
  const sent = [];
  const links = new LinkForward(
    { directory, node: '/usr/bin/node', entry: '/opt/herdr-remote/bin/herdr-remote.js' },
    (payload) => sent.push(payload),
    (streamId) => streams.includes(streamId),
  );
  t.onTestFinished(() => links.stop());
  links.setRelayCapabilities(capabilities);
  // Listening, and closing the socket to other accounts, take a few turns.
  const listening = () =>
    fs.existsSync(links.socketPath) && (fs.statSync(links.socketPath).mode & 0o777) === 0o600;
  for (let i = 0; capabilities && i < 50 && !listening(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { directory, links, sent };
}

/** A real opener the stand-ins should fall back to, on a PATH of its own. */
function realOpener(t, name = 'xdg-open') {
  const directory = tempDir(t, 'herdr-remote-real-opener-');
  const file = path.join(directory, name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { directory, file };
}

function recordRuns() {
  const runs = [];
  const run = (command, args, env) => {
    runs.push({ command, args, env });
    return 0;
  };
  return { runs, run };
}

test.runIf(unix)(
  "a window's Herdr client finds the stand-ins first and names its window",
  async (t) => {
    const { links } = await forwarder(t);

    const env = links.env('session-1', '/usr/local/bin:/usr/bin');

    assert.equal(env.PATH, `${links.shimDir}:/usr/local/bin:/usr/bin`);
    assert.equal(env.HERDR_REMOTE_LINK_STREAM, 'session-1');
    assert.equal(env.HERDR_REMOTE_LINK_SOCKET, links.socketPath);
    for (const name of ['xdg-open', 'open']) {
      const file = path.join(links.shimDir, name);
      assert.equal(
        fs.readFileSync(file, 'utf8'),
        shimScript('/usr/bin/node', '/opt/herdr-remote/bin/herdr-remote.js'),
      );
      assert.ok(fs.statSync(file).mode & 0o100, `${name} must be executable`);
    }
    assert.equal(fs.statSync(links.socketPath).mode & 0o777, 0o600);
  },
);

test('the stand-in passes its own path and every argument through, quoted for sh', () => {
  assert.equal(
    shimScript('/usr/bin/node', "/home/o'brien/herdr-remote.js"),
    `#!/bin/sh\nexec '/usr/bin/node' '/home/o'\\''brien/herdr-remote.js' open-link "$0" "$@"\n`,
  );
});

test.runIf(unix)('a relay that cannot take links leaves windows opening them here', async (t) => {
  const old = await forwarder(t, { capabilities: null });
  assert.deepEqual(old.links.env('session-1', '/usr/bin'), {});

  const windows = new LinkForward(
    { directory: tempDir(t, 'herdr-remote-links-'), platform: 'win32' },
    () => {},
    () => true,
  );
  windows.setRelayCapabilities(['open_link']);
  assert.deepEqual(windows.env('session-1', 'C:\\bin'), {});

  // A connection to the relay that has gone takes the links with it.
  const { links } = await forwarder(t);
  links.setRelayCapabilities(undefined);
  assert.deepEqual(links.env('session-1', '/usr/bin'), {});
});

test.runIf(unix)('a web link a window clicked goes to that window and nowhere else', async (t) => {
  const { links, sent } = await forwarder(t);
  const real = realOpener(t);
  const { runs, run } = recordRuns();
  const env = links.env('session-1', real.directory);

  const code = await runLinkShim(
    [path.join(links.shimDir, 'xdg-open'), 'https://example.com/pr/7'],
    {
      env,
      run,
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(sent, [
    { type: 'open_link', clientId: 'session-1', url: 'https://example.com/pr/7' },
  ]);
  assert.deepEqual(runs, []);
});

test.runIf(unix)('anything the window cannot take opens with the real command', async (t) => {
  const { links, sent } = await forwarder(t);
  const real = realOpener(t);
  const shim = path.join(links.shimDir, 'xdg-open');

  // The window has gone, it is not a web link, or it is not a lone link.
  for (const [stream, args] of [
    ['session-gone', ['https://example.com/']],
    ['session-1', ['file:///etc/hosts']],
    ['session-1', ['--version']],
    ['session-1', ['https://example.com/', 'https://example.org/']],
  ]) {
    const { runs, run } = recordRuns();
    const env = { ...links.env('session-1', real.directory), HERDR_REMOTE_LINK_STREAM: stream };
    assert.equal(await runLinkShim([shim, ...args], { env, run }), 0);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, real.file);
    assert.deepEqual(runs[0].args, args);
    // The real command and whatever it starts never meet the stand-ins again.
    assert.equal(runs[0].env.PATH, real.directory);
    assert.equal(runs[0].env.HERDR_REMOTE_LINK_STREAM, undefined);
    assert.equal(runs[0].env.HERDR_REMOTE_LINK_SOCKET, undefined);
  }
  assert.deepEqual(sent, []);
});

test.runIf(unix)(
  'a connector that is not listening costs nothing but the real command',
  async (t) => {
    const directory = tempDir(t, 'herdr-remote-links-');
    const real = realOpener(t, 'open');
    const { runs, run } = recordRuns();
    const env = {
      PATH: `${path.join(directory, 'link-shims')}:${real.directory}`,
      HERDR_REMOTE_LINK_STREAM: 'session-1',
      HERDR_REMOTE_LINK_SOCKET: path.join(directory, 'links.sock'),
    };

    const code = await runLinkShim(
      [path.join(directory, 'link-shims', 'open'), 'https://example.com/'],
      {
        env,
        run,
      },
    );

    assert.equal(code, 0);
    assert.deepEqual(
      runs.map(({ command, args }) => ({ command, args })),
      [{ command: real.file, args: ['https://example.com/'] }],
    );
  },
);
