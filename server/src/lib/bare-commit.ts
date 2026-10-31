/**
 * The server's own commits to a company repository, made directly in the
 * bare repository — no working tree, no index, no checkout.
 *
 * Department folders are root folders of the shared branch, so every server
 * change (department create / rename / delete, company seeding) is an edit of
 * the root tree's entry list: a rename relabels one entry, a delete drops one,
 * a create adds one built from two tiny blobs. Subtrees are reused as they
 * are, so the cost does not depend on the company's size: a production rename
 * of a 1 MB department took 119 s in the old working clone (`git pull` of
 * another member's 4,211 files first, then `git add -A` over 10,775 files).
 *
 * Publishing goes through the push checker, not around it: the new commit is
 * pushed from the bare repository to itself (receive-pack, pre-receive hook,
 * ref lock; no objects are copied) with internalGitEnv(), so the hook skips
 * the write-permission check and still applies every content rule. A member's
 * push landing in between makes ours a non-fast-forward: the edit is redone on
 * the new branch tip, a few times at most. Callers hold withCompanyLock.
 *
 * Asynchronous only (lib/git-exec.ts): this runs inside request handlers.
 */
import { internalGitEnv } from './git-server'
import { gitAsync } from './git-exec'
import { resolveSharedBranch } from './repo-folders'

/** One entry of a tree as `git ls-tree` prints it. */
export interface TreeEntry {
  mode: string
  type: string
  oid: string
  name: string
}

export interface CommitIdentity {
  name: string
  email: string
}

export interface BareCommitTimeouts {
  /** Each local plumbing command (hash-object, mktree, commit-tree, …). */
  local: number
  /** The push: it runs the pre-receive checker. */
  push: number
}

/** What an edit of the root tree decided. No `entries`: nothing to commit. */
export interface RootEdit<T> {
  entries?: TreeEntry[]
  result: T
}

export interface CommitRootEditOptions {
  message: string
  identity: CommitIdentity
  timeouts: BareCommitTimeouts
}

/** Attempts before a run of concurrent member pushes makes us give up. */
const MAX_ATTEMPTS = 5

// `git ls-tree -z` records: "<mode> <type> <object>\t<name>\0" (-z: names are
// not quoted, so Japanese names come through as they are)
function parseTree(output: string): TreeEntry[] {
  const entries: TreeEntry[] = []
  for (const record of output.split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    const [mode, type, oid] = record.slice(0, tab).split(' ')
    entries.push({ mode, type, oid, name: record.slice(tab + 1) })
  }
  return entries
}

/** The entries of a tree (one level). */
export async function readTree(bareRepo: string, treeish: string, timeoutMs: number): Promise<TreeEntry[]> {
  return parseTree(await gitAsync(['-C', bareRepo, 'ls-tree', '-z', treeish], { timeoutMs }))
}

/** Write a tree object from its entries (git mktree sorts them). Returns its id. */
export async function writeTree(bareRepo: string, entries: TreeEntry[], timeoutMs: number): Promise<string> {
  const input = entries.map(e => `${e.mode} ${e.type} ${e.oid}\t${e.name}\0`).join('')
  return (await gitAsync(['-C', bareRepo, 'mktree', '-z'], { input, timeoutMs })).trim()
}

/** Write a blob (bytes as given: no attributes or filters apply). Returns its id. */
export async function writeBlob(bareRepo: string, content: string, timeoutMs: number): Promise<string> {
  return (await gitAsync(['-C', bareRepo, 'hash-object', '-w', '--no-filters', '--stdin'], { input: content, timeoutMs })).trim()
}

