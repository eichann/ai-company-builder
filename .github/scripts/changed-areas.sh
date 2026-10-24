#!/usr/bin/env bash
# Decide which CI jobs a change needs. Writes `<area>=true|false` lines to
# $GITHUB_OUTPUT (stdout when unset) for: sync, client, ui, perf, universal,
# server, admin.
#
# Only pull requests are filtered. A push to main, the nightly schedule and a
# manual run (workflow_dispatch) run everything. Typecheck and lint are not
# areas: they always run.
#
# The lists follow what each job's tests actually load (esbuild metafile of
# the test entry points, 2026-10-24) plus what they load at run time (the
# pre-receive hook template and push checker the sync harness renders). A
# path in COMMON (dependencies, the workflow itself) runs every job.
#
# Usage: changed-areas.sh <event-name> <base-ref>
set -euo pipefail

event="${1:?usage: changed-areas.sh <event-name> <base-ref>}"
base_ref="${2:-main}"

areas=(sync client ui perf universal server admin)

emit() {
  echo "$1=$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi
}

if [ "$event" != "pull_request" ]; then
  echo "Event $event: running every job."
  for a in "${areas[@]}"; do emit "$a" true; done
  exit 0
fi

base=$(git merge-base "origin/$base_ref" HEAD)
echo "Changes since $base:"
git -c core.quotePath=false diff --name-only "$base" HEAD | sed 's/^/  /'

COMMON=(
  package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc patches/
  .github/workflows/ci.yml .github/actions/ .github/scripts/changed-areas.sh
)

SYNC=(
  client/electron/sync/ client/electron/protected-config.ts client/electron/write-guard.ts
  client/shared/ client/tests/sync/ client/tests/sync-harness/
  client/package.json ':(glob)client/tsconfig*.json'
  server/src/lib/push-check/ server/src/lib/permissions.ts server/src/lib/git-exec.ts
  server/src/lib/git-server/ server/src/templates/ server/package.json server/tsconfig.json
  shared/ .github/scripts/sync-shard.mjs
)
# Client unit tests import server/src/lib (git-server, permissions, push-check
# rules) and admin/src/lib/folder-name.ts.
CLIENT=(client/ shared/ server/src/lib/ server/package.json admin/src/lib/)
UI=(
  client/src/ client/shared/ client/tests/ui/ ':(glob)client/tests/*-ui.*'
  client/playwright.config.ts client/vite.config.ts client/tailwind.config.js
  client/postcss.config.js client/index.html ':(glob)client/tsconfig*.json'
  client/package.json shared/
)
PERF=(client/ shared/)
UNIVERSAL=(client/scripts/universal-git.mjs client/package.json)
SERVER=(server/ shared/)
ADMIN=(admin/ shared/)

changed() {
  # git diff --quiet exits 1 when something under the pathspecs changed.
  if git diff --quiet "$base" HEAD -- "${COMMON[@]}" "$@"; then echo false; else echo true; fi
}

emit sync "$(changed "${SYNC[@]}")"
emit client "$(changed "${CLIENT[@]}")"
emit ui "$(changed "${UI[@]}")"
emit perf "$(changed "${PERF[@]}")"
emit universal "$(changed "${UNIVERSAL[@]}")"
emit server "$(changed "${SERVER[@]}")"
emit admin "$(changed "${ADMIN[@]}")"
