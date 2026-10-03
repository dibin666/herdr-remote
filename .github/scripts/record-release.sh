#!/usr/bin/env bash
set -euo pipefail

# Recheck after building: a queued guard cannot protect against a merge during tests.
git fetch --no-tags origin master
tip="$(git rev-parse FETCH_HEAD)"
if [ "$tip" != "${RELEASE_BASE:?}" ]; then
  echo 'Master advanced while building; leaving publication to the newer run.'
  echo 'recorded=false' >> "$GITHUB_OUTPUT"
  exit 0
fi

if [ "${RESUME_RELEASE:-false}" = true ]; then
  echo 'recorded=true' >> "$GITHUB_OUTPUT"
  exit 0
fi

git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
# One version for both packages, so one tag records the release of both.
version="$(node -p "require('./packages/cli/package.json').version")"
tag="herdr-remote-v$version"
git add package-lock.json packages/cli/package.json packages/relay/package.json packages/cli/herdr-plugin.toml
git commit -m "Release herdr-remote@$version [skip ci]"
git tag -a "$tag" -m "herdr-remote@$version"
# A concurrent merge rejects the entire push, including the tag. Never rebase built artifacts.
git push --atomic origin HEAD:refs/heads/master "refs/tags/$tag:refs/tags/$tag"
echo 'recorded=true' >> "$GITHUB_OUTPUT"
