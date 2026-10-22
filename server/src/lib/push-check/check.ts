/**
 * Push checker: every pre-receive decision, run once per push.
 *
 * Per ref update (branch deletions skipped — receive.denyDeletes refuses
 * them, and a deletion changes no remaining content), in the shell hook's
 * order:
 *
 *   protected config   owner/admin only (role from ACB_PUSHER_ROLE)
 *   auto-run skills    owner/admin only
 *   .personal content  nobody
 *   reserved paths     nobody — a private folder's path in the company
 *                      repository (added/modified paths, NFC + A–Z folded)
 *   write permission   resolveAccess(pusher, path).write   (new)
 *   Windows paths      the whole new tree
 *   gitlinks           added/changed mode-160000 entries
 *   secrets            added lines of the net diff and of every new commit
 *                      (existing branch) / tip-commit files (new branch)
 *
 * "Changed in this push" for the path rules = every commit that is new to
 * the server (`rev-list <new> --not --all`; merges as combined diffs, so
 * merging what is already on the server does not count) plus the net
 * <old>..<new> diff (so merging an old commit cannot revert a file unseen),
 * with --no-renames (a rename is a delete plus an add: both sides count).
 *
 * Every rule fails closed: a git failure while listing changes becomes a
 * "（変更内容を確認できませんでした: <ref>）" entry, which rejects the push.
 */
import { accessSync, constants as fsConstants } from 'fs'
import { delimiter, join } from 'path'
import { runGit, streamGitLines, streamLines } from './git'
import {
  EMPTY_TREE,
  ZERO_SHA,
  SecretScanner,
  addedGitlinks,
  autorunReport,
  autorunTargets,
  autorunUnavailable,
  cleanControl,
  parseRefUpdates,
  personalPaths,
  protectedPaths,
  sortUnique,
  utf8Bytes,
  windowsPathProblems,
  type RefUpdate,
} from './rules'
import { emptyFindings, renderReport, type Findings } from './report'
import { reservedPrefixOf, type WriteGate } from './policy'

export interface PushCheckContext {
  /** ACB_PUSHER_ROLE as git-http set it (undefined when absent). */
  pusherRole: string | undefined
  /** Write-permission decision for this push (see policy.ts). */
  writeGate: WriteGate
  /**
   * false when the content of skill/agent/command files cannot be inspected
   * (ACB_NODE names a runtime that cannot be run): those paths then fail
   * closed, exactly as when the shell hook's embedded node check could not run.
   */
  contentCheckAvailable: boolean
  /**
   * Private-folder paths reserved in this repository (policy.reservedKey
   * form). Empty for scope repositories and for pushes without a snapshot.
   */
  reserved?: string[]
}

export interface PushCheckResult {
  rejected: boolean
  /** The message for stderr (empty when accepted). */
  output: Buffer
  /** Marker → paths (byte strings) of each section, for tests and logs. */
  findings: Findings
}

/** `$(...)`: trailing newlines removed. */
function captured(text: string): string {
  return text.replace(/\n+$/, '')
}

function unableToCheck(refname: string): string {
  return utf8Bytes('（変更内容を確認できませんでした: ') + refname + utf8Bytes('）')
}

interface NameLists {
  ok: boolean
  net: Buffer
  perCommit: Buffer
}

/**
 * The hook's `printf '%s\n%s\n' "$net" "$per_commit"` after `tr '\0' '\n'`:
 * one line per path (a path holding a newline splits, as it did there).
 */
function nameListLines(l: NameLists): string[] {
  return `${l.net.toString('latin1')}\n${l.perCommit.toString('latin1')}\n`.replace(/\0/g, '\n').split('\n')
}

class RefChanges {
  private revList: Promise<{ ok: boolean; commits: string }> | null = null
  private names = new Map<string, Promise<NameLists>>()
  private raw: Promise<{ ok: boolean; out: Buffer }> | null = null

  constructor(readonly ref: RefUpdate) {}

  /** `git rev-list <new> --not --all`, captured (no trailing newline). */
  commits(): Promise<{ ok: boolean; commits: string }> {
    if (!this.revList) {
      this.revList = runGit(['rev-list', this.ref.newSha, '--not', '--all'])
        .then(r => ({ ok: r.ok, commits: captured(r.stdout.toString('latin1')) }))
    }
    return this.revList
  }

