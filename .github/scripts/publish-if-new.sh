#!/usr/bin/env bash
#
# Publish a workspace package only when its version is not already on the
# registry.
#
# Asking the registry rather than diffing the commit is what makes the workflow
# safe to re-run: `npm publish` refuses a duplicate version with an error, which
# would turn every re-run, revert or unrelated manifest edit into a red build.
# Here an already-published version is simply nothing to do.
#
# Usage: publish-if-new.sh <package-directory>

set -euo pipefail

directory="${1:?usage: publish-if-new.sh <package-directory>}"
manifest="$directory/package.json"

if [ ! -f "$manifest" ]; then
  echo "::error::no package.json in $directory"
  exit 1
fi

name="$(node -p "require('./$manifest').name")"
version="$(node -p "require('./$manifest').version")"

if [ -z "${NODE_AUTH_TOKEN:-}" ]; then
  echo "::error::NPM_TOKEN is not configured for this repository"
  echo "Create an npm *automation* token (it bypasses 2FA for CI) and add it as"
  echo "the repository secret NPM_TOKEN."
  exit 1
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
  echo "$name@$version is already published — nothing to do."
  exit 0
fi

echo "Publishing $name@$version"
npm publish -w "$name" --access public
echo "published=true" >> "${GITHUB_OUTPUT:-/dev/null}"
