#!/bin/bash
#
# pre-receive hook: シークレット検知 + gitlink(サブモジュール参照)検知
# - APIキー・秘密鍵等を検知し、ブロックする
# - 新規に追加された gitlink (mode 160000) をブロックする。
#   入れ子の .git をうっかりコミットすると他メンバーが空フォルダを掴むため。
#   既存の gitlink には触れない（newmode 160000 の「追加/変更」のみ対象）ので、
#   既に gitlink を含むリポジトリも通常の push は引き続き可能。
#

ZERO_SHA="0000000000000000000000000000000000000000"
EMPTY_TREE="4b825dc642cb6eb9a060e54bf8d69288fbee4904"

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
found_gitlinks=0
declare -a detected_gitlinks=()
found_winpaths=0
declare -a detected_winpaths=()

while read old_sha new_sha refname; do
  # ブランチ削除は無視
  if [ "$new_sha" = "$ZERO_SHA" ]; then
    continue
  fi

  # --- Windows非互換パス検知 ---
  # Windowsで扱えないパスが1つでも入ると、チーム全員のWindows環境で
  # clone/checkout が失敗するため、新しいツリー全体を検査してブロックする。
  all_paths=$(git -c core.quotePath=false ls-tree -r --name-only "$new_sha" 2>/dev/null)
  if [ -n "$all_paths" ]; then
    bad_chars=$(printf '%s\n' "$all_paths" | LC_ALL=C grep -E '[<>:"\\|?*]|[[:cntrl:]]' | sed 's/$/ （Windowsで使用できない文字を含む）/')
    bad_trail=$(printf '%s\n' "$all_paths" | grep -E '(\.| )(\/|$)' | sed 's/$/ （フォルダ・ファイル名の末尾がドットまたはスペース）/')
    bad_reserved=$(printf '%s\n' "$all_paths" | grep -iE '(^|/)(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.[^/]*)?(/|$)' | sed 's/$/ （Windows予約デバイス名）/')
    bad_case=$(printf '%s\n' "$all_paths" | tr '[:upper:]' '[:lower:]' | sort | uniq -d | sed 's/$/ （大文字小文字のみ異なるパスが複数存在）/')

    win_bad=$(printf '%s\n%s\n%s\n%s\n' "$bad_chars" "$bad_trail" "$bad_reserved" "$bad_case" | sed '/^$/d')
    if [ -n "$win_bad" ]; then
      while IFS= read -r entry; do
        [ -z "$entry" ] && continue
        already=0
        for existing in "${detected_winpaths[@]}"; do
          if [ "$existing" = "  - $entry" ]; then already=1; break; fi
        done
        if [ "$already" -eq 0 ]; then
          detected_winpaths+=("  - $entry")
          found_winpaths=1
        fi
      done <<< "$win_bad"
    fi
  fi

  # --- gitlink(サブモジュール参照, mode 160000) 検知 ---
  # 新規ブランチは空ツリーとの差分 = 全 gitlink が「追加」扱い。
  # 既存ブランチは old..new の差分で newmode==160000 のものだけ（=新規追加/変更）。
  gitlink_base="$old_sha"
  if [ "$old_sha" = "$ZERO_SHA" ]; then
    gitlink_base="$EMPTY_TREE"
  fi
  new_gitlinks=$(git -c core.quotePath=false diff-tree -r "$gitlink_base" "$new_sha" 2>/dev/null \
    | awk -F'\t' '{ split($1, a, " "); if (a[2] == "160000") print $2 }')
  if [ -n "$new_gitlinks" ]; then
    while IFS= read -r gl; do
      [ -z "$gl" ] && continue
      already=0
      for existing in "${detected_gitlinks[@]}"; do
        if [ "$existing" = "  - $gl" ]; then already=1; break; fi
      done
      if [ "$already" -eq 0 ]; then
        detected_gitlinks+=("  - $gl")
        found_gitlinks=1
      fi
    done <<< "$new_gitlinks"
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

        if echo "$content" | grep -qE -e "$pattern_regex"; then
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

          if echo "$added_content" | grep -qE -e "$pattern_regex"; then
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

rc=0

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
  rc=1
fi

if [ "$found_gitlinks" -eq 1 ]; then
  echo "" >&2
  echo "========================================" >&2
  echo "[GITLINK_DETECTED] 外部リポジトリの参照が検出されました" >&2
  echo "========================================" >&2
  echo "" >&2
  echo "以下のフォルダは、中に .git を持つ外部リポジトリ（サブモジュール扱い）です:" >&2
  for entry in "${detected_gitlinks[@]}"; do
    echo "$entry" >&2
  done
  echo "" >&2
  echo "このまま共有すると、他のメンバーには空フォルダとして見えてしまうため、" >&2
  echo "プッシュをブロックしました。次のどちらかで解消してください:" >&2
  echo "" >&2
  echo "  1. このフォルダをACBで配布したい場合:" >&2
  echo "     フォルダ内の .git を削除（rm -rf <folder>/.git）してから再同期。" >&2
  echo "     中身が通常ファイルとして取り込まれ、全員に配布されます。" >&2
  echo "  2. 配布せず手元だけで使う場合:" >&2
  echo "     そのフォルダを .gitignore に追加してから再同期。" >&2
  echo "     （ACBクライアントは通常これを自動で行います）" >&2
  echo "========================================" >&2
  echo "" >&2
  rc=1
fi

if [ "$found_winpaths" -eq 1 ]; then
  echo "" >&2
  echo "========================================" >&2
  echo "[WINPATH_DETECTED] Windowsで扱えないファイル名が検出されました" >&2
  echo "========================================" >&2
  echo "" >&2
  echo "以下のパスはWindowsで作成できないため、このまま共有すると" >&2
  echo "Windowsを使うメンバー全員の同期が失敗します:" >&2
  for entry in "${detected_winpaths[@]}"; do
    echo "$entry" >&2
  done
  echo "" >&2
  echo "プッシュをブロックしました。該当のフォルダ・ファイルの名前を変更して" >&2
  echo "から再度同期してください。Windowsでは次の名前が使えません:" >&2
  echo "  ・ < > : \" \\ | ? * を含む名前" >&2
  echo "  ・ 末尾がドット( . )やスペースの名前" >&2
  echo "  ・ CON / PRN / AUX / NUL / COM1〜9 / LPT1〜9 （拡張子付きも不可）" >&2
  echo "  ・ 大文字小文字だけが異なる同名ファイルの共存" >&2
  echo "========================================" >&2
  echo "" >&2
  rc=1
fi

exit $rc
