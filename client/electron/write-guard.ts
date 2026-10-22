/**
 * Chat write guard: refuse an AI edit inside a folder the member may only
 * read, BEFORE the tool runs.
 *
 * Without it the AI happily edits a read-only folder, the push is rejected
 * with [WRITE_DENIED], and sync puts the server version back and moves the
 * edit to .backups/ — which members experience as "the AI's work vanished".
 * The server check and that recovery stay the safety net: this guard never
 * blocks when it does not know (no cached write access), and only judges
 * paths inside the company root.
 *
 * Covered: Claude Code's Write / Edit / MultiEdit / NotebookEdit (from the
 * PreToolUse hook in agents/claude.ts, which runs in every permission mode,
 * bypassPermissions included, and for subagents), the api-key mode's
 * writeFile tool, and — best effort — Bash output redirections (`>`, `>>`,
 * `&>`, `tee`) to a literal path. Not covered: other Bash writes (cp, mv,
 * sed -i, scripts, `cd X && … > y`), Codex. Those still meet the server.
 *
 * The same check refuses writes into a folder that is not downloaded on
 * this computer (sparse exclusions, `getNotDownloaded`) — known locally, so
 * it applies even when the write access is unknown. Sync's outside-checkout
 * hold-back (sync/outside-checkout.ts) stays the safety net there.
 *
 * Two more refusals share the hook:
 * - AI instruction files (CLAUDE.md / AGENTS.md, any depth, A–Z case
 *   folded) for a member who may not change them: owners/admins anywhere,
 *   department managers inside their own department — the server's push
 *   check enforces the same rule; unknown authority never blocks.
 * - `git clone` (and `gh repo clone`) into the company folder outside
 *   `.workspace/`: an external repository there would be shared with the
 *   whole company (or stop sync as a nested repository).
 */
import { evaluateWrite, readOnlyMessage, repoRelativePath, type WriteAccess } from '../shared/write-access'
import { excludedFolderOf, notDownloadedAgentMessage } from '../shared/sparse-paths'

export interface WriteGuard {
  /** The company's checkout root (absolute). */
  root: string
  /** Current write access, read on every call (refreshed by sync); undefined = unknown → allow. */
  getAccess: () => WriteAccess | undefined
  /**
   * Folders not downloaded on this computer (repository-relative; read on
   * every call, see sync/not-downloaded.ts). A write there is refused
   * whatever the access: sync would hold the file back instead of sharing it.
   */
  getNotDownloaded?: () => readonly string[]
  /**
   * Private folders the member may read (company-relative; read on every
   * call; undefined = unknown). Not used by this guard: the private-read
   * guard (private-read-guard.ts) asks before their content goes public.
   */
  getPrivateFolders?: () => readonly string[] | undefined
  /**
   * Who may change AI instruction files (read on every call; undefined =
   * unknown → not blocked): the member's role and the folders of the
   * departments they manage (company-relative).
   */
  getInstructionAuthority?: () => InstructionAuthority | undefined
}

export interface InstructionAuthority {
  role: string
  managedFolders: readonly string[]
}

const INSTRUCTION_FILES = new Set(['claude.md', 'agents.md'])
const FULL_ACCESS_ROLES = new Set(['owner', 'admin'])

/** CLAUDE.md / AGENTS.md at any depth, A–Z case-insensitive (the server's push check folds the same way). */
export function isInstructionFile(repoPath: string): boolean {
  const name = repoPath.normalize('NFC').split('/').pop() ?? ''
  return INSTRUCTION_FILES.has(name.replace(/[A-Z]+/g, m => m.toLowerCase()))
}

/** May this member change the instruction file at `repoPath`? */
export function mayChangeInstructionFile(authority: InstructionAuthority, repoPath: string): boolean {
  if (FULL_ACCESS_ROLES.has(authority.role)) return true
  const folder = repoPath.normalize('NFC').split('/').slice(0, -1).join('/')
  if (folder === '') return false
  return excludedFolderOf(authority.managedFolders.map(f => f.normalize('NFC')), `${folder}/x`) !== null
}

/** Never shared (the app's scratch area, backups, personal folders): the push check never sees them. */
function isUnsharedPath(rel: string): boolean {
  const segments = rel.normalize('NFC').split('/')
  if (segments[0] === '.workspace' || segments[0] === '.backups') return true
  return segments.slice(0, -1).some(s => s.toLowerCase() === '.personal')
}

export function instructionFileMessage(path: string): string {
  return `このファイル（${path}）はAIへの指示ファイルのため、管理者（部署内は部署の責任者）だけが変更できます。変更が必要な場合は、管理者か部署の責任者に依頼してください。`
}

export type GuardDecision =
  | { deny: false }
  | { deny: true; path: string; folder: string; message: string }

const FILE_TOOLS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}

