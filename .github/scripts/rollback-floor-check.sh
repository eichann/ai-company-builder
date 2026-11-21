#!/usr/bin/env bash
# The cross-build check of the rollback floor (deployment.md "Rolling back production", jobs.md "Event jobs on the PC"):
# one SQLite file made by this build (server/tests/cross-build/1-make), run through the floor build's code (2-floor, in a
# worktree of the commit pinned in .github/rollback-floor-commit — move it when the floor moves), and back through this
# build (3-return). Server only; the database is the one file passed between the steps. Run from the repository root
# after `pnpm install` (CI: the "Server tests" job). Locally: .github/scripts/rollback-floor-check.sh
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"
floor=$(tr -d '[:space:]' < .github/rollback-floor-commit)
work=$(mktemp -d)
trap 'git worktree remove --force "$work/floor" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

# The floor's commit (a shallow CI checkout lacks it).
git cat-file -e "$floor^{commit}" 2>/dev/null || git fetch --no-tags --depth=1 origin "$floor"
git worktree add --detach "$work/floor" "$floor" >/dev/null

# Its dependencies: this checkout's when the lockfile is the same (no install), else its own install.
if git diff --quiet "$floor" HEAD -- pnpm-lock.yaml; then
  for d in node_modules server/node_modules shared/node_modules; do
    [ -e "$root/$d" ] && ln -s "$root/$d" "$work/floor/$d"
  done
else
  (cd "$work/floor" && pnpm install --frozen-lockfile --filter "./server..." >/dev/null)
fi

export ACB_CROSS_BUILD_DB="$work/app.sqlite"
echo "rollback floor check: this build makes the database"
(cd server && npx vitest run tests/cross-build/1-make.test.ts)
echo "rollback floor check: the floor ($floor) runs on it"
mkdir -p "$work/floor/server/tests/cross-build"
cp server/tests/cross-build/use-db.ts server/tests/cross-build/snapshot.ts server/tests/cross-build/2-floor.test.ts "$work/floor/server/tests/cross-build/"
(cd "$work/floor/server" && npx vitest run tests/cross-build/2-floor.test.ts)
echo "rollback floor check: this build again"
(cd server && npx vitest run tests/cross-build/3-return.test.ts)
