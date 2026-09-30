#!/usr/bin/env bash
#
# Publish a release tarball to npm only when its version is not already on the
# registry.
#
# npm is the backup channel: the GitHub Release is what users update from, and
# it already exists by the time this runs. So nothing here may fail the
# release — a missing token, a registry outage or a rejected upload is reported
# as a warning and the script exits 0. Asking the registry first also keeps
# re-runs quiet: `npm publish` refuses a duplicate version with an error.
#
# Usage: publish-if-new.sh <tarball.tgz>

set -uo pipefail

tarball="${1:?usage: publish-if-new.sh <tarball.tgz>}"

if [ ! -f "$tarball" ]; then
  echo "::warning::npm backup: no such tarball $tarball"
  exit 0
fi

# The tarball is the source of truth for what gets published, so read the
# identity from inside it rather than from the checkout.
manifest="$(tar -xOzf "$tarball" package/package.json)"
name="$(node -p 'JSON.parse(process.argv[1]).name' "$manifest")"
version="$(node -p 'JSON.parse(process.argv[1]).version' "$manifest")"

if [ -z "${NODE_AUTH_TOKEN:-}" ]; then
  echo "::warning::npm backup skipped for $name@$version: NPM_TOKEN is not configured"
  exit 0
fi

# `npm view <pkg>@<version> version` prints the version when it exists, prints
# nothing when the package exists but that version does not, and fails with E404
# when the package has never been published at all. The last case is a first
# release, not an error.
published=""
if ! published="$(npm view "$name@$version" version 2>/dev/null)"; then
  published=""
fi

if [ -n "$published" ]; then
  echo "$name@$version is already on npm — nothing to do."
  exit 0
fi

echo "Publishing $name@$version to npm"
# `--tag latest` is npm's default, stated here so it stays true: this is the
# version `npm install <name>` resolves to.
if ! npm publish "$tarball" --access public --tag latest; then
  echo "::warning::npm backup publish of $name@$version failed; the GitHub Release is unaffected"
  exit 0
fi

# Confirm the registry agrees, rather than trusting the exit code alone.
resolved="$(npm view "$name" dist-tags.latest 2>/dev/null || true)"
if [ "$resolved" != "$version" ]; then
  echo "::warning::$name dist-tag latest is '$resolved', expected '$version'"
fi
