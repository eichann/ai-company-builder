#!/usr/bin/env bash
# Lint only the files changed since BASE, failing on ESLint errors in them.
#
# The codebase has a pre-existing ESLint baseline (June 2026 remediation plan):
# CI must not fail on that baseline, but a PR must not add findings to the
# files it touches. Linting the touched files whole (rather than attributing
# findings to changed lines) keeps this simple and predictable: if you edit a
# file, that file has to be error-free when you are done.
#
# Warnings are reported but do not fail: the configs deliberately downgrade
# rules such as react-hooks/exhaustive-deps to `warn` for the existing code.
#
# Usage: lint-changed.sh <base-commit>
set -euo pipefail

base="${1:?usage: lint-changed.sh <base-commit>}"

# Packages that have an ESLint config. `shared/` has none and is skipped.
packages=(client server admin)

# A read loop rather than `mapfile` so the script also runs on macOS's bash 3.2.
changed=()
while IFS= read -r f; do
  changed+=("$f")
done < <(
  git -c core.quotePath=false diff --name-only --diff-filter=ACMR "$base" HEAD -- \
    '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs'
)

if [ "${#changed[@]}" -eq 0 ]; then
  echo "No changed JS/TS files since $base; nothing to lint."
  exit 0
fi

status=0
for pkg in "${packages[@]}"; do
  files=()
  for f in "${changed[@]}"; do
    case "$f" in
      "$pkg"/*) files+=("${f#"$pkg"/}") ;;
    esac
  done
  [ "${#files[@]}" -eq 0 ] && continue

  echo "::group::eslint $pkg (${#files[@]} file(s))"
  printf '  %s\n' "${files[@]}"
  # --no-warn-ignored: files excluded by the package's config (build output,
  # generated files) are silently skipped instead of producing a warning.
  if ! (cd "$pkg" && pnpm exec eslint --no-warn-ignored "${files[@]}"); then
    status=1
  fi
  echo "::endgroup::"
done

if [ "$status" -ne 0 ]; then
  echo "::error::ESLint found errors in files changed by this change. Fix them (the whole file must be error-free once touched)."
fi
exit "$status"
