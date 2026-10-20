#!/bin/bash
#
# pre-receive hook: シークレット検知 + gitlink(サブモジュール参照)検知
# - APIキー・秘密鍵等を検知し、ブロックする
# - 新規に追加された gitlink (mode 160000) をブロックする。
#   入れ子の .git をうっかりコミットすると他メンバーが空フォルダを掴むため。
#   既存の gitlink には触れない（newmode 160000 の「追加/変更」のみ対象）ので、
#   既に gitlink を含むリポジトリも通常の push は引き続き可能。
# - チャットのAI(Claude Code)が確認なしにコマンドを実行する設定ファイル
#   (.claude/settings.json, .mcp.json, .claude/hooks/ など、どの階層でも)の
#   変更を、会社のオーナー・管理者以外からはブロックする。
#   役割はサーバー(git-http.ts)が認証済みユーザーから ACB_PUSHER_ROLE に設定する。
#   値が無い・不明な場合は、保護対象パスについてのみ拒否する(fail closed)。
# - スキル・エージェント・コマンド(.claude/skills|agents|commands/、どの階層でも)
#   の Markdown のうち、Claude Code が確認なしに実行する部分(frontmatter の
#   hooks / mcpServers 等、本文の !`コマンド` と ```! ブロック)を含むものの
#   追加・変更を、オーナー・管理者以外からはブロックする。スキル自体の共有は
#   自由（自動実行の部分を含まなければ誰でも追加・変更できる。削除は常に可）。
# - 個人用フォルダ(.personal、どの階層でも)の中身の追加・変更を、役割に
#   関係なくブロックする（直下の .gitignore と、削除は許可）。
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

# --- 実行設定ファイルの保護 ---
# Claude Code はチャットの作業フォルダにあるこれらのファイルを読み込み、
# 書かれたコマンドを確認なしに実行する（hooks / MCPサーバー / statusLine /
# apiKeyHelper / env など）。共有リポジトリ経由で全員に配られるので、
# 変更できるのはオーナー・管理者だけにする。
# - 大文字小文字は区別しない（macOS/Windows のファイルシステムでは
#   .Claude/Settings.json も .claude/settings.json として読まれる）
# - ".claude" という名前のファイル/シンボリックリンク自体も対象。
#   別フォルダへのリンクで .claude を作る抜け道を塞ぐ
PROTECTED_RE='(^|/)\.mcp\.json$|(^|/)\.claude$|(^|/)\.claude/settings(\.local)?\.json$|(^|/)\.claude/hooks(/|$)'
case "${ACB_PUSHER_ROLE:-}" in
  owner|admin) protected_allowed=1 ;;
  *) protected_allowed=0 ;;
esac
found_protected=0
declare -a detected_protected=()

# ref 更新 (old → new) で変更される保護対象パスを1行1パスで出力する。
# 「変更」= 追加・変更・削除・リネーム（リネームは元と先の両方）。
#  1) このプッシュで新しく入るコミットそれぞれの差分
#     （マージコミットは combined diff = どの親とも異なるパスだけ。
#      サーバー側で管理者が入れた変更をマージしただけでは引っかからない）
#  2) 既存ブランチの更新なら、旧tip→新tip の正味の差分
#     （古いコミットをマージして保護ファイルを巻き戻す抜け道を塞ぐ）
# 新規ブランチ/初回プッシュ(旧SHAがゼロ)は 1) が全コミットを覆う
# （--root でルートコミットも空ツリーとの差分になる）。
# サブシェル + pipefail: git が失敗したら非ゼロで返し、呼び出し側で fail closed。
list_protected_changes() (
  set -o pipefail
  old="$1"
  new="$2"
  commits=$(git rev-list "$new" --not --all) || exit 1
  net=""
  if [ "$old" != "$ZERO_SHA" ]; then
    net=$(git diff-tree -r --no-renames --name-only -z "$old" "$new" | tr '\0' '\n') || exit 1
  fi
  per_commit=""
  if [ -n "$commits" ]; then
    per_commit=$(printf '%s\n' "$commits" \
      | git diff-tree --stdin -r --root -c --no-renames --name-only -z --no-commit-id \
      | tr '\0' '\n') || exit 1
  fi
  printf '%s\n%s\n' "$net" "$per_commit" | LC_ALL=C grep -iE "$PROTECTED_RE" | LC_ALL=C sort -u
  exit 0
)

