#!/usr/bin/env bash
# The cross-build check of the rollback floor (deployment.md "Rolling back production", jobs.md "Event jobs on the PC"):
# one SQLite file made by this build (server/tests/cross-build/1-make), run through the floor build's code (2-floor, in a
# worktree of the commit pinned in .github/rollback-floor-commit — move it when the floor moves), and back through this
# build (3-return). Server only; the database is the one file passed between the steps. Run from the repository root
# after `pnpm install` (CI: the "Server tests" job). Locally: .github/scripts/rollback-floor-check.sh
#
# Then the set watch's line check (4b-4 A3, jobs.md "The set watch (schema 5)" "The second line"): a copy of the same database
# through a build that knows schema 5 but not the second line (2-before-line, in a worktree of the commit pinned in
# .github/set-watch-line-before-commit) and back through this build (3-return-line).
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"
floor=$(tr -d '[:space:]' < .github/rollback-floor-commit)
before_line=$(tr -d '[:space:]' < .github/set-watch-line-before-commit)
work=$(mktemp -d)
trap 'git worktree remove --force "$work/floor" >/dev/null 2>&1 || true; git worktree remove --force "$work/before-line" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

# A worktree of an older build's commit (a shallow CI checkout lacks it), with its dependencies: this checkout's when the
# lockfile is the same (no install), else its own install of the server.
older_build() {
  local commit=$1 dir=$2
  git cat-file -e "$commit^{commit}" 2>/dev/null || git fetch --no-tags --depth=1 origin "$commit"
  git worktree add --detach "$dir" "$commit" >/dev/null
  if git diff --quiet "$commit" HEAD -- pnpm-lock.yaml; then
    for d in node_modules server/node_modules shared/node_modules; do
      [ -e "$root/$d" ] && ln -s "$root/$d" "$dir/$d"
    done
  else
    (cd "$dir" && pnpm install --frozen-lockfile --filter "./server..." >/dev/null)
  fi
  mkdir -p "$dir/server/tests/cross-build"
  cp server/tests/cross-build/use-db.ts server/tests/cross-build/snapshot.ts "$dir/server/tests/cross-build/"
}

export ACB_CROSS_BUILD_DB="$work/app.sqlite"
echo "rollback floor check: this build makes the database"
(cd server && npx vitest run tests/cross-build/1-make.test.ts)
cp "$work/app.sqlite" "$work/line.sqlite"
cp "$work/app.sqlite.json" "$work/line.sqlite.json"

echo "rollback floor check: the floor ($floor) runs on it"
older_build "$floor" "$work/floor"
cp server/tests/cross-build/2-floor.test.ts "$work/floor/server/tests/cross-build/"
(cd "$work/floor/server" && npx vitest run tests/cross-build/2-floor.test.ts)
echo "rollback floor check: this build again"
(cd server && npx vitest run tests/cross-build/3-return.test.ts)
git worktree remove --force "$work/floor" >/dev/null 2>&1 || true

export ACB_CROSS_BUILD_DB="$work/line.sqlite"
echo "set watch line check: a build without the second line ($before_line) runs on it"
older_build "$before_line" "$work/before-line"
cp server/tests/cross-build/2-before-line.test.ts "$work/before-line/server/tests/cross-build/"
(cd "$work/before-line/server" && npx vitest run tests/cross-build/2-before-line.test.ts)
echo "set watch line check: this build again"
(cd server && npx vitest run tests/cross-build/3-return-line.test.ts)
