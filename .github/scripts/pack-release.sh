#!/usr/bin/env bash
#
# Build the release assets: the self-contained CLI tarball, the standalone
# relay tarball, and the latest.json pointer that clients read to find the
# newest release. Both tarballs carry the one version this release has.
#
# scripts/bundle-release.mjs does the real work: it bundles each package's
# JavaScript, dependencies included, into a few minified files, and puts the
# relay inside the CLI under node_modules/ as a bundled dependency. npm then
# only has node-pty left to install, and `herdr-remote update` can swap a
# release in without npm at all.
#
# Assets written to <dist-dir> (each tarball also under a versionless name, so
# `releases/latest/download/<name>.tgz` is a stable URL):
#   herdr-remote-<version>.tgz        herdr-remote.tgz
#   herdr-remote-relay-<version>.tgz  herdr-remote-relay.tgz
#   latest.json
#
# Run from the repository root, after `npm ci`.
#
# Usage: pack-release.sh [dist-dir]     (default: dist/release)

set -euo pipefail

dist="${1:-dist/release}"

version="$(node -p "require('./packages/cli/package.json').version")"

rm -rf "$dist"
mkdir -p "$dist"
dist="$(cd "$dist" && pwd)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

npm run build

node scripts/bundle-release.mjs cli "$work/cli"
node scripts/bundle-release.mjs relay "$work/relay"

# `--ignore-scripts`: the trees are already built; nothing should run at pack time.
(cd "$work/cli" && npm pack --ignore-scripts --pack-destination "$dist" >/dev/null)
(cd "$work/relay" && npm pack --ignore-scripts --pack-destination "$dist" >/dev/null)

relay_version="$(node -p "require('$work/relay/package.json').version")"
cp "$dist/herdr-remote-$version.tgz" "$dist/herdr-remote.tgz"
cp "$dist/herdr-remote-relay-$relay_version.tgz" "$dist/herdr-remote-relay.tgz"

# `relayVersion` is kept for readers written when the two had separate versions.
RELEASE_VERSION="$version" node -e '
  const version = process.env.RELEASE_VERSION;
  const out = {
    schema: 1,
    version,
    tag: `herdr-remote-v${version}`,
    relayVersion: version,
    tarball: `herdr-remote-${version}.tgz`,
  };
  process.stdout.write(JSON.stringify(out));
' > "$dist/latest.json"

# The bundled relay is the whole point; fail here rather than ship a tarball
# that needs the network for it.
# Listed into a variable first: `grep -q` closing the pipe early would make
# `tar` fail under pipefail even when the file is there.
contents="$(tar -tzf "$dist/herdr-remote-$version.tgz")"
for required in \
  package/node_modules/herdr-remote-relay/bin/herdr-remote-relay.js \
  package/node_modules/herdr-remote-relay/web/dist/index.html \
  package/dist/cli.js \
  package/dist/connector/main.js \
  package/dist/connector/admin-broker.js \
  package/dist/harfbuzz-subset.wasm; do
  if ! grep -qx "$required" <<<"$contents"; then
    echo "::error::the CLI tarball lacks $required"
    exit 1
  fi
done

echo "Release assets in $dist:"
ls -l "$dist"