  /**
   * Net + per-commit `--name-only -z` lists, with extra diff-tree flags (e.g.
   * --diff-filter=d). ok=false when any git command failed.
   */
  nameLists(extra: string[] = []): Promise<NameLists> {
    const key = extra.join(' ')
    let p = this.names.get(key)
    if (!p) {
      p = (async (): Promise<NameLists> => {
        const failed = { ok: false, net: Buffer.alloc(0), perCommit: Buffer.alloc(0) }
        const { oldSha, newSha } = this.ref
        const rl = await this.commits()
        if (!rl.ok) return failed
        let net: Buffer = Buffer.alloc(0)
        if (oldSha !== ZERO_SHA) {
          const r = await runGit(['diff-tree', '-r', '--no-renames', ...extra, '--name-only', '-z', oldSha, newSha])
          if (!r.ok) return failed
          net = r.stdout
        }
        let perCommit: Buffer = Buffer.alloc(0)
        if (rl.commits.length > 0) {
          const r = await runGit(
            ['diff-tree', '--stdin', '-r', '--root', '-c', '--no-renames', ...extra, '--name-only', '-z', '--no-commit-id'],
            { input: rl.commits + '\n' })
          if (!r.ok) return failed
          perCommit = r.stdout
        }
        return { ok: true, net, perCommit }
      })()
      this.names.set(key, p)
    }
    return p
  }

  /** Net + per-commit raw `-z` diff (net first). On failure, the output produced before it. */
  rawDiff(): Promise<{ ok: boolean; out: Buffer }> {
    if (!this.raw) {
      this.raw = (async () => {
        const { oldSha, newSha } = this.ref
        const rl = await this.commits()
        if (!rl.ok) return { ok: false, out: Buffer.alloc(0) }
        const parts: Buffer[] = []
        if (oldSha !== ZERO_SHA) {
          const r = await runGit(['diff-tree', '-r', '--no-renames', '--no-abbrev', '-z', oldSha, newSha])
          parts.push(r.stdout)
          if (!r.ok) return { ok: false, out: Buffer.concat(parts) }
        }
        if (rl.commits.length > 0) {
          const r = await runGit(
            ['diff-tree', '--stdin', '-r', '--root', '-c', '--no-renames', '--no-abbrev', '-z', '--no-commit-id'],
            { input: rl.commits + '\n' })
          parts.push(r.stdout)
          if (!r.ok) return { ok: false, out: Buffer.concat(parts) }
        }
        return { ok: true, out: Buffer.concat(parts) }
      })()
    }
    return this.raw
  }
}

/** Read blobs with `git cat-file --batch`. Throws when any is missing or not a blob. */
async function readBlobs(shas: string[]): Promise<Map<string, Buffer>> {
  const contents = new Map<string, Buffer>()
  if (shas.length === 0) return contents
  const r = await runGit(['cat-file', '--batch'], { input: shas.join('\n') + '\n' })
  if (!r.ok) throw new Error('git cat-file failed')
  const out = r.stdout
  let pos = 0
  for (const sha of shas) {
    const nl = out.indexOf(10, pos)
    if (nl === -1) throw new Error(`missing blob ${sha}`)
    const header = out.toString('utf8', pos, nl).split(' ')
    if (header[0] !== sha || header[1] !== 'blob') throw new Error(`missing blob ${sha}`)
    const size = Number(header[2])
    contents.set(sha, out.subarray(nl + 1, nl + 1 + size))
    pos = nl + 1 + size + 1
  }
  return contents
}

