/**
 * The push rules as pure functions (no git, no I/O).
 *
 * Ported from the shell pre-receive hook (kept for reference and the
 * differential test at server/tests/fixtures/pre-receive-hook.legacy.sh).
 * The hook ran every text tool under LC_ALL=C, so its matching was bytewise
 * and its case-insensitivity covered A–Z only. To keep exactly that, path
 * lists and diff lines are handled here as *byte strings*: Buffers decoded as
 * latin1, one char per byte (never UTF-8 decoded, so no byte is replaced or
 * re-normalised). With patterns written in ASCII:
 * - JS `i` without `u` folds only ASCII letters against ASCII pattern letters
 *   (a non-ASCII char never canonicalises to an ASCII one), i.e. `grep -i`
 *   in the C locale;
 * - the default sort compares UTF-16 code units = bytes, i.e. `sort` in C.
 * The skill auto-run check is the exception: it was JavaScript already and
 * decoded paths and contents as UTF-8; that is kept as it was.
 *
 * foldAsciiCase below is the bytewise twin of shared/core/paths.ts
 * foldAsciiCase (same A–Z range, applied to git's raw bytes without NFC) —
 * a separate copy on purpose; client/tests/rule-parity-names.test.ts pins
 * the equivalence on NFC input.
 */
import { INSTRUCTION_FILE_NAMES } from '../../../shared/core/instruction-files'

export const ZERO_SHA = '0000000000000000000000000000000000000000'
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** Byte string of a UTF-8 text (for messages written next to raw bytes). */
export function utf8Bytes(text: string): string {
  return Buffer.from(text, 'utf8').toString('latin1')
}

/** `sort -u` under LC_ALL=C. */
export function sortUnique(lines: string[]): string[] {
  return [...new Set(lines)].sort()
}

/** Lines of a `$(...)`-captured list: split on "\n", empty lines dropped. */
export function nonEmptyLines(text: string): string[] {
  return text.split('\n').filter(l => l.length > 0)
}

/** Order-preserving de-duplication of non-empty lines (the hook's `awk '!seen[$0]++'`). */
export function dedupe(lines: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const l of lines) {
    if (l.length === 0 || seen.has(l)) continue
    seen.add(l)
    out.push(l)
  }
  return out
}

// ----------------------------------------------------------------------------
// Agent-execution config (owner/admin only)
// ----------------------------------------------------------------------------

/**
 * Claude Code runs commands from these files without asking (hooks, MCP
 * servers, statusLine, apiKeyHelper, env ...). Case-insensitive (macOS and
 * Windows read .Claude/Settings.json as .claude/settings.json); a file or
 * symlink named `.claude` itself counts too (a link to another folder would
 * otherwise create a .claude around the check).
 */
export const PROTECTED_RE = /(^|\/)\.mcp\.json$|(^|\/)\.claude$|(^|\/)\.claude\/settings(\.local)?\.json$|(^|\/)\.claude\/hooks(\/|$)/i

export function protectedPaths(changedLines: string[]): string[] {
  return sortUnique(changedLines.filter(l => PROTECTED_RE.test(l)))
}

/**
 * Instruction files Claude Code (CLAUDE.md, CLAUDE.local.md) and Codex
 * (AGENTS.md) load into every chat in or below their folder, at any depth,
 * case-insensitive. Whoever writes one steers every teammate's AI there (a
 * prompt injection that runs with the member's permissions), so they are
 * protected like agent config — with one difference (owner decision 案B):
 * a department manager may change the ones inside their own department
 * folder. CLAUDE.local.md is personal by convention (normally gitignored),
 * but once committed it is loaded exactly like CLAUDE.md for everyone, so it
 * gets the same protection — not a blanket refusal, which current apps
 * could not recover from (PROTECTED_CONFIG they can: restore the server's
 * version).
 *
 * The names come from shared/core/instruction-files.ts (the app's chat guard
 * uses the same list); they are ASCII, so this bytewise, ASCII-only `i`
 * match equals the core's A–Z-folded comparison.
 */
export const INSTRUCTION_FILE_RE = new RegExp(
  `(^|/)(${INSTRUCTION_FILE_NAMES.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`,
  'i',
)

export function instructionFilePaths(changedLines: string[]): string[] {
  return sortUnique(changedLines.filter(l => INSTRUCTION_FILE_RE.test(l)))
}

// ----------------------------------------------------------------------------
// Local-only folders (.backups, .workspace — never shared)
// ----------------------------------------------------------------------------

/**
 * Sync keeps conflict backups in `.backups/` and the AI's scratch files in
 * `.workspace/` (both in the essential .gitignore patterns, any depth). A
 * commit that adds or changes something inside one — made by hand, or by
 * another tool — would share a member's backups (the very versions they
 * lost a conflict with) or scratch files with the whole company.
 */
