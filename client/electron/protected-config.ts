// Recovery from a push the server rejected because it changed agent-execution
// config that only a company owner/admin may change.
//
// The server's pre-receive hook (server/src/templates/pre-receive-hook.sh)
// rejects any push in which *some commit* adds, modifies, deletes or renames
// a protected path (.claude/settings.json, .claude/settings.local.json,
// .mcp.json, anything under .claude/hooks/ — at any depth) unless the pusher
// is an owner/admin. Claude Code runs the commands in those files without a
// prompt, so a member could otherwise run code on every teammate's machine.
//
// The rejected change is already committed locally, so retrying the push can
// never succeed: every sync would fail at the same step — the failure shape
// documented under "Non-Negotiable Guards" in CLAUDE.md. A revert commit on
// top does not help either, because the hook checks every commit in the
// pushed range. The way out is to rewrite the unpushed commits:
//
//   1. back up the member's version of each path into .backups/<timestamp>/
//   2. `reset --soft <upstream>` — squash the unpushed commits into the index
//      (the member's other changes stay staged, nothing in the worktree moves)
//   3. put each protected path back to the server's version, or remove it if
//      the server does not have it
//   4. commit what is left (the member's other changes) as one commit
//
// The caller then pushes again.

import fs from 'node:fs'
import path from 'node:path'
import type { SimpleGit } from 'simple-git'

export const PROTECTED_CONFIG_MARKER = '[PROTECTED_CONFIG]'

/** True when a push error came from the protected-config check. */
export function isProtectedConfigRejection(errorMessage: string): boolean {
  return errorMessage.includes(PROTECTED_CONFIG_MARKER)
}

/**
 * Paths listed in the PROTECTED_CONFIG section of a push error. The hook
 * prints: separator, marker line, separator, explanation, "  - <path>" lines,
 * explanation, separator. git prefixes every hook line with "remote: ".
 * Only the "- " lines inside that section count — other sections
 * (SECRET_DETECTED, ...) use the same bullet style.
 */
export function parseProtectedConfigPaths(errorMessage: string): string[] {
  return parseRejectionPaths(errorMessage, PROTECTED_CONFIG_MARKER)
}

// Shared by every hook section that lists paths (PROTECTED_CONFIG, PERSONAL_PATH,
// WRITE_DENIED).
function parseRejectionPaths(errorMessage: string, marker: string): string[] {
  const lines = errorMessage.split(/\r?\n/).map(line => line.replace(/^remote:\s?/, '').trimEnd())
  const start = lines.findIndex(line => line.includes(marker))
  if (start === -1) return []
  const paths: string[] = []
  let separators = 0
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim()
    // Another section starts: a section printed without separators (such as
    // WRITE_DENIED) must not swallow the next section's bullets.
    const section = /^\[[A-Z_]+\]/.exec(trimmed)
    if (section && section[0] !== marker) break
    if (/^=+$/.test(trimmed)) {
      if (++separators === 2) break
      continue
    }
    if (trimmed.startsWith('- ')) {
      const p = trimmed.slice(2)
      if (p && !paths.includes(p)) paths.push(p)
    }
  }
  return paths
}

/** Plain-words explanation shown to the member (Japanese UI). */
export function protectedConfigMessage(paths: string[]): string {
  const list = paths.length > 0 ? paths.map(p => `・${p}`).join('\n') : '（詳細不明）'
  return `このファイルは管理者だけが変更できます。\n` +
    `チャットのAIが自動で実行する設定ファイル（または自動実行の設定を含むスキル）のため、会社のオーナー・管理者以外の変更は共有できません。\n\n${list}`
}

export class ProtectedConfigRecoveryError extends Error {}

// ---------------------------------------------------------------------------
// WRITE_DENIED — a folder the member may not edit
// ---------------------------------------------------------------------------
//
// The hook rejects with [WRITE_DENIED] any push in which a commit changes a
// path the pusher has no write permission for. Like PROTECTED_CONFIG it
// checks every commit in the pushed range, so the recovery is the same:
// back up, squash the unpushed commits, put those paths back to the server's
// version (restoreProtectedPaths with reason 'write_denied'), push the rest.
// The section is "[WRITE_DENIED]", then "  - <path>" lines, then explanation
// lines that do not start with "  - ".

export const WRITE_DENIED_MARKER = '[WRITE_DENIED]'

export type RestoreReason = 'protected_config' | 'write_denied'

export function isWriteDeniedRejection(errorMessage: string): boolean {
  return errorMessage.includes(WRITE_DENIED_MARKER)
}

export function parseWriteDeniedPaths(errorMessage: string): string[] {
  return parseRejectionPaths(errorMessage, WRITE_DENIED_MARKER)
}

