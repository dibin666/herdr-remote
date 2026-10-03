#!/usr/bin/env bash
set -euo pipefail

version="${1:?version required}"
image="${2:?image name required}"
tag="herdr-remote-v$version"
notes="herdr-remote $version, with herdr-remote-relay $version bundled.

- \`herdr-remote.tgz\`: the CLI with its relay. \`npm install -g https://github.com/${GITHUB_REPOSITORY:-dibin666/herdr-remote}/releases/latest/download/herdr-remote.tgz\`
- \`herdr-remote-relay.tgz\`: the standalone relay, for a server of its own.
- Container image: \`$image:$version\` (also \`latest\`), published by the same workflow."
assets=(dist/release/*)
for attempt in 1 2 3 4 5; do
  draft="$(gh release view "$tag" --json isDraft --jq '.isDraft' 2>/dev/null || true)"
  # A retry after successful publication must not overwrite immutable public assets.
  if [ "$draft" = false ]; then exit 0; fi
  if [ "$draft" = true ] || gh release create "$tag" --verify-tag --draft \
    --title "herdr-remote $version" --notes "$notes"; then
    # Publishing latest is the final action, so readers cannot see incomplete assets.
    if gh release upload "$tag" --clobber "${assets[@]}" && \
      gh release edit "$tag" --draft=false --latest; then
      exit 0
    fi
  fi
  echo "::warning::GitHub Release attempt $attempt failed"
  sleep $((attempt * 10))
done
echo "::error::could not publish the GitHub Release for $tag"
exit 1