export const LOCAL_ONLY_RE = /(^|\/)\.(backups|workspace)\//i

/** `addedLines`: paths added or modified (deletions are allowed: that is how one gets unshared). */
export function localOnlyPaths(addedLines: string[]): string[] {
  return sortUnique(addedLines.filter(l => LOCAL_ONLY_RE.test(l)))
}

// ----------------------------------------------------------------------------
// Personal folders (.personal, never shared)
// ----------------------------------------------------------------------------

export const PERSONAL_RE = /(^|\/)\.personal\//i
/** The .gitignore directly inside a .personal folder (the server writes it). */
export const PERSONAL_ALLOWED_RE = /(^|\/)\.personal\/\.gitignore$/i

/** `addedLines`: paths added or modified (deletions already filtered out by git). */
export function personalPaths(addedLines: string[]): string[] {
  return sortUnique(addedLines.filter(l => PERSONAL_RE.test(l) && !PERSONAL_ALLOWED_RE.test(l)))
}

// ----------------------------------------------------------------------------
// Skills / subagents / slash commands with auto-run parts
// ----------------------------------------------------------------------------

/** Folder test on byte strings (the content-unavailable fallback lists raw paths). */
export const AUTORUN_DIR_RE = /(^|\/)\.claude\/(skills|agents|commands)(\/|$)/i
export const AUTORUN_UNAVAILABLE_REASON = '内容を確認できませんでした'

const AUTORUN_KEYS = ['hooks', 'mcpServers', 'lspServers', 'monitors']
// A key spelled as a whole YAML scalar: at line start / after "? " "- " "{" ","
// "[" / after an anchor or tag, optionally quoted, then ":" or the end of the
// scalar (an anchored "&a hooks" can be reused as a key through "*a :").
const AUTORUN_KEY_RE = new RegExp(
  String.raw`(?:^[ \t]*|[?\-][ \t]+|[{,\[][ \t]*|[&!]\S*[ \t]+)["']?(${AUTORUN_KEYS.join('|')})["']?[ \t]*(?::|$|[,\]}#])`,
  'gim')