/** Plain-words explanation shown to the member (Japanese UI). */
export function writeDeniedMessage(paths: string[]): string {
  const list = paths.length > 0 ? paths.map(p => `・${p}`).join('\n') : '（詳細不明）'
  return `編集できないファイルがあります。\n` +
    `次のファイルは、あなたに編集する権限がないフォルダにあるため、変更を共有できません。\n\n${list}`
}

async function assertUpstreamIsAncestor(git: SimpleGit, upstream: string): Promise<{ localHead: string; upstreamHash: string }> {
  const localHead = (await git.revparse(['HEAD'])).trim()
  const upstreamHash = (await git.revparse([upstream])).trim()
  // Compare hashes instead of relying on exit codes: simple-git does not
  // reject on a non-zero exit that prints nothing (e.g. --is-ancestor).
  const mergeBase = (await git.raw(['merge-base', upstreamHash, localHead]).catch(() => '')).trim()
  if (mergeBase !== upstreamHash) {
    throw new ProtectedConfigRecoveryError('サーバーの最新状態を取り込めていないため、自動で戻せませんでした。もう一度同期してください。')
  }
  return { localHead, upstreamHash }
}

/**
 * Squash the unpushed commits into one, changing no file. The hook checks
 * every commit in the pushed range, so a change the member has already undone
 * in a later commit (e.g. removed a skill's `hooks` after the first rejection)
 * still blocks the push until the intermediate commit is gone. Sync tries
 * this before restoring anything: when the squashed push is accepted, the
 * member's final version of every file is kept.
 */
export async function squashUnpushedCommits(options: {
  git: SimpleGit
  upstream?: string
}): Promise<{ squashed: boolean; committed: boolean }> {
  const { git } = options
  const { localHead, upstreamHash } = await assertUpstreamIsAncestor(git, options.upstream ?? 'origin/main')
  const count = Number((await git.raw(['rev-list', '--count', `${upstreamHash}..${localHead}`])).trim())
  // Zero or one commit: squashing would push exactly what was just rejected.
  if (!(count > 1)) return { squashed: false, committed: count === 1 }
  const squashedMessages = (await git.raw(['log', '--format=%s', `${upstreamHash}..${localHead}`]))
    .split('\n').map(s => s.trim()).filter(Boolean)
  await git.raw(['reset', '--soft', upstreamHash])
  const remaining = (await git.raw(['diff', '--cached', '--name-only', '-z', upstreamHash])).replace(/\0/g, '')
  if (!remaining) return { squashed: true, committed: false }
  await git.commit(`Sync from AI Company Builder\n\n${squashedMessages.map(m => `- ${m}`).join('\n')}`)
  return { squashed: true, committed: true }
}

export interface ProtectedConfigRecoveryResult {
  /** Paths put back to the server's version. */
  restored: string[]
  /** Paths the server does not have, removed locally. */
  removed: string[]
  /** Folder holding the member's version of each path (null if none needed). */
  backupPath: string | null
  /** True when a commit with the member's remaining changes was created. */
  committed: boolean
}

type EntryType = 'blob' | 'tree' | null

async function entryAt(git: SimpleGit, rev: string, file: string): Promise<{ type: EntryType; oid: string | null }> {
  try {
    // ls-tree on the exact path: one line "<mode> <type> <oid>\t<path>", or nothing.
    const out = (await git.raw(['ls-tree', '-z', rev, '--', file])).split('\0')[0]
    if (!out) return { type: null, oid: null }
    const [meta] = out.split('\t')
    const [, type, oid] = meta.split(' ')
    return { type: type === 'tree' ? 'tree' : 'blob', oid }
  } catch {
    return { type: null, oid: null }
  }
}

function assertInsideRepo(repoPath: string, file: string): string {
  const root = path.resolve(repoPath)
  const full = path.resolve(root, file)
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..') || !full.startsWith(root + path.sep)) {
    throw new ProtectedConfigRecoveryError(`不正なパスです: ${file}`)
  }
  return full
}

/**
 * Rewrite the unpushed commits so they no longer touch the given protected
 * paths, keeping a copy of the member's version in `backupPath` first.
 * `upstream` must be an ancestor of HEAD (sync has just rebased onto it);
 * otherwise nothing is changed and an error is thrown — squashing onto a
 * non-ancestor would revert other members' work.
 */
