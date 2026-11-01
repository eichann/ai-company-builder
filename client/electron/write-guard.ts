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
 * - AI instruction files (CLAUDE.md / CLAUDE.local.md / AGENTS.md, any depth, A–Z case
 *   folded) for a member who may not change them: owners/admins anywhere,
 *   department managers inside their own department — the server's push
 *   check enforces the same rule; unknown authority never blocks.
 * - `git clone` (and `gh repo clone`) into the company folder outside
 *   `.workspace/`: an external repository there would be shared with the
 *   whole company (or stop sync as a nested repository).
 * - The company map (records.md): type definitions (`.acb/types/`, at the
 *   company root) for a member who is not owner/admin (the push check's
 *   rule; unknown authority never blocks), and — `decideRecordEdit` — a
 *   Write / Edit / MultiEdit that would write state, assignee, due… into a
 *   record file's frontmatter, or change an existing record's id or type:
 *   the AI changes a record only through the record tools (records/tools.ts).
 * Private folders (`getPrivateFolderView`): a write that would create
 * something at a folder name the member may not use (a private folder they
 * cannot read; asked of the server, decideReservedWrite) is refused with the
 * server's [RESERVED_PATH] sentence (it names only what the AI typed), and a
 * write into a private folder the member may only read with the read-only
 * message. Sync's reserved-path hold-back
 * (sync/reserved-path.ts) stays the safety net.
 */
import { evaluateWrite, readOnlyMessage, repoRelativePath, type WriteAccess } from '../shared/write-access'
import { excludedFolderOf, notDownloadedAgentMessage } from '../shared/sparse-paths'
import { reservedPathMessage } from '../../shared/types/private-folders'
import { isInstructionFile, mayChangeInstructionFile } from '../../shared/core/instruction-files'
import { recordFileEditProblem } from '../../shared/core/records'
import { FULL_ACCESS_ROLES } from '../../shared/core/permissions'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { GuardReason } from '../shared/agent-events'

/** Private folders as the guard sees them (from the cached /me/scopes answer, sync/private-folders.ts). */
export interface PrivateFolderView {
  /**
   * The private folder — in the spelling of `rel` — that `rel` would write
   * into although the member cannot read it, or null. A write there is
   * refused with the server's [RESERVED_PATH] wording: sync would move the
   * file to .backups/ instead of sharing it. `file`: `rel` will be a file —
   * also refused (named `rel`) when a private folder lies below it, as the
   * push check refuses such a file.
   */
  reservedFolderOf(rel: string, options?: { file?: boolean }): Promise<string | null>
  /** The readable private folder `rel` lies in when the member may only read it (canWrite false), or null. */
  readOnlyFolderOf(rel: string): string | null
}

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
  /** Private folders for the reserved-name and read-only checks (read on every call); undefined = none known. */
  getPrivateFolderView?: () => PrivateFolderView | undefined
}

/** Who may change AI instruction files: the member's role and the folders of the departments they manage. */
export interface InstructionAuthority {
  role: string
  managedFolders: readonly string[]
}

// Which files are AI instruction files, and who may change them, is the
// server's own rule (shared/core/instruction-files.ts; the push check uses
// the same copy).
export { isInstructionFile, mayChangeInstructionFile }

/** Never shared (the app's scratch area, backups, personal folders): the push check never sees them. */
function isUnsharedPath(rel: string): boolean {
  const segments = rel.normalize('NFC').split('/')
  if (segments[0] === '.workspace' || segments[0] === '.backups') return true
  return segments.slice(0, -1).some(s => s.toLowerCase() === '.personal')
}

export function instructionFileMessage(path: string): string {
  return `このファイル（${path}）はAIへの指示ファイルのため、管理者（部署内は部署の責任者）だけが変更できます。変更が必要な場合は、管理者か部署の責任者に依頼してください。`
}

export function typeDefinitionMessage(path: string): string {
  return `このファイル（${path}）は会社の記録の形を決める定義のため、オーナーと管理者だけが変更できます。変更が必要な場合は、管理者に依頼してください。`
}

