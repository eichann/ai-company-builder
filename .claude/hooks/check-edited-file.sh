#!/usr/bin/env bash
# PostToolUse hook (Edit / Write / MultiEdit): lint the file Claude just
# changed, and for app code run the module-boundary test, so a broken layer
# boundary shows up while working instead of in CI. Fast checks only — the
# test suites stay in CI. Exit 2 hands the findings back to Claude.
set -uo pipefail

file=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const i=JSON.parse(s).tool_input||{};process.stdout.write(i.file_path||i.notebook_path||"")}catch{}})')
case "$file" in *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs) ;; *) exit 0 ;; esac
[ -f "$file" ] || exit 0

root=$(git -C "$(dirname "$file")" rev-parse --show-toplevel 2>/dev/null) || exit 0
rel=${file#"$root"/}
pkg=${rel%%/*}
case "$pkg" in client|server|admin) ;; *) exit 0 ;; esac
[ -d "$root/$pkg/node_modules" ] || exit 0

out=$(cd "$root/$pkg" && npx --no-install eslint --quiet "${rel#"$pkg"/}" 2>&1)
if [ $? -ne 0 ]; then
  printf 'ESLint errors in %s (CI lints every changed file):\n%s\n' "$rel" "$out" >&2
  exit 2
fi

case "$rel" in
  client/electron/*|client/shared/*|client/src/*)
    out=$(cd "$root/client" && npx --no-install tsx --test tests/architecture-boundaries.test.ts 2>&1)
    if [ $? -ne 0 ]; then
      printf 'Module boundary check failed after editing %s (client/tests/architecture-boundaries.test.ts; reasons in CLAUDE.md "Principles"):\n%s\n' \
        "$rel" "$(printf '%s\n' "$out" | grep -E "^not ok|^\s+[+0-9]+: |^\s+\+ +'|message:" | head -30)" >&2
      exit 2
    fi
    ;;
esac
exit 0