# --- 個人用フォルダ(.personal)の共有禁止 ---
# どの階層でも ".personal" という名前のフォルダの中身は、誰であっても
# （オーナー・管理者も）共有できない。部署フォルダの .personal/.gitignore
# だけでは、手で作った別の場所の .personal/ が普通に共有されてしまうため、
# サーバー側で強制する。
# - 例外1: .personal/ の直下の .gitignore（サーバーが部署作成時に書く）
# - 例外2: 削除は常に許可（共有済みのファイルを共有から外す手段）
# 大文字小文字は区別しない（macOS/Windows の core.ignorecase と揃える）。
PERSONAL_RE='(^|/)\.personal/'
PERSONAL_ALLOWED_RE='(^|/)\.personal/\.gitignore$'
found_personal=0
declare -a detected_personal=()

# ref 更新で .personal/ の中に追加・変更されるパス（削除は除く）を出力する。
# 対象の差分は list_protected_changes と同じ（新コミットごと + 正味の差分）。
# リネームは --no-renames で「元の削除 + 先の追加」になるので、
# .personal/ への移動は追加として検出され、.personal/ からの移動は許可される。
list_personal_additions() (
  set -o pipefail
  old="$1"
  new="$2"
  commits=$(git rev-list "$new" --not --all) || exit 1
  net=""
  if [ "$old" != "$ZERO_SHA" ]; then
    net=$(git diff-tree -r --no-renames --diff-filter=d --name-only -z "$old" "$new" | tr '\0' '\n') || exit 1
  fi
  per_commit=""
  if [ -n "$commits" ]; then
    per_commit=$(printf '%s\n' "$commits" \
      | git diff-tree --stdin -r --root -c --no-renames --diff-filter=d --name-only -z --no-commit-id \
      | tr '\0' '\n') || exit 1
  fi
  printf '%s\n%s\n' "$net" "$per_commit" \
    | LC_ALL=C grep -iE "$PERSONAL_RE" \
    | LC_ALL=C grep -viE "$PERSONAL_ALLOWED_RE" \
    | LC_ALL=C sort -u
  exit 0
)

# --- スキル・エージェント・コマンドの自動実行部分 ---
# スキルの共有はこの製品の中心機能なので .claude/skills/ 等はパスでは保護しない。
# ただし Markdown の中には、読み込まれただけで Claude Code がコマンドを実行する
# 部分がある。それを含むファイルの追加・変更は、オーナー・管理者だけに許可する。
# 対象（Claude Code 2.1.304 の実装に合わせて、やや広めに判定する）:
#  - frontmatter のキー hooks / mcpServers / lspServers / monitors（どの階層・
#    引用符付き・フロー形式 {…}・エスケープ表記も対象）
#  - 本文の !`…`（行頭または空白の直後の !` で始まるもの。コードブロック内でも
#    Claude Code は実行するので対象）と ```! で始まるブロック
#  - シンボリックリンク（リンク先の内容はこのフックでは確認できない）
# 判定は .md ファイルだけ（Claude Code はスキル・エージェント・コマンドとして
# .md しか読まない）。削除は常に許可。内容を確認できない場合は拒否(fail closed)。
# 判定は node で行う（サーバーの実行環境には必ずある。git-http.ts が ACB_NODE に
# サーバー自身の node を渡す）。node 自体が無い場合も、対象パスについてのみ拒否する。
AUTORUN_DIR_RE='(^|/)\.claude/(skills|agents|commands)(/|$)'
AUTORUN_NODE="${ACB_NODE:-node}"
found_autorun=0
declare -a detected_autorun=()