export async function restoreProtectedPaths(options: {
  git: SimpleGit
  repoPath: string
  paths: string[]
  backupPath: string
  upstream?: string
  commitMessage?: string
  /**
   * Why the server refused these paths. 'write_denied' (the member may not
   * edit that folder) also undoes an exact move into it: the file goes back
   * to the path it came from instead of vanishing from both places.
   */
  reason?: RestoreReason
}): Promise<ProtectedConfigRecoveryResult> {
  const { git, repoPath, paths, backupPath } = options
  const upstream = options.upstream ?? 'origin/main'
  const reason = options.reason ?? 'protected_config'
  if (paths.length === 0) throw new ProtectedConfigRecoveryError('対象のファイルが特定できませんでした')
  const fullPaths = new Map(paths.map(p => [p, assertInsideRepo(repoPath, p)]))

  const { localHead, upstreamHash } = await assertUpstreamIsAncestor(git, upstream)

  // Decide per path before touching anything, so an unsupported case aborts
  // with the repository unchanged.
  const plan: Array<{ file: string; local: { type: EntryType; oid: string | null }; server: { type: EntryType; oid: string | null } }> = []
  for (const file of paths) {
    const local = await entryAt(git, localHead, file)
    const server = await entryAt(git, upstreamHash, file)
    if (local.type === 'tree' && server.type === 'blob') {
      throw new ProtectedConfigRecoveryError(`「${file}」は自動で戻せない形で変更されています。管理者に相談してください。`)
    }
    plan.push({ file, local, server })
  }

  // 1. Back up the member's version (binary-safe, from the commit — the
  //    worktree equals HEAD right after sync's commit).
  const backedUp: string[] = []
  for (const { file, local, server } of plan) {
    if (local.type !== 'blob' || local.oid === server.oid) continue
    const dest = path.join(backupPath, file)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const content: Buffer = await git.binaryCatFile(['-p', `${localHead}:${file}`])
    fs.writeFileSync(dest, content)
    backedUp.push(file)
  }
  const restored: string[] = []
  const removed: string[] = []
  for (const { file, local, server } of plan) {
    if (local.type === 'blob' && local.oid === server.oid) continue
    // A folder now (e.g. .claude was briefly a symlink in an earlier commit):
    // only an intermediate commit touched this path and squashing drops it.
    // Never check a folder out over the member's work — skills live there.
    if (local.type === 'tree') continue
    if (server.type !== null) restored.push(file)
    else if (local.type !== null) removed.push(file)
  }
  if (backedUp.length > 0 || restored.length > 0 || removed.length > 0) {
    fs.mkdirSync(backupPath, { recursive: true })
    fs.writeFileSync(path.join(backupPath, '_metadata.json'), JSON.stringify({
      timestamp: new Date().toISOString(),
      reason,
      ...(reason === 'write_denied' ? { writeDeniedFiles: paths } : { protectedFiles: paths }),
      backedUpFiles: backedUp,
      restoredFiles: restored,
      removedFiles: removed,
      localHead,
    }, null, 2))
  }

  // Messages of the commits being squashed, so their descriptions survive.
  const squashedMessages = (await git.raw(['log', '--format=%s', `${upstreamHash}..${localHead}`]))
    .split('\n').map(s => s.trim()).filter(Boolean)

  // 2. Squash the unpushed commits into the index.
  await git.raw(['reset', '--soft', upstreamHash])

  // 3. Put each protected path back to the server's version.
  for (const { file, local, server } of plan) {
    if (local.type === 'tree' || (local.type === 'blob' && local.oid === server.oid)) continue
    if (local.type === 'blob') {
      await git.raw(['rm', '--cached', '--quiet', '--ignore-unmatch', '--sparse', '--', file])
      fs.rmSync(fullPaths.get(file)!, { force: true }) // a symlink is removed, not followed
    }
    if (server.type !== null) {
      await git.raw(['checkout', upstreamHash, '--', file])
    }
  }

  // 3b. A file moved into a folder the member may not edit: its new path was
  //     just removed, so put it back at the path it was moved from (exact
  //     moves only — same content — which the server still has).
  if (reason === 'write_denied') {
    const movedOids = new Set(plan
      .filter(({ local, server }) => local.type === 'blob' && server.type === null && local.oid)
      .map(({ local }) => local.oid as string))
    if (movedOids.size > 0) {
      const deleted = (await git.raw(['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=D', '-z', upstreamHash]))
        .split('\0').filter(Boolean)
      for (const file of deleted) {
        if (paths.includes(file)) continue
        const server = await entryAt(git, upstreamHash, file)
        if (server.type === 'blob' && server.oid && movedOids.has(server.oid)) {
          await git.raw(['checkout', upstreamHash, '--', file])
          movedOids.delete(server.oid)
          restored.push(file)
        }
      }
    }
  }

  // 4. Commit the member's remaining changes (if any are left).
  let committed = false
  const remaining = (await git.raw(['diff', '--cached', '--name-only', '-z', upstreamHash])).replace(/\0/g, '')
  if (remaining) {
    const subject = options.commitMessage
      || (squashedMessages.length === 1 ? squashedMessages[0] : 'Sync from AI Company Builder')
    const body = squashedMessages.length > 1 ? `\n\n${squashedMessages.map(m => `- ${m}`).join('\n')}` : ''
    const note = reason === 'write_denied'
      ? '（編集する権限がないフォルダのファイルの変更は除外し、サーバーの状態に戻しました）'
      : '（管理者専用の設定ファイルの変更は除外し、サーバーの状態に戻しました）'
    await git.commit(`${subject}${body}\n\n${note}`)
    committed = true
  }

  return { restored, removed, backupPath: backedUp.length > 0 ? backupPath : null, committed }
}