/** "path<TAB>reason" lines (byte strings) for skill/agent/command files with auto-run parts. */
async function checkAutorun(changes: RefChanges, contentCheckAvailable: boolean): Promise<string> {
  const raw = await changes.rawDiff()
  if (raw.ok && contentCheckAvailable) {
    try {
      const targets = autorunTargets(raw.out)
      const shas = [...new Set([...targets.blobsByPath.values()].flatMap(s => [...s]))]
      const lines = autorunReport(targets, await readBlobs(shas))
      return captured(lines.map(l => utf8Bytes(l)).join('\n'))
    } catch {
      // fall through: cannot inspect the content → fail closed for these folders
    }
  }
  // Content cannot be checked (runtime unavailable, git read failure ...):
  // reject every path in those folders that this push changes.
  return captured(autorunUnavailable(raw.out.toString('latin1')).join('\n'))
}

/** Paths (UTF-8 decoded, exact) changed by this ref update, for the write check. */
async function changedPathsForWrite(changes: RefChanges): Promise<string[] | null> {
  const lists = await changes.nameLists()
  if (!lists.ok) return null
  const paths = [lists.net, lists.perCommit].flatMap(b => b.toString('utf8').split('\0')).filter(p => p.length > 0)
  return [...new Set(paths)]
}

async function checkWrite(changes: RefChanges, gate: WriteGate): Promise<string> {
  if (gate.kind === 'allow-all') return ''
  const paths = await changedPathsForWrite(changes)
  if (paths === null) return unableToCheck(changes.ref.refname)
  const denied = gate.kind === 'deny-all' ? paths : paths.filter(p => !gate.canWrite(p))
  return captured(sortUnique(denied.map(p => utf8Bytes(cleanControl(p)))).join('\n'))
}

/**
 * "path<TAB>folder" lines (byte strings) for added/modified paths at or under
 * a reserved private-folder path; `folder` is the pusher's own spelling of
 * the reserved prefix. Deletions are never refused (nothing to protect, and
 * refusing them could only leave a member unable to sync).
 */
async function checkReserved(changes: RefChanges, reserved: string[]): Promise<string> {
  if (reserved.length === 0) return ''
  const added = await changes.nameLists(['--diff-filter=d'])
  if (!added.ok) return unableToCheck(changes.ref.refname)
  const out: string[] = []
  const paths = new Set([added.net, added.perCommit].flatMap(b => b.toString('utf8').split('\0')).filter(x => x.length > 0))
  for (const p of paths) {
    const folder = reservedPrefixOf(p, reserved)
    if (folder !== null) out.push(`${utf8Bytes(cleanControl(p))}\t${utf8Bytes(cleanControl(folder))}`)
  }
  return captured(sortUnique(out).join('\n'))
}

async function checkWindowsPaths(newSha: string): Promise<string> {
  const r = await runGit(['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', newSha])
  const all = captured(r.stdout.toString('latin1'))
  if (all.length === 0) return ''
  return captured(windowsPathProblems(all.split('\n')).join('\n'))
}

async function checkGitlinks(ref: RefUpdate): Promise<string> {
  const base = ref.oldSha === ZERO_SHA ? EMPTY_TREE : ref.oldSha
  const r = await runGit(['-c', 'core.quotePath=false', 'diff-tree', '-r', base, ref.newSha])
  return captured(addedGitlinks(r.stdout.toString('latin1')).join('\n'))
}

/**
 * Secrets: the lines a push adds.
 *
 * Existing branch: the net <old>..<new> diff AND the diff of every commit new
 * to the server (`rev-list <new> --not --all`, each against its first parent
 * — merges as combined diffs, counting only lines added relative to every
 * parent; root commits against the empty tree) — in one `diff-tree --stdin`
 * stream, so a 200-commit push is still two git processes. The net diff alone
 * let a secret added in one commit and removed in a later one through,
 * although the intermediate commit — secret included — then lands in the
 * shared history on every member's machine. One entry per file × pattern
 * across both. When the push is a single commit on top of <old>, its own
 * diff is the net diff and is not read twice.
 *
 * New branch: unchanged — the whole content of the files the tip commit
 * added or changed. Sync never creates branches (it pushes main, which the
 * server itself creates with the company), and the root commit the server
 * seeds a repository with must stay unscanned.
 */
