#!/usr/bin/env bash
#
# Decide whether this push releases.
#
# herdr-remote and herdr-remote-relay are released together, under one
# version: the CLI bundles the relay, and the relay image is built from the
# same tree. So there is one question, "has anything that ships changed since
# the last release", answered against the last `herdr-remote-v*` tag. The
# question is deliberately not "has the version field been edited": the
# version is the workflow's output, so it cannot also be its trigger.
#
# Before the first tagged release there is nothing to compare against, so the
# push's own range is used instead (`github.event.before`, falling back to the
# previous commit).
#
# Writes `release=true|false` to $GITHUB_OUTPUT and prints why. Run outside
# Actions — by hand, to see what a push would do — the result is just printed.
#
# Usage: plan-release.sh [auto|force]
#   BEFORE_SHA — optional, the commit this push started from.

set -euo pipefail

selection="${1:-auto}"

# Everything a release is built from: both packages, the web UI inside the
# relay, the image recipe, and the bundler that turns them into release trees.
SHIPPED=(packages scripts/bundle-release.mjs .dockerignore)

decide() {
  echo "release=$1"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "release=$1" >> "$GITHUB_OUTPUT"
  fi
}

if [ "$selection" = "force" ]; then
  echo "  requested explicitly"
  decide true
  exit 0
fi

# sort -V orders 0.1.9 before 0.1.10, which plain sort does not. The `|| true`
# is load-bearing under pipefail: no release yet makes grep exit 1.
version="$(git tag --list 'herdr-remote-v*' \
  | sed 's/^herdr-remote-v//' \
  | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
  | sort -V \
  | tail -n1 || true)"

if [ -n "$version" ]; then
  base="herdr-remote-v$version"
else
  base=""
  before="${BEFORE_SHA:-}"
  # A branch's first push reports an all-zero "before", which is not a commit.
  if [ -n "$before" ] && [ "$before" != "0000000000000000000000000000000000000000" ] \
    && git rev-parse -q --verify "$before^{commit}" >/dev/null 2>&1; then
    base="$before"
  elif git rev-parse -q --verify 'HEAD~1^{commit}' >/dev/null 2>&1; then
    base="HEAD~1"
  fi
fi

if [ -z "$base" ]; then
  echo "  no baseline to compare against — skipping"
  decide false
  exit 0
fi

# Markdown is documentation, not something a release carries differently.
changed="$(git diff --name-only "$base" HEAD -- "${SHIPPED[@]}" | grep -Ev '\.md$' || true)"
if [ -n "$changed" ]; then
  echo "  changed since $base — will release:"
  sed -n '1,20s/^/    /p' <<<"$changed"
  decide true
else
  echo "  unchanged since $base — skipping"
  decide false
fi
