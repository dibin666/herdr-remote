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
released=()
if [ "${RELAY_RELEASED:-false}" = true ]; then
  released+=("herdr-remote-relay@$(node -p "require('./packages/relay/package.json').version")")
fi
released+=("herdr-remote@$(node -p "require('./packages/cli/package.json').version")")
git add package-lock.json packages/cli/package.json packages/relay/package.json packages/cli/herdr-plugin.toml
git commit -m "Release ${released[*]} [skip ci]"
refs=(HEAD:refs/heads/master)
for release in "${released[@]}"; do
  tag="${release/@/-v}"
  git tag -a "$tag" -m "$release"
  refs+=("refs/tags/$tag:refs/tags/$tag")
done
# A concurrent merge rejects the entire push, including tags. Never rebase built artifacts.
git push --atomic origin "${refs[@]}"
echo 'recorded=true' >> "$GITHUB_OUTPUT"
