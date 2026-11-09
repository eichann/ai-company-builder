#!/usr/bin/env bash
# Decide which CI jobs a change needs. Writes `<area>=true|false` lines to
# $GITHUB_OUTPUT (stdout when unset) for: sync, client, clientmac, ui, perf,
# universal, server, admin.
#
# Pull requests are filtered by path. A push to main runs the Linux areas
# (client, ui, server, admin) and skips the macOS ones (sync, clientmac, perf,
# universal): the PR already ran them and macOS runners are scarce. The nightly
# schedule and a manual run (workflow_dispatch) run everything. Typecheck and
# lint are not areas: they always run.
#
# The lists follow what each job's tests load. For the areas with test entry
# points (sync, client, clientmac, perf, ui) that is checked on every run by
# .github/scripts/check-areas.mjs (job "Lint (changed files)"): a file the
# tests import that no list here names fails the check, so a list cannot
# silently fall behind the code. Files read at run time (the pre-receive hook
# template, the push checker the hook runs) are named here by hand. A path in
# COMMON (dependencies, the workflow itself) runs every job.
#
# Usage: changed-areas.sh <event-name> <base-ref>
#        changed-areas.sh --files <area>   # tracked files that run <area> (check-areas.mjs)
set -euo pipefail

areas=(sync client clientmac ui perf universal server admin)

COMMON=(
  package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc patches/
  .github/workflows/ci.yml .github/actions/ .github/scripts/changed-areas.sh
)

# Sync harness (4 macOS shards). What client/tests/sync/*.test.ts load, plus
# the hook template and push checker that the harness's bare repositories run.
# client/shared and shared/core are named file by file: most of them (task,
# plugin, minutes settings) never reach sync, and a change there used to run
# all four shards. check-areas.mjs fails when sync starts importing another
# one. Renderer-only changes (client/src/) never run it. (Files imported only
# for types are not followed: they cannot change what the tests run, and
# Typecheck covers them.)
SYNC=(
  client/electron/sync/ client/electron/protected-config.ts client/electron/write-guard.ts
  client/shared/auto-sync.ts client/shared/sparse-paths.ts client/shared/temp-save-file.ts client/shared/office-lock-files.ts
  client/shared/skill-leftovers.ts client/shared/skill-shelf.ts client/shared/write-access.ts
  client/tests/sync/ client/tests/sync-harness/
  client/package.json ':(glob)client/tsconfig*.json'
  server/src/lib/push-check/ server/src/lib/git-exec.ts server/src/lib/git-server/
  server/src/lib/error-log.ts server/src/lib/request-log.ts
  server/src/templates/ server/package.json server/tsconfig.json
  shared/core/agent-config.ts shared/core/instruction-files.ts shared/core/paths.ts shared/core/permissions.ts
  shared/core/record-types.ts shared/core/records.ts shared/core/reserved-paths.ts shared/core/skill-files.ts
  shared/core/write-access.ts shared/core/yaml-lite.ts
  shared/core/connector-roles.ts shared/core/names.ts shared/core/plugin-step-runs.ts
  shared/core/skill-autorun.ts shared/core/skill-shelf.ts shared/core/secret-patterns.ts
  shared/types/private-folders.ts shared/package.json shared/tsconfig.json
  .github/scripts/sync-shard.mjs
)
# Client node tests on Linux (most of client/tests/*.test.ts and the colocated
# renderer tests). They import server/src/lib (git-server, push-check rules)
# and admin/src/lib/folder-name.ts.
CLIENT=(
  client/ shared/ server/src/lib/ server/package.json admin/src/lib/
  .github/scripts/client-tests.mjs
)
# Client tests that stay on macOS (.github/scripts/client-tests.mjs, list
# MACOS) and the two Swift tests: the POSIX spawn wrappers, the recursive
# watcher, the file-system guards that differ on a case- and
# normalization-insensitive volume, the voice helpers.
# ipc-fs.test.ts drives the whole main process through the IPC harness, so
# any client/electron/ change runs it; renderer-only changes do not.
CLIENT_MAC=(
  client/electron/ client/shared/ client/native/ ':(glob)client/tests/*.swift'
  client/tests/agent-env.test.ts client/tests/commit-message.test.ts client/tests/disk-key.test.ts
  client/tests/company-watcher.test.ts client/tests/ipc-fs.test.ts
  client/tests/permission-mode.test.ts client/tests/sandbox-claude.test.ts
  client/tests/voice-helper.test.ts client/tests/voice-polisher.test.ts client/tests/voice-probe.test.ts
  client/tests/ipc-harness/ ':(glob)client/tsconfig*.json' client/package.json shared/
  .github/scripts/client-tests.mjs
)
# Renderer UI tests (Playwright) and the renderer bundle size, both on Linux.
UI=(
  client/src/ client/shared/ client/tests/ui/ ':(glob)client/tests/*-ui.*'
  client/playwright.config.ts client/vite.config.ts client/tailwind.config.js
  client/postcss.config.js client/index.html ':(glob)client/tsconfig*.json'
  client/package.json client/scripts/check-bundle-size.mjs shared/
  client/electron/features/plugins/screens.ts
)
# Performance baselines (macOS): what client/tests/perf/*.perf.test.ts load
# (the watcher, git search, the chat history store, the file tree, the chat
# window).
PERF=(
  client/tests/perf/ client/electron/company-watcher.ts client/electron/git-search.ts
  client/electron/chat-history-store.ts client/electron/sync/
  client/shared/agents/ client/shared/chat-history-summary.ts client/shared/sparse-paths.ts client/shared/task-consult.ts
  client/src/features/chat/ client/src/features/files/ client/src/shared/lib/
  ':(glob)client/tsconfig*.json' client/package.json shared/core/paths.ts
  shared/core/instruction-like.ts shared/core/outside-text.ts
)
UNIVERSAL=(client/scripts/universal-git.mjs client/package.json)
# staging/: the staging kit's helpers, tested by server/tests/unit/staging-kit.test.ts.
SERVER=(server/ shared/ staging/)
ADMIN=(admin/ shared/)

