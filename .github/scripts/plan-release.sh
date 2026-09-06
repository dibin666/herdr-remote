#!/usr/bin/env bash
#
# Decide which npm packages this push should release.
#
# The question is deliberately "has this package changed since it was last
# released", not "has the version field been edited": the version is now the
# workflow's output rather than its input, so it cannot also be its trigger.
#
# The last release of a package is recorded as an annotated git tag —
# `herdr-remote-v0.2.4`, `herdr-remote-relay-v0.2.2` — for the same reason the
# relay image uses tags: the sequence then survives re-runs, reverts and
# workflow edits, and it is readable from a clone without asking npm.
#
# Before a package's first tagged release there is nothing to compare against,
# so the push's own range is used instead (`github.event.before`, falling back
# to the previous commit). That keeps the first run after this workflow lands
# from releasing both packages merely because it has no history.
#
# Writes `cli=true|false` and `relay=true|false` to $GITHUB_OUTPUT, and prints
# what it decided and why.
#
# Usage: plan-release.sh [auto|cli|relay|both]
#   BEFORE_SHA — optional, the commit this push started from.

set -euo pipefail

selection="${1:-auto}"

# key : package directory : npm name (which is also the tag prefix)
PACKAGES=(
  "cli:packages/cli:herdr-remote"
  "relay:packages/relay:herdr-remote-relay"
)

# One decision, stated in the log and handed to the workflow. Run outside
# Actions — by hand, to see what a push would do — it just prints.
emit() {
  echo "$1=$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "$1=$2" >> "$GITHUB_OUTPUT"
  fi
}

# The commit a package is compared against when it has never been tagged.
fallback_base() {
  local before="${BEFORE_SHA:-}"
  # A branch's first push reports an all-zero "before", which is not a commit.
  if [ -n "$before" ] && [ "$before" != "0000000000000000000000000000000000000000" ] \
    && git rev-parse -q --verify "$before^{commit}" >/dev/null 2>&1; then
    printf '%s' "$before"
    return
  fi
  if git rev-parse -q --verify 'HEAD~1^{commit}' >/dev/null 2>&1; then
    printf 'HEAD~1'
    return
  fi
  printf ''
}

latest_tag_for() {
  # sort -V orders 0.1.9 before 0.1.10, which plain sort does not.
  #
  # The `|| true` is load-bearing under `set -o pipefail`: a package with no
  # release yet makes `grep` exit 1, which would otherwise abort the script
  # rather than mean "nothing released yet", which is what it means.
  git tag --list "$1-v*" \
    | sed "s/^$1-v//" \
    | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -V \
    | tail -n1 || true
}

for entry in "${PACKAGES[@]}"; do
  key="${entry%%:*}"
  rest="${entry#*:}"
  directory="${rest%%:*}"
  name="${rest#*:}"

  if [ "$selection" = "cli" ] || [ "$selection" = "relay" ]; then
    if [ "$selection" = "$key" ]; then
      emit "$key" true
      echo "  $name: requested explicitly"
    else
      emit "$key" false
      echo "  $name: not requested"
    fi
    continue
  fi

  if [ "$selection" = "both" ]; then
    emit "$key" true
    echo "  $name: requested explicitly"
    continue
  fi

  version="$(latest_tag_for "$name" || true)"
  if [ -n "$version" ]; then
    base="$name-v$version"
  else
    base="$(fallback_base)"
  fi

  if [ -z "$base" ]; then
    # A repository with a single commit and no tags: nothing to compare
    # against, so nothing is claimed to have changed.
    emit "$key" false
    echo "  $name: no baseline to compare against — skipping"
    continue
  fi

  if [ -n "$(git diff --name-only "$base" HEAD -- "$directory")" ]; then
    emit "$key" true
    echo "  $name: changed since $base — will release"
  else
    emit "$key" false
    echo "  $name: unchanged since $base — skipping"
  fi
done
