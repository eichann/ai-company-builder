// Which company Skill a consultation used (.claude/rules/records.md "Which
// Skill", owner decision 2026-11-01: compare work done with Skill v1 and v2).
//
// The chat server hands over each Skill the AI loaded in a consultation
// (Claude Code's `Skill` tool, shared/agent-events.ts `skillLoadedBy`). Here,
// in main, the skill folder is found in the company folder and its version
// read from git, then reported to the server with the member's session:
//
// - where: `.claude/skills/<name>/SKILL.md` in the consultation's working
//   folder or one of its parents up to the company folder. Found in more than
//   one of them, or also among the member's own skills (~/.claude/skills), it
//   is not known which one ran: nothing is reported.
// - version: the git tree id of that folder at HEAD (the same id on every PC
//   with the same synced content) and `dirty` (changes not in HEAD yet).
// - never reported: a skill inside a private folder (a repository of its own
//   inside the company folder — its name must not leave this PC, private-
//   folders.md), a skill not in HEAD (only on this PC, e.g. kept private by the
//   root .gitignore), a personal / plugin skill. No path or content is sent:
//   the server gets the folder name, the tree id and dirty only.
//
// The AI's next write in the consultation waits for the report in flight
// (`settled`, used by records/api.ts) so the server can copy it onto what the
// AI writes. Failures are logged without names and never reach the AI.
//
// A working folder (a company without the shared folder) has no git: the version
// is the Skill shelf's (64 hex, the same field), `dirty` when the files differ
// from it. A Skill not delivered by the company there is the member's own: nothing.

import fs from 'fs'
import path from 'path'
import { isSkillUseName, SKILL_TREE_RE } from '../../../shared/core/skill-uses'
import type { SkillUseSighting } from '../../shared/agent-events'

export interface SkillUseReporterDeps {
  baseUrl: () => string
  cookies: () => string[]
  /** `git <args>` in the repository at `root`; resolves with stdout, rejects on failure. */
  git: (root: string, args: string[]) => Promise<string>
  /**
   * The shelf's version of a Skill folder in a working folder: undefined = `root` is no working
   * folder (git decides), null = not a delivered Skill (nothing is reported).
   */
  shelfVersion?: (root: string, rel: string) => Promise<{ version: string; dirty: boolean } | null> | undefined
  /** The member's home (their own skills under ~/.claude/skills shadow a company skill of the same name). */
  home?: string
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
}

/** The skill folder, company-relative with `/`, or why there is none. */
export function locateCompanySkill(companyRoot: string, workingDirectory: string | undefined, name: string, home?: string): { rel: string } | { none: 'not-found' | 'ambiguous' | 'private' } {
  const root = path.resolve(companyRoot)
  let dir = root
  if (workingDirectory) {
    const rel = path.relative(root, path.resolve(workingDirectory))
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) dir = path.resolve(root, rel)
  }
  const isFile = (p: string) => { try { return fs.lstatSync(p).isFile() } catch { return false } }
  const found: string[] = []
  for (;;) {
    if (isFile(path.join(dir, '.claude', 'skills', name, 'SKILL.md'))) found.push(dir)
    if (dir === root) break
    dir = path.dirname(dir)
  }
  if (found.length === 0) return { none: 'not-found' }
  if (found.length > 1 || (home && isFile(path.join(home, '.claude', 'skills', name, 'SKILL.md')))) return { none: 'ambiguous' }
  const segments = path.relative(root, found[0]).split(path.sep).filter(Boolean)
  // A private folder's clone is a repository of its own inside the company folder.
  for (let i = 1; i <= segments.length; i++) {
    if (fs.existsSync(path.join(root, ...segments.slice(0, i), '.git'))) return { none: 'private' }
  }
  return { rel: [...segments, '.claude', 'skills', name].join('/') }
}

/** The folder's tree id at HEAD and whether it has changes not in HEAD; null when HEAD has no such folder. */
export async function skillFolderVersion(git: SkillUseReporterDeps['git'], root: string, rel: string): Promise<{ tree: string; dirty: boolean } | null> {
  let tree: string
  try {
    // Everything after `HEAD:` is the path, so the type is checked on its own.
    tree = (await git(root, ['rev-parse', '--verify', '--quiet', `HEAD:${rel}`])).trim()
    if (!SKILL_TREE_RE.test(tree) || (await git(root, ['cat-file', '-t', tree])).trim() !== 'tree') return null
  } catch {
    return null
  }
  // --no-optional-locks: never takes index.lock (sync may be running).
  const status = await git(root, ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all', '--ignored=no', '--', `:(literal)${rel}`])
  return { tree, dirty: status.length > 0 }
}

export function createSkillUseReporter(deps: SkillUseReporterDeps) {
  const doFetch = deps.fetch ?? fetch
  const reported = new Set<string>()
  const inFlight = new Map<string, Set<Promise<void>>>()
  let warned = false
  const warn = (why: string) => {
    if (warned) return
    warned = true
    deps.log?.warn(`[skill-uses] a skill use was not recorded: ${why}`)
  }

  async function report(s: SkillUseSighting): Promise<void> {
    if (!isSkillUseName(s.skill)) return // a plugin's `plugin:skill`, or not a skill folder name
    const at = locateCompanySkill(s.companyRoot, s.workingDirectory, s.skill, deps.home)
    if ('none' in at) return
    const shelf = deps.shelfVersion?.(s.companyRoot, at.rel)
    const onShelf = shelf ? await shelf : undefined
    const version = shelf
      ? (onShelf ? { tree: onShelf.version, dirty: onShelf.dirty } : null)
      : await skillFolderVersion(deps.git, s.companyRoot, at.rel)
    if (!version) return // not in HEAD (or not delivered): only on this PC
    const key = [s.companyId, s.conversationId, s.skill, version.tree, version.dirty].join('\n')
    if (reported.has(key)) return
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return
    const res = await doFetch(`${base}/api/companies/${encodeURIComponent(s.companyId)}/me/skill-uses`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { Cookie: cookies.join('; '), 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: s.conversationId, name: s.skill, tree: version.tree, dirty: version.dirty }),
    })
    if (!res.ok) { warn(`HTTP ${res.status}`); return }
    if (reported.size > 2000) reported.clear()
    reported.add(key)
  }

  return {
    /** A Skill the AI loaded: find, read its version and report it (in the background; never throws). */
    observe(s: SkillUseSighting): void {
      const p = report(s).catch(error => warn(error instanceof Error ? error.name : 'unknown'))
      const set = inFlight.get(s.conversationId) ?? new Set<Promise<void>>()
      set.add(p)
      inFlight.set(s.conversationId, set)
      void p.finally(() => {
        set.delete(p)
        if (set.size === 0 && inFlight.get(s.conversationId) === set) inFlight.delete(s.conversationId)
      })
    },
    /** Waits (at most `timeoutMs`) for the consultation's reports in flight: called before the AI writes. */
    async settled(conversationId: string, timeoutMs = 5000): Promise<void> {
      const set = inFlight.get(conversationId)
      if (!set || set.size === 0) return
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.allSettled([...set]),
        new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) }),
      ])
      if (timer) clearTimeout(timer)
    },
  }
}

export type SkillUseReporter = ReturnType<typeof createSkillUseReporter>