pathspecs() {
  case "$1" in
    sync) printf '%s\n' "${SYNC[@]}" ;;
    client) printf '%s\n' "${CLIENT[@]}" ;;
    clientmac) printf '%s\n' "${CLIENT_MAC[@]}" ;;
    ui) printf '%s\n' "${UI[@]}" ;;
    perf) printf '%s\n' "${PERF[@]}" ;;
    universal) printf '%s\n' "${UNIVERSAL[@]}" ;;
    server) printf '%s\n' "${SERVER[@]}" ;;
    admin) printf '%s\n' "${ADMIN[@]}" ;;
    *) echo "unknown area: $1" >&2; return 2 ;;
  esac
}

# A read loop rather than `mapfile` so the script also runs on macOS's bash 3.2.
specs_of() {
  specs=()
  while IFS= read -r s; do specs+=("$s"); done < <(pathspecs "$1")
}

if [ "${1:-}" = "--files" ]; then
  specs_of "${2:?usage: changed-areas.sh --files <area>}"
  git -c core.quotePath=false ls-files -- "${COMMON[@]}" "${specs[@]}"
  exit 0
fi

event="${1:?usage: changed-areas.sh <event-name> <base-ref>}"
base_ref="${2:-main}"

emit() {
  echo "$1=$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi
}

if [ "$event" = "push" ]; then
  echo "Event push: Linux jobs only (macOS jobs ran on the PR; nightly runs everything)."
  for a in "${areas[@]}"; do
    case "$a" in client|ui|server|admin) emit "$a" true ;; *) emit "$a" false ;; esac
  done
  exit 0
fi

if [ "$event" != "pull_request" ]; then
  echo "Event $event: running every job."
  for a in "${areas[@]}"; do emit "$a" true; done
  exit 0
fi

base=$(git merge-base "origin/$base_ref" HEAD)
echo "Changes since $base:"
git -c core.quotePath=false diff --name-only "$base" HEAD | sed 's/^/  /'

for a in "${areas[@]}"; do
  specs_of "$a"
  # git diff --quiet exits 1 when something under the pathspecs changed.
  if git diff --quiet "$base" HEAD -- "${COMMON[@]}" "${specs[@]}"; then emit "$a" false; else emit "$a" true; fi
done