async function revParse(bareRepo: string, ref: string, timeoutMs: number): Promise<string | null> {
  try {
    return (await gitAsync(['-C', bareRepo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { timeoutMs })).trim()
  } catch {
    return null
  }
}

/**
 * Replace (or add) the file at `path` (segments under the root) and return
 * the new root entries: the trees along the path are rewritten, every other
 * subtree is reused as it is.
 */
async function withFile(bareRepo: string, entries: TreeEntry[], segments: string[], blob: string, mode: string, timeoutMs: number): Promise<TreeEntry[]> {
  const [name, ...rest] = segments
  const others = entries.filter(e => e.name !== name)
  if (rest.length === 0) return [...others, { mode, type: 'blob', oid: blob, name }]
  const dir = entries.find(e => e.name === name && e.type === 'tree')
  const childEntries = dir ? await readTree(bareRepo, dir.oid, timeoutMs) : []
  const child = await writeTree(bareRepo, await withFile(bareRepo, childEntries, rest, blob, mode, timeoutMs), timeoutMs)
  return [...others, { mode: '040000', type: 'tree', oid: child, name }]
}

/**
 * Edit one text file of the shared branch (the state engine's history line,
 * `.claude/rules/records.md`) and publish it as one commit, like
 * commitRootEdit: pushed to itself through the push checker, redone on a new
 * tip when a member pushed in between. `edit` gets the current text (null:
 * no such file) and returns the new one, or null to change nothing. Returns
 * whether a commit was made.
 */
export async function commitFileEdit(
  bareRepo: string,
  path: string,
  options: CommitRootEditOptions,
  edit: (current: string | null) => string | null,
): Promise<boolean> {
  const segments = path.split('/').filter(Boolean)
  if (segments.length === 0 || segments.some(s => s === '.' || s === '..')) throw new Error('commitFileEdit: bad path')
  const local = options.timeouts.local
  return commitRootEdit(bareRepo, options, async (entries) => {
    let level = entries
    let file: TreeEntry | undefined
    for (let i = 0; i < segments.length; i++) {
      const found = level.find(e => e.name === segments[i])
      if (i === segments.length - 1) { file = found?.type === 'blob' ? found : undefined; break }
      if (!found || found.type !== 'tree') break
      level = await readTree(bareRepo, found.oid, local)
    }
    if (file && file.mode === '120000') return { result: false } // a symlink: never written through
    const current = file ? await gitAsync(['-C', bareRepo, 'cat-file', 'blob', file.oid], { timeoutMs: local }) : null
    const next = edit(current)
    if (next === null || next === current) return { result: false }
    const blob = await writeBlob(bareRepo, next, local)
    return { entries: await withFile(bareRepo, entries, segments, blob, file?.mode ?? '100644', local), result: true }
  })
}

/**
 * Edit the root tree of the shared branch (main, or master in a repository
 * from before the name was pinned; main in an empty repository) and publish
 * the result as one commit whose parent is the tip the edit saw. `edit` is
 * called again on the new tip when a member pushed in between, so it must
 * decide from the entries it is given only.
 */
export async function commitRootEdit<T>(
  bareRepo: string,
  options: CommitRootEditOptions,
  edit: (entries: TreeEntry[]) => Promise<RootEdit<T>>,
): Promise<T> {
  const { message, identity, timeouts } = options
  const local = timeouts.local
  // Explicit identity: the server's commits must not depend on the host's
  // git config or on GIT_* variables of the process
  const commitEnv = {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  }

  for (let attempt = 1; ; attempt++) {
    const ref = (await resolveSharedBranch(bareRepo)) ?? 'refs/heads/main'
    const parent = await revParse(bareRepo, ref, local)
    const entries = parent ? await readTree(bareRepo, parent, local) : []

    const decided = await edit(entries)
    if (!decided.entries) return decided.result

    const tree = await writeTree(bareRepo, decided.entries, local)
    const commit = (await gitAsync(
      ['-C', bareRepo, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message],
      { env: commitEnv, timeoutMs: local },
    )).trim()

    try {
      // To itself: receive-pack runs the pre-receive checker on the update,
      // which is marked as the server's own (internalGitEnv)
      await gitAsync(['-C', bareRepo, 'push', '--quiet', bareRepo, `${commit}:${ref}`], {
        env: { ...internalGitEnv(), GIT_TERMINAL_PROMPT: '0' },
        timeoutMs: timeouts.push,
      })
      return decided.result
    } catch (error) {
      // The branch moved (a member's push): redo the edit on the new tip.
      // Anything else — the checker refused, a timeout — is the caller's error.
      const now = await revParse(bareRepo, ref, local)
      if (now === parent || attempt >= MAX_ATTEMPTS) throw error
    }
  }
}