// ---------------------------------------------------------------------------
// .personal/ — never shared, for anyone
// ---------------------------------------------------------------------------
//
// The hook rejects with [PERSONAL_PATH] any push in which a commit adds or
// modifies a file inside a directory named `.personal` (any depth), except
// the `.gitignore` directly inside it — for every pusher, owner/admin
// included. Unlike protected config, the fix is not "take the server's
// version": the file is the member's private file, so it is untracked (kept
// on disk, and ignored from now on by the essential `**/.personal/*` sync
// pattern). Deletions are always allowed, which is also how a file shared
// before the rule existed gets unshared. As with protected config, the
// unpushed commits are squashed first because the hook checks every commit
// in the pushed range.

export const PERSONAL_PATH_MARKER = '[PERSONAL_PATH]'

export function isPersonalPathRejection(errorMessage: string): boolean {
  return errorMessage.includes(PERSONAL_PATH_MARKER)
}

export function parsePersonalPaths(errorMessage: string): string[] {
  return parseRejectionPaths(errorMessage, PERSONAL_PATH_MARKER)
}

export interface PersonalUntrackResult {
  /** Paths taken out of the shared repository (still on disk). */
  untracked: string[]
  /** True when a commit with the member's remaining changes was created. */
  committed: boolean
}

/**
 * Squash the unpushed commits and leave the given `.personal/` paths out of
 * them with `git rm --cached` — the files stay on disk. A path the server
 * already has (shared before the rule) is deleted from the server by this
 * commit, which the hook always allows.
 */
export async function untrackPersonalPaths(options: {
  git: SimpleGit
  repoPath: string
  paths: string[]
  upstream?: string
}): Promise<PersonalUntrackResult> {
  const { git, repoPath, paths } = options
  const upstream = options.upstream ?? 'origin/main'
  if (paths.length === 0) throw new ProtectedConfigRecoveryError('対象のファイルが特定できませんでした')
  for (const p of paths) {
    assertInsideRepo(repoPath, p)
    if (!/(^|\/)\.personal\//i.test(p)) {
      throw new ProtectedConfigRecoveryError(`個人用フォルダのファイルではありません: ${p}`)
    }
  }

  const localHead = (await git.revparse(['HEAD'])).trim()
  const upstreamHash = (await git.revparse([upstream])).trim()
  const mergeBase = (await git.raw(['merge-base', upstreamHash, localHead]).catch(() => '')).trim()
  if (mergeBase !== upstreamHash) {
    throw new ProtectedConfigRecoveryError('サーバーの最新状態を取り込めていないため、自動で外せませんでした。もう一度同期してください。')
  }

  const squashedMessages = (await git.raw(['log', '--format=%s', `${upstreamHash}..${localHead}`]))
    .split('\n').map(s => s.trim()).filter(Boolean)

  // Squash, then drop the paths from the index only (worktree untouched).
  await git.raw(['reset', '--soft', upstreamHash])
  const untracked: string[] = []
  for (const file of paths) {
    const inIndex = (await git.raw(['ls-files', '-z', '--', file])).replace(/\0/g, '')
    if (!inIndex) continue
    await git.raw(['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--sparse', '--', file])
    untracked.push(file)
  }

  let committed = false
  const remaining = (await git.raw(['diff', '--cached', '--name-only', '-z', upstreamHash])).replace(/\0/g, '')
  if (remaining) {
    const subject = squashedMessages.length === 1 ? squashedMessages[0] : 'Sync from AI Company Builder'
    const body = squashedMessages.length > 1 ? `\n\n${squashedMessages.map(m => `- ${m}`).join('\n')}` : ''
    await git.commit(`${subject}${body}\n\n（個人用フォルダ .personal のファイルは共有対象から外しました）`)
    committed = true
  }
  return { untracked, committed }
}

/** Plain-words explanation for the member (Japanese UI). */
export function personalPathMessage(paths: string[]): string {
  const list = paths.length > 0 ? paths.map(p => `・${p}`).join('\n') : '（詳細不明）'
  return `個人用フォルダ（.personal）のファイルは、誰であっても共有できません。\n\n${list}`
}