/** Decide for one absolute-or-relative target path. */
export function checkWritePath(guard: WriteGuard, target: string, cwd?: string): GuardDecision {
  if (!target) return { deny: false }
  const rel = repoRelativePath(guard.root, target, cwd)
  if (rel === null) return { deny: false } // outside the company: not ours to judge
  // Not downloaded: the member (and the AI) cannot see what teammates keep
  // there, and sync would hold the file back rather than share it.
  const notDownloaded = guard.getNotDownloaded?.() ?? []
  const missing = notDownloaded.length > 0 ? excludedFolderOf(notDownloaded, rel) : null
  if (missing !== null) {
    const folder = missing.normalize('NFC')
    return { deny: true, path: rel, folder, message: notDownloadedAgentMessage(folder) }
  }
  if (isInstructionFile(rel) && !isUnsharedPath(rel)) {
    const authority = guard.getInstructionAuthority?.()
    if (authority && !mayChangeInstructionFile(authority, rel)) {
      return { deny: true, path: rel, folder: rel.split('/').slice(0, -1).join('/'), message: instructionFileMessage(rel) }
    }
  }
  const access = guard.getAccess()
  if (!access || access.all) return { deny: false }
  const decision = evaluateWrite(access, rel)
  if (decision.write) return { deny: false }
  const folder = decision.scopePath ?? rel.split('/').slice(0, -1).join('/')
  return { deny: true, path: rel, folder, message: readOnlyMessage(folder) }
}

/**
 * Literal redirection / tee targets of a shell command, conservatively: only
 * operators outside quotes, only words without expansions or globs, and
 * nothing after a heredoc starts. Returns [] when the command changes
 * directory (relative targets would be resolved against the wrong folder).
 */
