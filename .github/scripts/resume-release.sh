#!/usr/bin/env bash
set -euo pipefail

# Tags are recorded before publication. A retry must finish that version without bumping it.
cli="$(node -p "require('./packages/cli/package.json').version")"
relay="$(node -p "require('./packages/relay/package.json').version")"
tag="herdr-remote-v$cli"
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
relay_released=false
if [ "$(git rev-parse -q --verify "herdr-remote-relay-v$relay^{commit}" || true)" = "$(git rev-parse HEAD)" ]; then
  relay_released=true
fi
{
  echo 'resume=true'
  echo 'cli=true'
  echo "relay=$relay_released"
} >> "$GITHUB_OUTPUT"
