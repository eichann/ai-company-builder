#!/bin/bash
#
# pre-receive hook: シークレット検知
# 会社データリポジトリへのプッシュ時にAPIキー・秘密鍵等を検知し、ブロックする
#

ZERO_SHA="0000000000000000000000000000000000000000"

# 検知パターン定義
# 各行: "パターン名|正規表現"
PATTERNS=(
  "AWS Access Key ID|AKIA[0-9A-Z]{16}"
  "Private Key|-----BEGIN (RSA|EC|OPENSSH|DSA|PGP) PRIVATE KEY-----"
  "GitHub Personal Access Token|ghp_[0-9a-zA-Z]{36}"
  "GitHub OAuth Token|gho_[0-9a-zA-Z]{36}"
  "GitHub Fine-grained PAT|github_pat_[0-9a-zA-Z_]{22,}"
  "OpenAI/Anthropic API Key|sk-[a-zA-Z0-9]{20,}"
  "Slack Token|xox[bpsa]-[0-9a-zA-Z-]{10,}"
  "Google API Key|AIza[0-9A-Za-z_-]{35}"
)

found_secrets=0
declare -a detected_files=()

while read old_sha new_sha refname; do
  # ブランチ削除は無視
  if [ "$new_sha" = "$ZERO_SHA" ]; then
    continue
  fi

  # 初回プッシュ（リポジトリが空）の場合は全ファイルを対象
  if [ "$old_sha" = "$ZERO_SHA" ]; then
    # 新規ブランチ: 全ファイルの内容をスキャン
    files=$(git diff-tree --no-commit-id --name-only -r "$new_sha" 2>/dev/null)
    if [ -z "$files" ]; then
      continue
    fi

    while IFS= read -r file; do
      content=$(git show "$new_sha:$file" 2>/dev/null)
      if [ -z "$content" ]; then
        continue
      fi

      for pattern_entry in "${PATTERNS[@]}"; do
        pattern_name="${pattern_entry%%|*}"
        pattern_regex="${pattern_entry#*|}"

        if echo "$content" | grep -qE "$pattern_regex"; then
          detected_files+=("  - $file ($pattern_name)")
          found_secrets=1
          break
        fi
      done
    done <<< "$files"
  else
    # 既存ブランチへの追加: diff の追加行のみスキャン
    diff_output=$(git diff "$old_sha" "$new_sha" 2>/dev/null)
    if [ -z "$diff_output" ]; then
      continue
    fi

    current_file=""
    while IFS= read -r line; do
      # diff ヘッダからファイル名を取得
      if [[ "$line" =~ ^diff\ --git\ a/(.+)\ b/(.+)$ ]]; then
        current_file="${BASH_REMATCH[2]}"
        continue
      fi

      # 追加行のみチェック（+で始まり、+++は除外）
      if [[ "$line" =~ ^\+[^+] ]] || [[ "$line" =~ ^\+$ ]]; then
        added_content="${line:1}"

        for pattern_entry in "${PATTERNS[@]}"; do
          pattern_name="${pattern_entry%%|*}"
          pattern_regex="${pattern_entry#*|}"

          if echo "$added_content" | grep -qE "$pattern_regex"; then
            # 同じファイルの重複を避ける
            entry="  - $current_file ($pattern_name)"
            already_found=0
            for existing in "${detected_files[@]}"; do
              if [ "$existing" = "$entry" ]; then
                already_found=1
                break
              fi
            done
            if [ "$already_found" -eq 0 ]; then
              detected_files+=("$entry")
              found_secrets=1
            fi
            break
          fi
        done
      fi
    done <<< "$diff_output"
  fi
done

if [ "$found_secrets" -eq 1 ]; then
  echo "" >&2
  echo "========================================" >&2
  echo "[SECRET_DETECTED] シークレットが検出されました" >&2
  echo "========================================" >&2
  echo "" >&2
  echo "以下のファイルにAPIキー・シークレットが含まれています:" >&2
  for entry in "${detected_files[@]}"; do
    echo "$entry" >&2
  done
  echo "" >&2
  echo "セキュリティのため、このプッシュはブロックされました。" >&2
  echo "該当ファイルからシークレットを削除してから再度同期してください。" >&2
  echo "========================================" >&2
  echo "" >&2
  exit 1
fi

exit 0
