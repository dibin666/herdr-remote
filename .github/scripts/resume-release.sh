#!/usr/bin/env bash
set -euo pipefail

# Tags are recorded before publication. A retry must finish that version without bumping it.
version="$(node -p "require('./packages/cli/package.json').version")"
tag="herdr-remote-v$version"
if [ "$(git rev-parse -q --verify "$tag^{commit}" || true)" != "$(git rev-parse HEAD)" ]; then
  echo 'resume=false' >> "$GITHUB_OUTPUT"
  exit 0
fi
# A successful list distinguishes missing releases from network/authentication failures.
releases="$(gh release list --limit 100 --json tagName,isDraft)"
published="$(node -e 'const list = JSON.parse(process.argv[1]); console.log(list.some(r => r.tagName === process.argv[2] && !r.isDraft))' "$releases" "$tag")"
if [ "$published" = true ]; then
  echo 'resume=false' >> "$GITHUB_OUTPUT"
  exit 0
fi
echo 'resume=true' >> "$GITHUB_OUTPUT"
