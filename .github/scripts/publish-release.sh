#!/usr/bin/env bash
set -euo pipefail

cli="${1:?CLI version required}"
relay="${2:?Relay version required}"
tag="herdr-remote-v$cli"
notes="herdr-remote $cli includes herdr-remote-relay $relay. Install herdr-remote.tgz for the CLI with its bundled relay, or herdr-remote-relay.tgz for the relay alone."
assets=(dist/release/*)
for attempt in 1 2 3 4 5; do
  draft="$(gh release view "$tag" --json isDraft --jq '.isDraft' 2>/dev/null || true)"
  # A retry after successful publication must not overwrite immutable public assets.
  if [ "$draft" = false ]; then exit 0; fi
  if [ "$draft" = true ] || gh release create "$tag" --verify-tag --draft \
    --title "herdr-remote $cli" --notes "$notes"; then
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
