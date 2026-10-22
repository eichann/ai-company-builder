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
    for (const target of bashWriteTargets(command)) {
      const d = checkWritePath(guard, target, cwd)
      if (d.deny) return d
    }
  }
  return { deny: false }
}