/** Reasons a skill/agent/command Markdown file would run something on load. */
export function autorunFindings(buf: Buffer): string[] {
  let text = buf.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const found = new Set<string>()
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
    for (const m of fm.matchAll(AUTORUN_KEY_RE)) {
      found.add(`frontmatter の ${AUTORUN_KEYS.find(k => k.toLowerCase() === m[1].toLowerCase())}`)
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

/** What the auto-run check has to look at in one ref update. */
export interface AutorunTargets {
  symlinks: Set<string>
  /** Path → blob ids of the versions this push introduces (UTF-8 decoded paths). */
  blobsByPath: Map<string, Set<string>>
}

/**
 * Parse `git diff-tree -r --no-renames --no-abbrev -z` output (plain and
 * combined `-c`) for entries in skill/agent/command folders that are added or
 * modified. Throws on malformed input (the caller then fails closed).
 */
export function autorunTargets(raw: Buffer): AutorunTargets {
  const DIR = /(^|\/)\.claude\/(skills|agents|commands)(\/|$)/i
  const tokens = raw.toString('utf8').split('\0')
  const symlinks = new Set<string>()
  const blobsByPath = new Map<string, Set<string>>()
  for (let i = 0; i < tokens.length; i++) {
    const meta = tokens[i]
    if (!meta.startsWith(':')) continue
    const path = tokens[++i]
    if (path === undefined) throw new Error('truncated diff')
    // ":old new osha nsha S" / combined (merge) "::m1 m2 mR s1 s2 sR SS"
    const parents = (meta.match(/^:+/) as RegExpMatchArray)[0].length
    const f = meta.slice(parents).split(' ')
    const mode = f[parents]
    const sha = f[2 * parents + 1]
    if (!DIR.test(path)) continue
    if (mode === undefined || sha === undefined) throw new Error('bad diff line')
    if (/^0+$/.test(mode) || /^0+$/.test(sha)) continue // deleted
    if (mode === '120000') { symlinks.add(path); continue }
    if (mode === '160000' || !/\.md$/i.test(path)) continue
    if (!blobsByPath.has(path)) blobsByPath.set(path, new Set())
    ;(blobsByPath.get(path) as Set<string>).add(sha)
  }
  return { symlinks, blobsByPath }
}

/** Control characters shown as "?" (a path printed on one message line). */
export function cleanControl(p: string): string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return p.replace(/[\x00-\x1f\x7f]/g, '?')
}

/**
 * "path<TAB>reason" lines (UTF-8 text) for the violating entries, symlinks
 * first, each group sorted — the output of the hook's embedded node script.
 */
export function autorunReport(targets: AutorunTargets, contents: Map<string, Buffer>): string[] {
  const out: string[] = []
  for (const p of [...targets.symlinks].sort()) {
    out.push(`${cleanControl(p)}\tシンボリックリンク（リンク先を確認できません）`)
  }
  for (const [p, set] of [...targets.blobsByPath].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (targets.symlinks.has(p)) continue
    const all = new Set<string>()
    for (const sha of set) {
      const content = contents.get(sha)
      if (!content) throw new Error(`missing blob ${sha}`)
      for (const f of autorunFindings(content)) all.add(f)
    }
    if (all.size > 0) out.push(`${cleanControl(p)}\t${[...all].join(', ')}`)
  }
  return out
}

/**
 * The fallback when the content cannot be checked: every path in those
 * folders that the raw diff mentions (deletions and non-Markdown included),
 * as byte strings "path<TAB>内容を確認できませんでした".
 */
export function autorunUnavailable(rawBytes: string): string[] {
  const lines = rawBytes.replace(/\0/g, '\n').split('\n')
    .filter(l => !l.startsWith(':') && AUTORUN_DIR_RE.test(l))
  return sortUnique(lines).map(l => `${l}\t${utf8Bytes(AUTORUN_UNAVAILABLE_REASON)}`)
}

// ----------------------------------------------------------------------------
// Windows-incompatible paths
// ----------------------------------------------------------------------------

// [[:cntrl:]] in the C locale = 0x00-0x1f and 0x7f
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const BAD_CHARS_RE = /[<>:"\\|?*]|[\x00-\x1f\x7f]/
const BAD_TRAIL_RE = /(\.| )(\/|$)/
const BAD_RESERVED_RE = /(^|\/)(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.[^/]*)?(\/|$)/i

/** A–Z → a–z only (`tr '[:upper:]' '[:lower:]'` in the C locale). */
export function foldAsciiCase(s: string): string {
  return s.replace(/[A-Z]+/g, m => m.toLowerCase())
}

/**
 * `treeLines`: `git -c core.quotePath=false ls-tree -r --name-only <new>`
 * output lines (byte strings). Returns the reported entries (byte strings) in
 * the hook's order: bad characters, trailing dot/space, reserved names, case
 * collisions (folded, sorted).
 */
export function windowsPathProblems(treeLines: string[]): string[] {
  const chars = utf8Bytes(' （Windowsで使用できない文字を含む）')
  const trail = utf8Bytes(' （フォルダ・ファイル名の末尾がドットまたはスペース）')
  const reserved = utf8Bytes(' （Windows予約デバイス名）')
  const caseDup = utf8Bytes(' （大文字小文字のみ異なるパスが複数存在）')
  const out: string[] = []
  for (const l of treeLines) if (BAD_CHARS_RE.test(l)) out.push(l + chars)
  for (const l of treeLines) if (BAD_TRAIL_RE.test(l)) out.push(l + trail)
  for (const l of treeLines) if (BAD_RESERVED_RE.test(l)) out.push(l + reserved)
  // Paths that differ only by case are one file on the default macOS/Windows
  // file systems. A–Z only, bytewise: full-width (Ａ/ａ) and accented (É/é)
  // pairs are not folded; Japanese names have no case, so no false positives.
  const folded = treeLines.map(foldAsciiCase).sort()
  for (let i = 1; i < folded.length; i++) {
    if (folded[i] === folded[i - 1] && (i === 1 || folded[i - 2] !== folded[i])) out.push(folded[i] + caseDup)
  }
  return out.filter(l => l.length > 0)
}

// ----------------------------------------------------------------------------
// Gitlinks (nested repositories)
// ----------------------------------------------------------------------------

/** Paths whose new mode is 160000 in `git diff-tree -r <base> <new>` output (byte string). */
export function addedGitlinks(diffTreeOut: string): string[] {
  const out: string[] = []
  for (const line of diffTreeOut.split('\n')) {
    const fields = line.split('\t')
    const modes = fields[0].split(/[ \t\n]+/).filter(s => s.length > 0)
    if (modes[1] === '160000') out.push(fields[1] ?? '')
  }
  return out
}

// ----------------------------------------------------------------------------
// Secrets
// ----------------------------------------------------------------------------

export const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'AWS Access Key ID', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Private Key', re: /-----BEGIN (RSA|EC|OPENSSH|DSA|PGP) PRIVATE KEY-----/ },
  { name: 'GitHub Personal Access Token', re: /ghp_[0-9a-zA-Z]{36}/ },
  { name: 'GitHub OAuth Token', re: /gho_[0-9a-zA-Z]{36}/ },
  { name: 'GitHub Fine-grained PAT', re: /github_pat_[0-9a-zA-Z_]{22,}/ },
  { name: 'OpenAI/Anthropic API Key', re: /sk-[a-zA-Z0-9]{20,}/ },
  { name: 'Slack Token', re: /xox[bpsa]-[0-9a-zA-Z-]{10,}/ },
  { name: 'Google API Key', re: /AIza[0-9A-Za-z_-]{35}/ },
]

/**
 * Secret scan over a unified diff, fed line by line (byte strings).
 *
 * Only added lines ("+...") are scanned; file names come from the "+++ b/"
 * headers (a trailing tab that git adds to names with spaces is removed;
 * quoted names stay quoted) and are never scanned themselves. Combined diffs
 * of merge commits (`diff --cc` / `diff --combined`, N marker columns) count
 * a line only when it is added relative to every parent ("++"): content the
 * merge brings in from one side is that side's commit's business — new
 * commits are scanned on their own, and the server's are already there.
 * Several diffs can be fed to one scanner; entries stay deduplicated.
 * - 'line': each added line counts for the first pattern it matches; one
 *   entry per file × pattern, in diff order (existing branches: the net
 *   old..new diff, then every new commit's own diff);
 * - 'file': one entry per file, with the lowest-numbered pattern found
 *   anywhere in it, files in order of their first hit (new branches: the
 *   whole content of the files the tip commit changed).
 */
/** "@@ ..." → 1, "@@@ ..." (combined diff, two parents) → 2, … */
function hunkColumns(line: string): number {
  let n = 0
  while (line.charCodeAt(n) === 64 /* @ */) n++
  return Math.max(1, n - 1)
}

export class SecretScanner {
  private header = false
  private file = ''
  /** Marker columns of the current hunk: 1, or the parent count of a combined diff. */
  private columns = 1
  private readonly seen = new Set<string>()
  private readonly lineEntries: string[] = []
  private readonly fileOrder: string[] = []
  private readonly fileBest = new Map<string, number>()

  constructor(private readonly mode: 'line' | 'file') {}

  push(line: string): void {
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      this.header = true
      this.file = ''
      this.columns = 1
      return
    }
    if (this.header) {
      if (line.startsWith('+++ ')) {
        let p = line.slice(4)
        if (p.startsWith('"b/')) this.file = '"' + p.slice(3)
        else {
          if (p.startsWith('b/')) p = p.slice(2)
          if (p.endsWith('\t')) p = p.slice(0, -1)
          this.file = p
        }
      } else if (line.startsWith('@@')) {
        this.header = false
        this.columns = hunkColumns(line)
      }
      return
    }
    if (line.startsWith('@@')) {
      this.columns = hunkColumns(line)
      return
    }
    for (let c = 0; c < this.columns; c++) if (line.charCodeAt(c) !== 43 /* + */) return
    const content = line.slice(this.columns)
    let best = -1
    for (let i = 0; i < SECRET_PATTERNS.length; i++) {
      if (SECRET_PATTERNS[i].re.test(content)) { best = i; break }
    }
    if (best === -1) return
    if (this.mode === 'line') {
      const key = `${this.file}\0${best}`
      if (this.seen.has(key)) return
      this.seen.add(key)
      this.lineEntries.push(`  - ${this.file} (${SECRET_PATTERNS[best].name})`)
      return
    }
    const prev = this.fileBest.get(this.file)
    if (prev === undefined) {
      this.fileOrder.push(this.file)
      this.fileBest.set(this.file, best)
    } else if (best < prev) this.fileBest.set(this.file, best)
  }

  /** "  - <file> (<pattern name>)" entries (byte strings). */
  entries(): string[] {
    if (this.mode === 'line') return [...this.lineEntries]
    return this.fileOrder.map(f => `  - ${f} (${SECRET_PATTERNS[this.fileBest.get(f) as number].name})`)
  }
}

// ----------------------------------------------------------------------------
// Ref lines
// ----------------------------------------------------------------------------

export interface RefUpdate {
  oldSha: string
  newSha: string
  refname: string
}

/**
 * pre-receive stdin ("<old> <new> <ref>" per line), read like bash's
 * `while read old new ref`: whitespace-separated, the ref takes the rest, and
 * a last line without a newline is not processed.
 */
export function parseRefUpdates(input: string): RefUpdate[] {
  const lines = input.split('\n')
  lines.pop() // the part after the last newline (empty, or an unterminated line)
  const out: RefUpdate[] = []
  for (const line of lines) {
    const trimmed = line.replace(/^[ \t]+/, '')
    const m = /^(\S*)[ \t]*(\S*)[ \t]*(.*)$/.exec(trimmed) as RegExpExecArray
    out.push({ oldSha: m[1], newSha: m[2], refname: m[3].replace(/[ \t]+$/, '') })
  }
  return out
}