export function recordFileMessage(path: string, problem: 'state' | 'identity'): string {
  return problem === 'state'
    ? `記録のファイル（${path}）の先頭には id・type・links だけを書きます。状態・担当・期限などはサーバーが持つため、ファイルには書けません。変えるときは記録の道具（mcp__acb_records__…）を使ってください。`
    : `記録のファイル（${path}）の id と type は変えられません（別の記録になってしまうため）。内容の文章だけを編集してください。`
}

/** `.acb/types/` at the company root, or a file named `.acb` there (the push check's rule, A–Z folded). */
const TYPE_DEFINITION_RE = /^\.acb\/types(\/|$)|^\.acb$/i

export type GuardDecision =
  | { deny: false }
  /** `code`: which rule refused, for the AI action log (shared/agent-events.ts); never shown. */
  | { deny: true; path: string; folder: string; message: string; code: GuardReason }

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
    return { deny: true, path: rel, folder, message: notDownloadedAgentMessage(folder), code: 'not-downloaded' }
  }
  if (isInstructionFile(rel) && !isUnsharedPath(rel)) {
    const authority = guard.getInstructionAuthority?.()
    if (authority && !mayChangeInstructionFile(authority, rel)) {
      return { deny: true, path: rel, folder: rel.split('/').slice(0, -1).join('/'), message: instructionFileMessage(rel), code: 'instruction-file' }
    }
  }
  if (TYPE_DEFINITION_RE.test(rel)) {
    const authority = guard.getInstructionAuthority?.()
    if (authority && !FULL_ACCESS_ROLES.has(authority.role)) {
      return { deny: true, path: rel, folder: '.acb/types', message: typeDefinitionMessage(rel), code: 'type-definition' }
    }
  }
  // A private folder the member may only read: known locally (cached
  // /me/scopes), so it applies even when the write access is unknown. Folder
  // names the member may not use are asked of the server: decideReservedWrite.
  const privateFolders = guard.getPrivateFolderView?.()
  if (privateFolders) {
    const readOnly = privateFolders.readOnlyFolderOf(rel)
    if (readOnly !== null) return { deny: true, path: rel, folder: readOnly, message: readOnlyMessage(readOnly), code: 'read-only-folder' }
  }
  const access = guard.getAccess()
  if (!access || access.all) return { deny: false }
  const decision = evaluateWrite(access, rel)
  if (decision.write) return { deny: false }
  const folder = decision.scopePath ?? rel.split('/').slice(0, -1).join('/')
  return { deny: true, path: rel, folder, message: readOnlyMessage(folder), code: 'read-only-folder' }
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

/**
 * The write targets of one tool call (absolute or relative), as
 * decideToolWrite judges them.
 */
function toolWriteTargets(toolName: string, toolInput: Record<string, unknown> | undefined): string[] {
  const key = FILE_TOOLS[toolName]
  if (key) {
    const target = toolInput?.[key]
    return typeof target === 'string' && target ? [target] : []
  }
  if (toolName === 'Bash' && typeof toolInput?.command === 'string') return bashWriteTargets(toolInput.command)
  return []
}

/**
 * The reserved-name half of the guard, asked of the server (POST
 * …/paths/check, cached): a write that would create something at a folder
 * name the member may not use — a private folder they cannot read — is
 * refused with the server's sentence, naming only what the AI typed. Unknown
 * answers allow. Run after decideToolWrite.
 */
export async function decideReservedWrite(guard: WriteGuard | undefined, toolName: string, toolInput: Record<string, unknown> | undefined, cwd?: string): Promise<GuardDecision> {
  const view = guard?.getPrivateFolderView?.()
  if (!guard || !view) return { deny: false }
  for (const target of toolWriteTargets(toolName, toolInput)) {
    const rel = repoRelativePath(guard.root, target, cwd)
    if (!rel) continue
    // Every target of these tools is a file.
    const reserved = await view.reservedFolderOf(rel, { file: true }).catch(() => null)
    if (reserved !== null) {
      const folder = reserved.normalize('NFC')
      return { deny: true, path: rel, folder, message: reservedPathMessage(folder), code: 'reserved-path' }
    }
  }
  return { deny: false }
}

