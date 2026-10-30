import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { ToolForward, shimScript } from '../src/connector/tool-forward.js';
import { runLinkShim } from '../src/connector/link-shim.js';
import { runClipboardShim } from '../src/connector/clipboard-shim.js';
import { tempDir } from './helpers.js';

const unix = process.platform !== 'win32';

/** A forwarder with its relay able to take every tool, and what it sent. */
async function forwarder(
  t,
  { streams = ['session-1'], capabilities = ['open_link', 'clipboard_forward'] } = {},
) {
  const directory = tempDir(t, 'herdr-remote-tools-');
  const sent = [];
  const tools = new ToolForward(
    { directory, node: '/usr/bin/node', entry: '/opt/herdr-remote/bin/herdr-remote.js' },
    (payload) => sent.push(payload),
    (streamId) => streams.includes(streamId),
  );
  t.onTestFinished(() => tools.stop());
  tools.setRelayCapabilities(capabilities);
  // Listening, and closing the socket to other accounts, take a few turns.
  const listening = () =>
    fs.existsSync(tools.socketPath) && (fs.statSync(tools.socketPath).mode & 0o777) === 0o600;
  for (let i = 0; capabilities && i < 50 && !listening(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { directory, tools, sent };
}

/** A real tool the stand-ins should fall back to, on a PATH of its own. */
function realTool(t, name = 'xdg-open') {
  const directory = tempDir(t, 'herdr-remote-real-tool-');
  const file = path.join(directory, name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { directory, file };
}

function recordRuns() {
  const runs = [];
  const run = (command, args, env, input) => {
    runs.push({ command, args, env, input });
    return 0;
  };
  return { runs, run };
}

/** A stdin that delivers `text`, for the clipboard write stand-ins. */
function clipboardWrite(text) {
  return {
    stdin: Readable.from([text]),
    stdout: { write() {} },
  };
}

test.runIf(unix)(
  "a window's Herdr client finds the stand-ins first and names its window",
  async (t) => {
    const { tools } = await forwarder(t);

    const env = tools.env('session-1', '/usr/local/bin:/usr/bin');

    assert.equal(env.PATH, `${tools.shimDir}:/usr/local/bin:/usr/bin`);
    assert.equal(env.HERDR_REMOTE_TOOL_STREAM, 'session-1');
    assert.equal(env.HERDR_REMOTE_TOOL_SOCKET, tools.socketPath);
    for (const name of ['xdg-open', 'open']) {
      const file = path.join(tools.shimDir, name);
      assert.equal(
        fs.readFileSync(file, 'utf8'),
        shimScript('/usr/bin/node', '/opt/herdr-remote/bin/herdr-remote.js', 'open-link'),
      );
      assert.ok(fs.statSync(file).mode & 0o100, `${name} must be executable`);
    }
    for (const name of ['wl-copy', 'wl-paste', 'xclip', 'xsel', 'pbcopy', 'pbpaste']) {
      const file = path.join(tools.shimDir, name);
      assert.equal(
        fs.readFileSync(file, 'utf8'),
        shimScript('/usr/bin/node', '/opt/herdr-remote/bin/herdr-remote.js', 'clipboard'),
      );
      assert.ok(fs.statSync(file).mode & 0o100, `${name} must be executable`);
    }
    assert.equal(fs.statSync(tools.socketPath).mode & 0o777, 0o600);
  },
);

test.runIf(unix)(
  'a relay that opens links but forwards no clipboard gets only the openers',
  async (t) => {
    const { tools } = await forwarder(t, { capabilities: ['open_link'] });
    assert.ok(fs.existsSync(path.join(tools.shimDir, 'xdg-open')));
    assert.ok(!fs.existsSync(path.join(tools.shimDir, 'wl-copy')));
    assert.equal(tools.env('session-1', '/usr/bin').HERDR_REMOTE_TOOL_SOCKET, tools.socketPath);
  },
);

test('the stand-in passes its own path and every argument through, quoted for sh', () => {
  assert.equal(
    shimScript('/usr/bin/node', "/home/o'brien/herdr-remote.js", 'open-link'),
    `#!/bin/sh\nexec '/usr/bin/node' '/home/o'\\''brien/herdr-remote.js' 'open-link' "$0" "$@"\n`,
  );
});

test.runIf(unix)('a relay that cannot take tools leaves them on this workstation', async (t) => {
  const old = await forwarder(t, { capabilities: null });
  assert.deepEqual(old.tools.env('session-1', '/usr/bin'), {});

  const windows = new ToolForward(
    { directory: tempDir(t, 'herdr-remote-tools-'), platform: 'win32' },
    () => {},
    () => true,
  );
  windows.setRelayCapabilities(['open_link', 'clipboard_forward']);
  assert.deepEqual(windows.env('session-1', 'C:\\bin'), {});

  // A connection to the relay that has gone takes the tools with it.
  const { tools } = await forwarder(t);
  tools.setRelayCapabilities(undefined);
  assert.deepEqual(tools.env('session-1', '/usr/bin'), {});
});

test.runIf(unix)('a web link a window clicked goes to that window and nowhere else', async (t) => {
  const { tools, sent } = await forwarder(t);
  const real = realTool(t);
  const { runs, run } = recordRuns();
  const env = tools.env('session-1', real.directory);

  const code = await runLinkShim(
    [path.join(tools.shimDir, 'xdg-open'), 'https://example.com/pr/7'],
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
  const { tools, sent } = await forwarder(t);
  const real = realTool(t);
  const shim = path.join(tools.shimDir, 'xdg-open');

  // The window has gone, it is not a web link, or it is not a lone link.
  for (const [stream, args] of [
    ['session-gone', ['https://example.com/']],
    ['session-1', ['file:///etc/hosts']],
    ['session-1', ['--version']],
    ['session-1', ['https://example.com/', 'https://example.org/']],
  ]) {
    const { runs, run } = recordRuns();
    const env = { ...tools.env('session-1', real.directory), HERDR_REMOTE_TOOL_STREAM: stream };
    assert.equal(await runLinkShim([shim, ...args], { env, run }), 0);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, real.file);
    assert.deepEqual(runs[0].args, args);
    // The real command and whatever it starts never meet the stand-ins again.
    assert.equal(runs[0].env.PATH, real.directory);
    assert.equal(runs[0].env.HERDR_REMOTE_TOOL_STREAM, undefined);
    assert.equal(runs[0].env.HERDR_REMOTE_TOOL_SOCKET, undefined);
  }
  assert.deepEqual(sent, []);
});

test.runIf(unix)(
  'a connector that is not listening costs nothing but the real command',
  async (t) => {
    const directory = tempDir(t, 'herdr-remote-tools-');
    const real = realTool(t, 'open');
    const { runs, run } = recordRuns();
    const env = {
      PATH: `${path.join(directory, 'tool-shims')}:${real.directory}`,
      HERDR_REMOTE_TOOL_STREAM: 'session-1',
      HERDR_REMOTE_TOOL_SOCKET: path.join(directory, 'tools.sock'),
    };

    const code = await runLinkShim(
      [path.join(directory, 'tool-shims', 'open'), 'https://example.com/'],
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

test.runIf(unix)('a clipboard write reaches the window that owns the stream', async (t) => {
  const { tools, sent } = await forwarder(t);
  const real = realTool(t, 'wl-copy');
  const { runs, run } = recordRuns();
  const env = tools.env('session-1', real.directory);

  const code = await runClipboardShim(
    [path.join(tools.shimDir, 'wl-copy'), '--type', 'text/plain;charset=utf-8'],
    { env, run, ...clipboardWrite('copied in herdr') },
  );

  assert.equal(code, 0);
  assert.deepEqual(sent, [
    { type: 'clipboard_write', clientId: 'session-1', text: 'copied in herdr' },
  ]);
  assert.deepEqual(runs, []);
});

test.runIf(unix)(
  'a clipboard read asks the window and prints what that window answers',
  async (t) => {
    const { tools, sent } = await forwarder(t);
    const real = realTool(t, 'wl-paste');
    const { runs, run } = recordRuns();
    const env = tools.env('session-1', real.directory);
    const output = [];
    const stdout = { write: (chunk) => output.push(chunk) };

    const pending = runClipboardShim(
      [path.join(tools.shimDir, 'wl-paste'), '--type', 'text/plain;charset=utf-8'],
      { env, run, stdin: Readable.from(['']), stdout },
    );
    // The request reached the relay-facing side, so the window answers it.
    for (let i = 0; i < 50 && sent.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'clipboard_read');
    assert.equal(sent[0].clientId, 'session-1');
    tools.resolveClipboardReadReply(sent[0].requestId, 'from the phone');

    assert.equal(await pending, 0);
    assert.deepEqual(output, ['from the phone']);
    assert.deepEqual(runs, []);
  },
);

test.runIf(unix)(
  'a clipboard read nobody answers falls back to the real tool with its arguments',
  async (t) => {
    const { tools } = await forwarder(t);
    const real = realTool(t, 'wl-paste');
    const { runs, run } = recordRuns();
    // The window's stream is gone: the connector answers nothing and the
    // socket request fails fast.
    const env = { ...tools.env('session-1', real.directory), HERDR_REMOTE_TOOL_STREAM: 'gone' };
    const args = ['--type', 'text/plain;charset=utf-8'];

    const code = await runClipboardShim([path.join(tools.shimDir, 'wl-paste'), ...args], {
      env,
      run,
      stdin: Readable.from(['']),
      stdout: { write() {} },
    });

    assert.equal(code, 0);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, real.file);
    assert.deepEqual(runs[0].args, args);
  },
);

test.runIf(unix)(
  'a clipboard write nobody takes still reaches the real tool, text and all',
  async (t) => {
    const { tools } = await forwarder(t);
    const real = realTool(t, 'xsel');
    const { runs, run } = recordRuns();
    const env = { ...tools.env('session-1', real.directory), HERDR_REMOTE_TOOL_STREAM: 'gone' };
    const args = ['--clipboard', '--input'];

    const code = await runClipboardShim([path.join(tools.shimDir, 'xsel'), ...args], {
      env,
      run,
      stdin: Readable.from(['fallback text']),
      stdout: { write() {} },
    });

    assert.equal(code, 0);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, real.file);
    assert.deepEqual(runs[0].args, args);
    assert.equal(runs[0].input, 'fallback text');
  },
);