async function checkSecrets(ref: RefUpdate, changes: RefChanges): Promise<string> {
  const diffArgs = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv']
  if (ref.oldSha === ZERO_SHA) {
    // New branch: the whole content of the files the tip commit added or
    // changed (diff against its parent; nothing for a root or merge commit).
    const listed = await runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--diff-filter=d', ref.newSha])
    if (listed.stdout.length === 0) return ''
    const scanner = new SecretScanner('file')
    // xargs hands git the listed paths byte for byte (a JS string argument
    // could not carry a name that is not valid UTF-8), in as many batches as
    // ARG_MAX needs — one invocation per batch, not per file.
    await streamLines('xargs', ['-0', 'git', ...diffArgs, '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', EMPTY_TREE, ref.newSha, '--'],
      l => scanner.push(l),
      { input: listed.stdout, env: { GIT_LITERAL_PATHSPECS: '1' } })
    return captured(scanner.entries().join('\n'))
  }
  const scanner = new SecretScanner('line')
  const netOk = await streamGitLines([...diffArgs, '--src-prefix=a/', '--dst-prefix=b/', ref.oldSha, ref.newSha], l => scanner.push(l))
  // A net diff git cannot read (an <old> the server does not have — never
  // sent by receive-pack) is already rejected by the other rules as
  // "unable to check"; the report stays as it was.
  const rl = netOk ? await changes.commits() : { ok: false, commits: '' }
  if (rl.ok && rl.commits.length > 0) {
    const commits = rl.commits.split('\n')
    let onlyNetDiff = false
    if (commits.length === 1 && commits[0] === ref.newSha) {
      const parents = await runGit(['rev-list', '--parents', '-n', '1', ref.newSha])
      onlyNetDiff = parents.ok && captured(parents.stdout.toString('latin1')) === `${ref.newSha} ${ref.oldSha}`
    }
    if (!onlyNetDiff) {
      await streamGitLines(
        ['-c', 'core.quotePath=false', 'diff-tree', '--stdin', '-r', '--root', '-c', '-M', '-p', '--no-color', '--no-ext-diff',
          '--no-textconv', '--no-commit-id', '--src-prefix=a/', '--dst-prefix=b/'],
        l => scanner.push(l),
        { input: rl.commits + '\n' })
    }
  }
  return captured(scanner.entries().join('\n'))
}

export async function runPushCheck(stdin: Buffer, ctx: PushCheckContext): Promise<PushCheckResult> {
  const f = emptyFindings()
  const protectedAllowed = ctx.pusherRole === 'owner' || ctx.pusherRole === 'admin'

  for (const ref of parseRefUpdates(stdin.toString('latin1'))) {
    if (ref.newSha === ZERO_SHA) continue
    const changes = new RefChanges(ref)

    if (!protectedAllowed) {
      const lists = await changes.nameLists()
      const found = lists.ok ? captured(protectedPaths(nameListLines(lists)).join('\n')) : unableToCheck(ref.refname)
      if (found) f.protected += found + '\n'

      const autorun = await checkAutorun(changes, ctx.contentCheckAvailable)
      if (autorun) f.autorun += autorun + '\n'
    }

    const added = await changes.nameLists(['--diff-filter=d'])
    const personal = added.ok ? captured(personalPaths(nameListLines(added)).join('\n')) : unableToCheck(ref.refname)
    if (personal) f.personal += personal + '\n'

    const reserved = await checkReserved(changes, ctx.reserved ?? [])
    if (reserved) f.reserved += reserved + '\n'

    const denied = await checkWrite(changes, ctx.writeGate)
    if (denied) f.writeDenied += denied + '\n'

    const win = await checkWindowsPaths(ref.newSha)
    if (win) f.winpaths += win + '\n'

    const gitlinks = await checkGitlinks(ref)
    if (gitlinks) f.gitlinks += gitlinks + '\n'

    const secrets = await checkSecrets(ref, changes)
    if (secrets) f.secrets += secrets + '\n'
  }

  const output = renderReport(f)
  return { rejected: output !== null, output: output ?? Buffer.alloc(0), findings: f }
}

/** True when `cmd` (a path, or a name looked up in PATH) is an executable file. */
export function isRunnable(cmd: string): boolean {
  const candidates = cmd.includes('/') ? [cmd] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(d => join(d, cmd))
  return candidates.some((c) => {
    try {
      accessSync(c, fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  })
}
