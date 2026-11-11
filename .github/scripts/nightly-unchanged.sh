#!/usr/bin/env bash
# Is tonight's scheduled run testing the same commit as the last successful
# scheduled run? Then every job already passed on exactly this code and the
# nightly full run can be skipped. Writes `unchanged=true|false` to
# $GITHUB_OUTPUT (stdout when unset).
#
# Only the `schedule` event can be skipped: a manual run (workflow_dispatch),
# a push and a pull request always answer `false`. Any doubt answers `false`
# too (the API call fails, no earlier successful nightly, an empty answer), so
# a lookup problem runs everything rather than skipping a check.
#
# Needs `gh` and GH_TOKEN with `actions: read` (the job's GITHUB_TOKEN).
#
# Usage: nightly-unchanged.sh <event-name> <sha> <owner/repo>
set -uo pipefail

event="${1:?usage: nightly-unchanged.sh <event-name> <sha> <owner/repo>}"
sha="${2:?usage: nightly-unchanged.sh <event-name> <sha> <owner/repo>}"
repo="${3:?usage: nightly-unchanged.sh <event-name> <sha> <owner/repo>}"

emit() {
  echo "unchanged=$1"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "unchanged=$1" >> "$GITHUB_OUTPUT"; fi
}

if [ "$event" != "schedule" ]; then
  echo "Event $event: never skipped."
  emit false
  exit 0
fi

# The run in progress is not `success` yet, so it is not its own answer.
if ! last=$(gh api "repos/$repo/actions/workflows/ci.yml/runs?event=schedule&status=success&branch=main&per_page=1" \
    --jq '.workflow_runs[0].head_sha // ""' 2>&1); then
  echo "::warning::Could not look up the last successful nightly run; running everything. ($last)"
  emit false
  exit 0
fi

if [ -z "$last" ]; then
  echo "No earlier successful nightly run; running everything."
  emit false
elif [ "$last" = "$sha" ]; then
  echo "main is still at $sha, which the last successful nightly run already tested; skipping the full run."
  emit true
else
  echo "main moved since the last successful nightly run ($last -> $sha); running everything."
  emit false
fi
