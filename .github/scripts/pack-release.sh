#!/usr/bin/env bash
#
# Build the release assets: a self-contained CLI tarball, the relay tarball,
# and the latest.json pointer that clients read to find the newest release.
#
# The CLI has to ship the relay inside it. In the workspace the relay is a
# symlink, and `npm pack` does not bundle symlinked dependencies (the bundled
# list comes out empty), so a plain CLI tarball would need the relay from some
# registry at install time. Instead the relay's own tarball is unpacked into the
# CLI's `node_modules/` and the manifest is rewritten to pin and bundle it; a
# second `npm pack` then produces a tarball that installs from one file.
# `ws` stays an ordinary dependency of both packages and resolves normally.
#
# Assets written to <dist-dir> (each tarball also under a versionless name, so
# `releases/latest/download/<name>.tgz` is a stable URL):
#   herdr-remote-<cli>.tgz        herdr-remote.tgz
#   herdr-remote-relay-<relay>.tgz herdr-remote-relay.tgz
#   latest.json
#
# Run from the repository root, after `npm ci`. Packing runs each package's
# `prepack` (a full build), so no separate build step is needed.
#
# Usage: pack-release.sh [dist-dir]     (default: dist/release)

set -euo pipefail

dist="${1:-dist/release}"

cli_version="$(node -p "require('./packages/cli/package.json').version")"
relay_version="$(node -p "require('./packages/relay/package.json').version")"

rm -rf "$dist"
mkdir -p "$dist"
dist="$(cd "$dist" && pwd)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "Packing herdr-remote-relay@$relay_version"
npm pack -w herdr-remote-relay --pack-destination "$work" >/dev/null
relay_tgz="$work/herdr-remote-relay-$relay_version.tgz"

echo "Packing herdr-remote@$cli_version"
npm pack -w herdr-remote --pack-destination "$work" >/dev/null
cli_tgz="$work/herdr-remote-$cli_version.tgz"

stage="$work/stage"
mkdir -p "$stage/package/node_modules/herdr-remote-relay"
tar -xzf "$cli_tgz" -C "$stage"
tar -xzf "$relay_tgz" -C "$stage/package/node_modules/herdr-remote-relay" --strip-components=1

RELEASE_RELAY_VERSION="$relay_version" node -e '
  const fs = require("node:fs");
  const file = "'"$stage"'/package/package.json";
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  pkg.dependencies["herdr-remote-relay"] = process.env.RELEASE_RELAY_VERSION;
  pkg.bundleDependencies = ["herdr-remote-relay"];
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
'

# `--ignore-scripts`: the staged tree is already built, and its `prepack` would
# rebuild from sources that are not there.
(cd "$stage/package" && npm pack --ignore-scripts --pack-destination "$dist" >/dev/null)

cp "$relay_tgz" "$dist/"
cp "$dist/herdr-remote-$cli_version.tgz" "$dist/herdr-remote.tgz"
cp "$relay_tgz" "$dist/herdr-remote-relay.tgz"

RELEASE_CLI_VERSION="$cli_version" RELEASE_RELAY_VERSION="$relay_version" node -e '
  const cli = process.env.RELEASE_CLI_VERSION;
  const out = {
    schema: 1,
    version: cli,
    tag: `herdr-remote-v${cli}`,
    relayVersion: process.env.RELEASE_RELAY_VERSION,
    tarball: `herdr-remote-${cli}.tgz`,
  };
  process.stdout.write(JSON.stringify(out));
' > "$dist/latest.json"

# The bundled relay is the whole point; fail here rather than ship a tarball
# that needs the network for it.
# Listed into a variable first: `grep -q` closing the pipe early would make
# `tar` fail under pipefail even when the file is there.
contents="$(tar -tzf "$dist/herdr-remote-$cli_version.tgz")"
if ! grep -qx 'package/node_modules/herdr-remote-relay/package.json' <<<"$contents"; then
  echo "::error::the CLI tarball does not contain the bundled relay"
  exit 1
fi

echo "Release assets in $dist:"
ls -l "$dist"