# ref 更新で追加・変更されるエントリの raw 差分(-z)を出力する。
# 対象の差分は list_protected_changes と同じ（新コミットごと + 正味の差分）。
list_autorun_raw() (
  set -o pipefail
  old="$1"
  new="$2"
  commits=$(git rev-list "$new" --not --all) || exit 1
  if [ "$old" != "$ZERO_SHA" ]; then
    git diff-tree -r --no-renames --no-abbrev -z "$old" "$new" || exit 1
  fi
  if [ -n "$commits" ]; then
    printf '%s\n' "$commits" \
      | git diff-tree --stdin -r --root -c --no-renames --no-abbrev -z --no-commit-id || exit 1
  fi
  exit 0
)

# stdin: list_autorun_raw の出力。stdout: 違反ファイルごとに "パス<TAB>理由"。
# 失敗（git の読み出し失敗など）は非ゼロ終了 → 呼び出し側で fail closed。
read -r -d '' AUTORUN_JS <<'JS' || true
const { spawnSync } = require('child_process')
const DIR = /(^|\/)\.claude\/(skills|agents|commands)(\/|$)/i
const tokens = require('fs').readFileSync(0).toString('utf8').split('\0')
const symlinks = new Set()
const blobsByPath = new Map()
for (let i = 0; i < tokens.length; i++) {
  const meta = tokens[i]
  if (!meta.startsWith(':')) continue
  const path = tokens[++i]
  if (path === undefined) throw new Error('truncated diff')
  // ":old new osha nsha S" / combined (merge) "::m1 m2 mR s1 s2 sR SS"
  const parents = meta.match(/^:+/)[0].length
  const f = meta.slice(parents).split(' ')
  const mode = f[parents]
  const sha = f[2 * parents + 1]
  if (!DIR.test(path)) continue
  if (mode === undefined || sha === undefined) throw new Error('bad diff line')
  if (/^0+$/.test(mode) || /^0+$/.test(sha)) continue // deleted
  if (mode === '120000') { symlinks.add(path); continue }
  if (mode === '160000' || !/\.md$/i.test(path)) continue
  if (!blobsByPath.has(path)) blobsByPath.set(path, new Set())
  blobsByPath.get(path).add(sha)
}