/**
 * Edits of a record file (`.md` with a `type` in its frontmatter) that only
 * the record tools may make: state & co. in the frontmatter, or another id /
 * type. `read` gives the file as it is now (null: none yet). Best effort, like
 * the rest of this guard: Bash writes are not inspected, and the server never
 * reads state from files anyway (records.md).
 */
export function decideRecordEdit(
  guard: WriteGuard | undefined, toolName: string, toolInput: Record<string, unknown> | undefined, cwd?: string,
  read: (absolute: string) => string | null = absolute => { try { return readFileSync(absolute, 'utf8') } catch { return null } },
): GuardDecision {
  if (!guard || !toolInput || !['Write', 'Edit', 'MultiEdit'].includes(toolName)) return { deny: false }
  const target = toolInput.file_path
  if (typeof target !== 'string' || !/\.md$/i.test(target)) return { deny: false }
  const rel = repoRelativePath(guard.root, target, cwd)
  if (rel === null || isUnsharedPath(rel)) return { deny: false }
  const absolute = path.resolve(cwd ?? guard.root, target)
  const before = read(absolute)
  let after: string | null = null
  if (toolName === 'Write') after = typeof toolInput.content === 'string' ? toolInput.content : null
  else {
    const edits = toolName === 'Edit' ? [toolInput] : Array.isArray(toolInput.edits) ? toolInput.edits as Array<Record<string, unknown>> : []
    after = before
    for (const e of edits) {
      if (after === null || typeof e?.old_string !== 'string' || typeof e?.new_string !== 'string') { after = null; break }
      after = e.replace_all === true ? after.split(e.old_string).join(e.new_string) : after.replace(e.old_string, () => e.new_string as string)
    }
  }
  if (after === null) return { deny: false }
  const problem = recordFileEditProblem(before, after)
  if (!problem) return { deny: false }
  return { deny: true, path: rel, folder: rel.split('/').slice(0, -1).join('/'), message: recordFileMessage(rel, problem), code: 'record-file' }
}

/** The PreToolUse decision for one Claude Code tool call. */
export function decideToolWrite(guard: WriteGuard | undefined, toolName: string, toolInput: Record<string, unknown> | undefined, cwd?: string): GuardDecision {
  if (!guard) return { deny: false }
  const key = FILE_TOOLS[toolName]
  if (key) {
    const target = toolInput?.[key]
    if (typeof target !== 'string') return { deny: false }
    const path = checkWritePath(guard, target, cwd)
    return path.deny ? path : decideRecordEdit(guard, toolName, toolInput, cwd)
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

type ShellWord = { word: string; literal: boolean }

/**
 * Each `git <sub>` (and `gh repo clone`, as sub 'clone') in a shell command:
 * the words after the subcommand and the directory it runs in (`cwd`, a
 * literal `cd` before it, `git -C`). Invocations whose directory cannot be
 * worked out (`cd $X`) are left out.
 */
function gitInvocations(command: string, cwd?: string): Array<{ sub: string; rest: ShellWord[]; here?: string }> {
  const found: Array<{ sub: string; rest: ShellWord[]; here?: string }> = []
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
      if (!words[i] || !hereKnown) continue
      found.push({ sub: words[i].word, rest: words.slice(i + 1), here })
    } else if (/(^|\/)gh$/.test(head) && words[1]?.word === 'repo' && words[2]?.word === 'clone') {
      const dash = words.findIndex(w => w.word === '--')
      if (hereKnown) found.push({ sub: 'clone', rest: words.slice(3, dash >= 0 ? dash : undefined), here })
    }
  }
  return found
}

/** Positional words of a subcommand, skipping options (and the values of `valueOptions`). */
function positionalWords(rest: ShellWord[], valueOptions: Set<string>): ShellWord[] {
  const positional: ShellWord[] = []
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k].word
    if (w === '--') { positional.push(...rest.slice(k + 1)); break }
    if (w.startsWith('-')) {
      if (valueOptions.has(w)) k++
      continue
    }
    positional.push(rest[k])
  }
  return positional
}

