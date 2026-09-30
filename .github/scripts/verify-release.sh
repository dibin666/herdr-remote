#!/usr/bin/env bash
set -euo pipefail

# Exercise an installed package: archive listings cannot detect omitted bundled dependencies.
archive="$(realpath "${1:?CLI tarball required}")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export HERDR_REMOTE_CONFIG_DIR="$work/config"
export HERDR_REMOTE_STATE_DIR="$work/state"
export npm_config_cache="$work/cache"
export npm_config_userconfig="$work/npmrc"
touch "$npm_config_userconfig"
npm install --global --prefix "$work/install" --no-audit --no-fund "$archive"
cli="$work/install/lib/node_modules/herdr-remote"
node "$cli/bin/herdr-remote.js" --version
node "$cli/node_modules/herdr-remote-relay/bin/herdr-remote-relay.js" --version
node --input-type=module - "$cli" <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const cli = process.argv[2];
const relay = path.join(cli, 'node_modules/herdr-remote-relay');
assert.ok(fs.existsSync(path.join(relay, 'web/dist/index.html')));
const { RelayServer } = await import(pathToFileURL(path.join(relay, 'dist/relay-server.js')));
const server = new RelayServer({ relay: { mode: 'local', publicUrl: 'http://127.0.0.1' } }, {
  stateFile: path.join(process.env.HERDR_REMOTE_STATE_DIR, 'relay.json'),
});
try {
  const address = await server.listen(0, '127.0.0.1');
  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<html/);
} finally {
  await server.close();
}
JS