const shas = [...new Set([...blobsByPath.values()].flatMap(s => [...s]))]
const contents = new Map()
if (shas.length > 0) {
  const r = spawnSync('git', ['cat-file', '--batch'], { input: shas.join('\n') + '\n', maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error('git cat-file failed')
  const out = r.stdout
  let pos = 0
  for (const sha of shas) {
    const nl = out.indexOf(10, pos)
    const header = out.toString('utf8', pos, nl).split(' ')
    if (header[0] !== sha || header[1] !== 'blob') throw new Error('missing blob ' + sha)
    const size = Number(header[2])
    contents.set(sha, out.subarray(nl + 1, nl + 1 + size))
    pos = nl + 1 + size + 1
  }
}

const KEYS = ['hooks', 'mcpServers', 'lspServers', 'monitors']
// A key spelled as a whole YAML scalar: at line start / after "? " "- " "{" ","
// "[" / after an anchor or tag, optionally quoted, then ":" or the end of the
// scalar (an anchored "&a hooks" can be reused as a key through "*a :").
const KEY_RE = new RegExp(
  String.raw`(?:^[ \t]*|[?\-][ \t]+|[{,\[][ \t]*|[&!]\S*[ \t]+)["']?(${KEYS.join('|')})["']?[ \t]*(?::|$|[,\]}#])`,
  'gim')

function findings(buf) {
  let text = buf.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const found = new Set()
  // Frontmatter: Claude Code reads it only when the file starts with "---",
  // up to the next "---" (anywhere). Leading blank lines are accepted here too.
  const lf = text.replace(/\r\n?/g, '\n')
  const open = /^\s*---/.exec(lf)
  if (open) {
    const start = open.index + open[0].length
    const end = lf.indexOf('---', start)
    const fm = lf.slice(start, end < 0 ? undefined : end)
      .replace(/\\\n[ \t]*/g, '') // escaped line break inside a double-quoted key
      .replace(/\\x([0-9a-fA-F]{2})|\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})/g, (m, a, b, c) => {
        const cp = parseInt(a || b || c, 16)
        return cp <= 0x10ffff ? String.fromCodePoint(cp) : m
      })
    for (const m of fm.matchAll(KEY_RE)) {
      found.add(`frontmatter の ${KEYS.find(k => k.toLowerCase() === m[1].toLowerCase())}`)
    }
  }
  // Body: Claude Code runs ```!…``` blocks and !`…` where "!" starts a line
  // or follows whitespace (/(?<=^|\s)!`[^`]+`/m), fenced code included. Any
  // opener counts, closed or not: arguments substituted at invocation time can
  // complete it.
  if (text.includes('```!')) found.add('```! ブロック')
  if (/(?<=^|\s)!`/m.test(text)) found.add('!`…` コマンド')
  return [...found]
}

const clean = p => p.replace(/[\x00-\x1f\x7f]/g, '?')
for (const p of [...symlinks].sort()) {
  process.stdout.write(`${clean(p)}\tシンボリックリンク（リンク先を確認できません）\n`)
}
for (const [p, set] of [...blobsByPath].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  if (symlinks.has(p)) continue
  const all = new Set()
  for (const sha of set) for (const f of findings(contents.get(sha))) all.add(f)
  if (all.size > 0) process.stdout.write(`${clean(p)}\t${[...all].join(', ')}\n`)
}
JS

check_autorun() (
  set -o pipefail
  list_autorun_raw "$1" "$2" | "$AUTORUN_NODE" -e "$AUTORUN_JS"
)

while read old_sha new_sha refname; do
  # ブランチ削除は無視（receive.denyDeletes が別途拒否する。
  # 削除は残るブランチの内容を変えないので保護チェックも不要）
  if [ "$new_sha" = "$ZERO_SHA" ]; then
    continue
  fi

  # --- 実行設定ファイルの保護 ---
  if [ "$protected_allowed" -eq 0 ]; then
    if ! protected_changes=$(list_protected_changes "$old_sha" "$new_sha" 2>/dev/null); then
      # 差分を確認できない場合は安全側に倒す（管理者以外は拒否）
      protected_changes="（変更内容を確認できませんでした: $refname）"
    fi
    if [ -n "$protected_changes" ]; then
      while IFS= read -r pp; do
        [ -z "$pp" ] && continue
        already=0
        for existing in "${detected_protected[@]}"; do
          if [ "$existing" = "  - $pp" ]; then already=1; break; fi
        done
        if [ "$already" -eq 0 ]; then
          detected_protected+=("  - $pp")
          found_protected=1
        fi
      done <<< "$protected_changes"
    fi
  fi

  # --- スキル・エージェント・コマンドの自動実行部分（オーナー・管理者以外） ---
  if [ "$protected_allowed" -eq 0 ]; then
    if ! autorun_changes=$(check_autorun "$old_sha" "$new_sha" 2>/dev/null); then
      # 内容を確認できない（node が無い、git の読み出し失敗など）:
      # 対象フォルダ内で変更されたパスを全部、安全側に倒して拒否する
      autorun_changes=$(list_autorun_raw "$old_sha" "$new_sha" 2>/dev/null | tr '\0' '\n' \
        | LC_ALL=C grep -v '^:' | LC_ALL=C grep -iE "$AUTORUN_DIR_RE" | LC_ALL=C sort -u \
        | awk '{ print $0 "\t内容を確認できませんでした" }')
      # （git 自体が読めない場合は、上の保護ファイルの確認がすでに拒否している）
    fi
    if [ -n "$autorun_changes" ]; then
      while IFS= read -r line; do
        [ -z "$line" ] && continue
        ap="${line%%$'\t'*}"
        reason="${line#*$'\t'}"
        already=0
        for existing in "${detected_autorun[@]}"; do
          if [ "${existing%%$'\n'*}" = "  - $ap" ]; then already=1; break; fi
        done
        if [ "$already" -eq 0 ]; then
          detected_autorun+=("  - $ap"$'\n'"      （${reason}）")
          found_autorun=1
        fi
      done <<< "$autorun_changes"
    fi
  fi

  # --- 個人用フォルダ(.personal)の共有禁止（役割に関係なく全員） ---
  if ! personal_changes=$(list_personal_additions "$old_sha" "$new_sha" 2>/dev/null); then
    personal_changes="（変更内容を確認できませんでした: $refname）"
  fi
  if [ -n "$personal_changes" ]; then
    while IFS= read -r pp; do
      [ -z "$pp" ] && continue
      already=0
      for existing in "${detected_personal[@]}"; do
        if [ "$existing" = "  - $pp" ]; then already=1; break; fi
      done
      if [ "$already" -eq 0 ]; then
        detected_personal+=("  - $pp")
        found_personal=1
      fi
    done <<< "$personal_changes"
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

if [ "$found_personal" -eq 1 ]; then
  # 出力形式は PROTECTED_CONFIG と同じ（client/electron/protected-config.ts が解析）
  echo "" >&2
  echo "========================================" >&2
  echo "[PERSONAL_PATH] 個人用フォルダ(.personal)のファイルが含まれています" >&2
  echo "========================================" >&2
  echo "" >&2
  echo "以下は個人用フォルダ(.personal)の中のファイルです。" >&2
  echo ".personal の中身は、誰であっても共有できません:" >&2
  for entry in "${detected_personal[@]}"; do
    printf '%s\n' "$entry" >&2
  done
  echo "" >&2
  echo "プッシュをブロックしました。これらのファイルを共有対象から外してから" >&2
  echo "再度同期してください（ACBクライアントは自動で外します。ファイルはPCに残ります）。" >&2
  echo "========================================" >&2
  echo "" >&2
  rc=1
fi

if [ "$found_protected" -eq 1 ] || [ "$found_autorun" -eq 1 ]; then
  # 出力形式はクライアント(client/electron/protected-config.ts)が解析する:
  # マーカー行の後、次の次の区切り線までにある "- " 行が対象パス。
  # それ以外の行（説明・理由の行）は "- " で始めないこと。
  echo "" >&2
  echo "========================================" >&2
  echo "[PROTECTED_CONFIG] 管理者だけが変更できるファイルが含まれています" >&2
  echo "========================================" >&2
  if [ "$found_protected" -eq 1 ]; then
    echo "" >&2
    echo "以下のファイルは、チャットのAIが確認なしにコマンドを実行する設定です。" >&2
    echo "会社のオーナー・管理者だけが追加・変更・削除できます:" >&2
    for entry in "${detected_protected[@]}"; do
      printf '%s\n' "$entry" >&2
    done
  fi
  if [ "$found_autorun" -eq 1 ]; then
    echo "" >&2
    echo "以下のスキル・エージェント・コマンドには、チャットのAIが確認なしに" >&2
    echo "コマンドを実行する「自動実行の設定」が含まれています。" >&2
    echo "自動実行の設定は、会社のオーナー・管理者だけが追加・変更できます:" >&2
    for entry in "${detected_autorun[@]}"; do
      printf '%s\n' "$entry" >&2
    done
  fi
  echo "" >&2
  echo "プッシュをブロックしました。これらのファイルをサーバーの状態に戻してから" >&2
  echo "再度同期してください（ACBクライアントの同期ボタンから自動で戻せます）。" >&2
  if [ "$found_autorun" -eq 1 ]; then
    echo "スキル等は、自動実行の設定を取り除けば、そのまま共有できます。" >&2
  fi
  echo "配布が必要な場合は、オーナー・管理者に依頼してください。" >&2
  echo "========================================" >&2
  echo "" >&2
  rc=1
fi

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