/**
 * Where each `git clone` / `gh repo clone` in a shell command would put the
 * repository: the target as written plus the directory it is relative to
 * (`cwd`, a literal `cd` before it, `git -C`). Clones whose target cannot be
 * worked out (expansions, `cd $X`) are left out.
 */
export function gitCloneTargets(command: string, cwd?: string): Array<{ target: string; cwd?: string; name: string }> {
  const found: Array<{ target: string; cwd?: string; name: string }> = []
  for (const { sub, rest, here } of gitInvocations(command, cwd)) {
    if (sub !== 'clone') continue
    const positional = positionalWords(rest, CLONE_VALUE_OPTIONS)
    const repo = positional[0]
    if (!repo) continue
    const target = positional[1]
    if (target && !target.literal) continue
    const name = defaultCloneDir(target ? target.word : repo.word)
    found.push({ target: target ? target.word : name, cwd: here, name })
  }
  return found
}

/** Options of `git init` that take a separate value. */
const INIT_VALUE_OPTIONS = new Set(['-b', '--initial-branch', '--template', '--separate-git-dir', '--object-format', '--ref-format'])

export function initMessage(name: string): string {
  return `新しいGitリポジトリは、会社フォルダ直下の「.workspace/」の中に作ってください（.workspace/ は共有されません）。会社フォルダの他の場所に作ると、同期のたびにメンバーに確認が表示され、中身は共有されません。例: git init .workspace/${name}`
}

/**
 * Where each `git init` in a shell command would create a repository: its
 * directory argument (default `.`) and the directory it is relative to.
 * Targets that cannot be worked out (expansions, `cd $X`) are left out.
 */
export function gitInitTargets(command: string, cwd?: string): Array<{ target: string; cwd?: string; name: string }> {
  const found: Array<{ target: string; cwd?: string; name: string }> = []
  for (const { sub, rest, here } of gitInvocations(command, cwd)) {
    if (sub !== 'init') continue
    const target = positionalWords(rest, INIT_VALUE_OPTIONS)[0]
    if (target && !target.literal) continue
    const word = target ? target.word : '.'
    const lastPart = (p?: string) => p?.replace(/[\\/]+$/, '').split(/[\\/]/).filter(x => x && x !== '.' && x !== '..').pop()
    const name = lastPart(word) ?? lastPart(here) ?? 'repo'
    found.push({ target: word, cwd: here, name })
  }
  return found
}

/** Is a repository at this company-relative path inside `.workspace/` (not `.workspace` itself)? */
function inWorkspace(rel: string): boolean {
  const segments = rel.normalize('NFC').split('/')
  return segments[0] === '.workspace' && segments.length > 1
}

/**
 * Refuse a clone, or a new `git init`, into the company folder outside
 * `.workspace/`. Sync would not share such a repository (it asks the member
 * and keeps it on that computer), so the AI is sent to `.workspace/` first.
 * `git init` of the company folder itself (re-initialising it) is left alone.
 */
export function checkGitClone(root: string, command: string, cwd?: string): GuardDecision {
  if (/\bclone\b/.test(command)) {
    for (const clone of gitCloneTargets(command, cwd)) {
      const rel = repoRelativePath(root, clone.target, clone.cwd ?? root)
      if (rel === null) continue // outside the company: not shared
      if (inWorkspace(rel)) continue
      return { deny: true, path: rel, folder: rel.normalize('NFC').split('/').slice(0, -1).join('/'), message: cloneMessage(clone.name), code: 'git-clone' }
    }
  }
  if (/\binit\b/.test(command)) {
    for (const init of gitInitTargets(command, cwd)) {
      const rel = repoRelativePath(root, init.target, init.cwd ?? root)
      if (rel === null || rel === '') continue // outside the company, or the company folder itself
      if (inWorkspace(rel)) continue
      return { deny: true, path: rel, folder: rel.normalize('NFC').split('/').slice(0, -1).join('/'), message: initMessage(init.name), code: 'git-init' }
    }
  }
  return { deny: false }
}