export function bashWriteTargets(command: string): string[] {
  const newline = command.indexOf('\n')
  const firstLine = command.includes('<<') && newline >= 0 ? command.slice(0, newline) : command
  if (/(^|[\s;&|(])(cd|pushd)(\s|$)/.test(command)) return []
  if (/\(\(|\[\[/.test(firstLine)) return [] // arithmetic and [[ ]] tests use '>' too
  // Tokenise: words (quotes removed) and operators.
  type Tok = { op?: string; word?: string; literal: boolean }
  const toks: Tok[] = []
  let i = 0
  const s = firstLine
  while (i < s.length) {
    const ch = s[i]
    if (/\s/.test(ch)) { i++; continue }
    const op = /^(&>>|&>|\d*>>|\d*>&|\d*>\||\d*>|\||;|&&|&|<|\(|\))/.exec(s.slice(i))
    if (op) {
      toks.push({ op: op[0].replace(/^\d+/, ''), literal: true })
      i += op[0].length
      continue
    }
    let word = ''
    let literal = true
    while (i < s.length && !/\s/.test(s[i]) && !/[|;&<>()]/.test(s[i])) {
      const c = s[i]
      if (c === "'") {
        const end = s.indexOf("'", i + 1)
        if (end < 0) return []
        word += s.slice(i + 1, end); i = end + 1
      } else if (c === '"') {
        const end = s.indexOf('"', i + 1)
        if (end < 0) return []
        const inner = s.slice(i + 1, end)
        if (/[$`\\]/.test(inner)) literal = false
        word += inner; i = end + 1
      } else {
        if (/[$`*?[\]{}~\\]/.test(c)) literal = false
        word += c; i++
      }
    }
    toks.push({ word, literal })
  }
  const targets: string[] = []
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]
    if (t.op && ['>', '>>', '>|', '&>', '&>>'].includes(t.op)) {
      const next = toks[k + 1]
      if (next?.word !== undefined && next.literal && next.word) targets.push(next.word)
    }
    // tee [-a] file...
    if (t.word === 'tee' && (k === 0 || toks[k - 1].op === '|' || toks[k - 1].op === ';' || toks[k - 1].op === '&&')) {
      for (let m = k + 1; m < toks.length && toks[m].word !== undefined; m++) {
        const w = toks[m]
        if (w.word!.startsWith('-')) continue
        if (w.literal && w.word) targets.push(w.word)
      }
    }
  }
  return targets.filter(p => !p.startsWith('/dev/'))
}

/** The PreToolUse decision for one Claude Code tool call. */
export function decideToolWrite(guard: WriteGuard | undefined, toolName: string, toolInput: Record<string, unknown> | undefined, cwd?: string): GuardDecision {
  if (!guard) return { deny: false }
  const key = FILE_TOOLS[toolName]
  if (key) {
    const target = toolInput?.[key]
    return typeof target === 'string' ? checkWritePath(guard, target, cwd) : { deny: false }
  }
  if (toolName === 'Bash') {
    const command = toolInput?.command
    if (typeof command !== 'string') return { deny: false }
    const clone = checkGitClone(guard.root, command, cwd)
    if (clone.deny) return clone
    for (const target of bashWriteTargets(command)) {
      const d = checkWritePath(guard, target, cwd)
      if (d.deny) return d
    }
  }
  return { deny: false }
}

// ---------------------------------------------------------------------------
// git clone → .workspace/
// ---------------------------------------------------------------------------

/** Words of one simple command, quotes removed; `literal` is false when a word has an expansion. */
function shellWords(segment: string): Array<{ word: string; literal: boolean }> {
  const out: Array<{ word: string; literal: boolean }> = []
  for (const m of segment.match(/(?:'[^']*'|"[^"]*"|[^\s'"]+)+/g) ?? []) {
    const literal = !/[$`*?{}~]/.test(m.replace(/'[^']*'/g, ''))
    out.push({ word: m.replace(/'([^']*)'|"([^"]*)"/g, (_, a, b) => a ?? b ?? ''), literal })
  }
  return out
}

/** Options of `git clone` that take a separate value. */
const CLONE_VALUE_OPTIONS = new Set(['-b', '--branch', '-o', '--origin', '-c', '--config', '--depth', '--reference', '--reference-if-able', '-u', '--upload-pack', '--separate-git-dir', '--template', '--filter', '-j', '--jobs', '--shallow-since', '--shallow-exclude', '--server-option', '--bundle-uri', '--ref-format'])

/** The directory name git picks for a clone without one: last path part, minus `.git`. */
export function defaultCloneDir(repo: string): string {
  const trimmed = repo.replace(/[\\/]+$/, '').replace(/\.git$/i, '').replace(/[\\/]+$/, '')
  const last = trimmed.split(/[\\/:]/).pop() ?? ''
  return last || 'repo'
}

export function cloneMessage(name: string): string {
  return `外部のGitリポジトリは、会社フォルダ直下の「.workspace/」の中に置いてください（.workspace/ は共有されません）。会社フォルダの他の場所に置くと、会社の全員に共有されたり、同期が止まったりします。例: git clone <URL> .workspace/${name}`
}

/**
 * Where each `git clone` / `gh repo clone` in a shell command would put the
 * repository: the target as written plus the directory it is relative to
 * (`cwd`, a literal `cd` before it, `git -C`). Clones whose target cannot be
 * worked out (expansions, `cd $X`) are left out.
 */
export function gitCloneTargets(command: string, cwd?: string): Array<{ target: string; cwd?: string; name: string }> {
  const found: Array<{ target: string; cwd?: string; name: string }> = []
  let dir = cwd
  let dirKnown = true
  const join = (base: string | undefined, p: string) => (p.startsWith('/') || !base ? p : `${base}/${p}`)
  for (const segment of command.split(/&&|\|\||;|\n|\|/)) {
    const words = shellWords(segment.trim())
    if (words.length === 0) continue
    const head = words[0].word
    if (head === 'cd' || head === 'pushd') {
      const to = words[1]
      if (to && to.literal && to.word !== '-') dir = join(dir, to.word)
      else dirKnown = false
      continue
    }
    let rest: typeof words
    let here = dir
    let hereKnown = dirKnown
    if (/(^|\/)git$/.test(head)) {
      let i = 1
      for (; i < words.length && words[i].word.startsWith('-'); i++) {
        const w = words[i].word
        if (w === '-C') {
          const to = words[++i]
          if (to?.literal) here = join(here, to.word)
          else hereKnown = false
        } else if (w === '-c' || w === '--git-dir' || w === '--work-tree' || w === '--namespace') i++
      }
      if (words[i]?.word !== 'clone') continue
      rest = words.slice(i + 1)
    } else if (/(^|\/)gh$/.test(head) && words[1]?.word === 'repo' && words[2]?.word === 'clone') {
      const dash = words.findIndex(w => w.word === '--')
      rest = words.slice(3, dash >= 0 ? dash : undefined)
    } else continue
    if (!hereKnown) continue
    const positional: typeof words = []
    for (let k = 0; k < rest.length; k++) {
      const w = rest[k].word
      if (w === '--') { positional.push(...rest.slice(k + 1)); break }
      if (w.startsWith('-')) {
        if (CLONE_VALUE_OPTIONS.has(w)) k++
        continue
      }
      positional.push(rest[k])
    }
    const repo = positional[0]
    if (!repo) continue
    const target = positional[1]
    if (target && !target.literal) continue
    const name = defaultCloneDir(target ? target.word : repo.word)
    found.push({ target: target ? target.word : name, cwd: here, name })
  }
  return found
}

/** Refuse a clone into the company folder outside `.workspace/`. */
export function checkGitClone(root: string, command: string, cwd?: string): GuardDecision {
  if (!/\bclone\b/.test(command)) return { deny: false }
  for (const clone of gitCloneTargets(command, cwd)) {
    const rel = repoRelativePath(root, clone.target, clone.cwd ?? root)
    if (rel === null) continue // outside the company: not shared
    const segments = rel.normalize('NFC').split('/')
    if (segments[0] === '.workspace' && segments.length > 1) continue
    return { deny: true, path: rel, folder: segments.slice(0, -1).join('/'), message: cloneMessage(clone.name) }
  }
  return { deny: false }
}
