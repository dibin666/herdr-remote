#!/usr/bin/env bash
set -euo pipefail

# Exercise an installed package: an archive listing cannot tell whether a
# bundle loads, nor whether npm installed what the bundle left to it.
archive="$(realpath "${1:?CLI tarball required}")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export HERDR_REMOTE_CONFIG_DIR="$work/config"
export HERDR_REMOTE_STATE_DIR="$work/state"
export HERDR_REMOTE_UPDATE_CHECK=0
export npm_config_cache="$work/cache"
export npm_config_userconfig="$work/npmrc"
touch "$npm_config_userconfig"
npm install --global --prefix "$work/install" --no-audit --no-fund "$archive"
cli="$work/install/lib/node_modules/herdr-remote"
relay="$cli/node_modules/herdr-remote-relay/bin/herdr-remote-relay.js"

expected="$(tar -xOzf "$archive" package/package.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')"
test "$(node "$cli/bin/herdr-remote.js" --version)" = "$expected"
test "$(node "$relay" --version)" = "$expected"
# Loads the lifecycle and service chunks.
node "$cli/bin/herdr-remote.js" status --json >/dev/null

# The TUI (ink, react, yoga's wasm) only renders on a terminal.
if command -v script >/dev/null; then
  screen="$(script -qec "timeout 5 node '$cli/bin/herdr-remote.js'" /dev/null || true)"
  grep -q '╭' <<<"$screen" || { echo "::error::the TUI did not render"; echo "$screen"; exit 1; }
fi

node --input-type=module - "$cli" "$relay" <<'JS'
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';

const [cli, relayBin] = process.argv.slice(2);
const require = createRequire(path.join(cli, 'package.json'));

// postinstall leaves node-pty only what this platform loads.
const ptyRoot = path.dirname(require.resolve('node-pty/package.json'));
const prebuilds = path.join(ptyRoot, 'prebuilds');
const left = fs.existsSync(prebuilds) ? fs.readdirSync(prebuilds) : [];
assert.ok(left.every((name) => name === `${process.platform}-${process.arch}`), `prebuilds: ${left}`);

// The one dependency npm installs works.
const pty = require('node-pty');
const output = await new Promise((resolve, reject) => {
  let text = '';
  const child = pty.spawn('/bin/sh', ['-c', 'echo pty-ok'], { cols: 80, rows: 24 });
  child.onData((data) => {
    text += data;
  });
  child.onExit(() => resolve(text));
  setTimeout(() => reject(new Error('node-pty did not exit')), 10_000);
});
assert.match(output, /pty-ok/);

new WebAssembly.Module(fs.readFileSync(path.join(cli, 'dist', 'harfbuzz-subset.wasm')));

const port = await new Promise((resolve) => {
  const server = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const relay = spawn(process.execPath, [relayBin, '--port', String(port), '--deployment-mode', 'local',
  '--public-url', `http://127.0.0.1:${port}`, '--state-file', path.join(process.env.HERDR_REMOTE_STATE_DIR, 'relay.json')],
  { stdio: 'inherit' });
try {
  let health = null;
  for (let attempt = 0; attempt < 50 && !health?.ok; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    health = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json()).catch(() => null);
  }
  assert.ok(health?.ok, 'the relay answers /healthz');
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<html/);
} finally {
  relay.kill();
}
JS
echo "verified herdr-remote $expected"
