/**
 * The holding place — the review (private-folders.md "Holding: review"; owner decision 2026-11-23
 * 「B」, design memo §4, stage S3). Contract: shared/types/private-holding.ts (the review section).
 *
 * What a member handed over (services/private-holding.ts) waits for the folder's managers, who
 * take it into the folder or discard it. So:
 *
 * - **Who** (I5, one check: `reviewable`): someone who reads the folder now and is an owner / admin
 *   or a 部署の管理役 of its department (`canManagePath`, the private folders' own rule); an item of a
 *   folder that is no longer private (deleted, made public): owners / admins only. Anyone else gets
 *   the same 404 as an item that does not exist — never a hint that the folder or the item exists.
 * - **Taking in is the reviewer's own push** (I6): ONE commit into the folder's repository, pushed
 *   through the push checker with the reviewer's permission snapshot (never as the server's own
 *   push), so write permission, protected files, secrets, `.personal`, names and look-alikes are
 *   judged again on what is written now — the paths stored at upload are never trusted. A refusal
 *   changes nothing and keeps the item waiting.
 * - **Once** (I6): `waiting → taking` by compare-and-set under the company lock is the "done" guard;
 *   the commit carries `ACB-Holding-Item: <id>`. A take-in that stopped halfway (an error after the
 *   push, a crash) is settled by looking for that line in the folder's history: there → taken,
 *   absent → waiting again. Discard and the clock's expiry are compare-and-sets from `waiting`, so
 *   none of them can run while a take-in holds the item.
 * - **Never over someone's later change** (owner decision, question 6): decided on the tip the
 *   commit is built on (again on a new tip): a file unchanged since the member's base is replaced,
 *   one changed since is put alongside as 「<name>（〇〇さんの版 MM-DD）.<ext>」 unless the reviewer
 *   chose to overwrite; a deletion only of a file unchanged since.
 * - **Nothing names the folder** beyond the reviewers: the commit message holds the member's name, a
 *   count and the item id; `permission_history` and log lines ids and counts only.
 */
import {
  HOLDING_REVIEW_CODES,
  type HoldingCause, type HoldingDiscardResult, type HoldingFileStanding, type HoldingReviewDetail, type HoldingReviewFile,
  type HoldingReviewItem, type HoldingReviewList, type HoldingTakeResult,
} from '../../shared/types/private-holding'
import { canReadPrivateScope } from '../../shared/core/permissions'
import { CLOCK_ACTOR } from '../../shared/core/core-types'
import { pathKey } from '../../shared/core/paths'
import type { AccountDirectory } from '../ports/accounts'
import type { Clock } from '../ports/clock'
import type { CompanyData, CompanyDataSource } from '../ports/company-data'
import type { HoldingBlobStore, HoldingFile, HoldingItem } from '../ports/holding'
import type { FolderFile, FolderFileEdit, FolderTree, PrivateFolderRecord, PusherSnapshot } from '../ports/private-folders'
import type { CompanyLock, Transactions } from '../ports/transactions'
import { logError } from '../lib/error-log'
import { hasFullAccess, type Member } from './access'
import { HOLDING_ITEM_DAYS } from './private-holding'
import { ok, refuse, type Outcome } from './outcome'

const DAY_MS = 24 * 60 * 60 * 1000
/** The admin home warns this long before the clock discards an item (owner decision, question 3). */
const EXPIRY_WARNING_DAYS = 7
const TRAILER = 'ACB-Holding-Item:'

export interface HoldingReviewDeps {
  companyData: CompanyDataSource
  accounts: AccountDirectory
  blobs: HoldingBlobStore
  transactions: Transactions
  clock: Clock
  companyLock: CompanyLock
  /** Owner/admin anywhere; a manager inside their department (services/private-folders.ts `canManagePath`). */
  canManagePath: (actor: Member, path: string) => boolean
  /** The reviewer as the push checker sees them (the snapshot git-http builds for their own push). */
  pushSnapshot: (actor: Member) => PusherSnapshot
}

const NOT_FOUND = () => refuse('not-found', 'Not found')
const INVALID = () => refuse('bad-request', 'Invalid request', { code: HOLDING_REVIEW_CODES.invalid })
const ALREADY_DECIDED = () => refuse('conflict', 'ほかの人が先に決めました。', { code: HOLDING_REVIEW_CODES.alreadyDecided })
const EXPIRED = () => refuse('gone', '預かってから30日たったため、自動的に捨てます。', { code: HOLDING_REVIEW_CODES.expired })
const BUSY = () => refuse('unavailable', 'フォルダが使われているため、今は入れられませんでした。少したってからもう一度お試しください。預かったものはそのまま残しています。', { code: HOLDING_REVIEW_CODES.busy })

/** What the push checker's markers mean, in plain words for the reviewer. */
const REFUSAL_WORDS: Record<string, string> = {
  WRITE_DENIED: 'このフォルダを変える権限がありません',
  SECRET_DETECTED: 'パスワードなどが入っています',
  PROTECTED_CONFIG: 'AI の設定にかかわるファイルは、オーナーと管理者だけが変えられます',
  PERSONAL_PATH: '本人のメモはフォルダに入れられません',
  LOCAL_ONLY_PATH: 'このパソコンだけに置くファイルです',
  WINPATH_DETECTED: 'ファイル名に使えない文字や名前があります',
  GITLINK_DETECTED: '入れられない種類のフォルダが含まれています',
  RESERVED_PATH: 'その名前は使えません',
  HOOK_ERROR: 'サーバーの確認がうまく動きませんでした',
}

const isTakeableKind = (f: HoldingFile) => f.kind === 'deleted' || ((f.kind === 'changed' || f.kind === 'backup') && f.stored && !f.dropped && !!f.sha256)

/** A path git would refuse to hold, or that names its own folder: never written. */
const hasGitSegment = (path: string) => path.split('/').some(s => s.toLowerCase() === '.git' || s === '' || s === '.' || s === '..')

/** The member's name as it can stand in a file name. */
function nameForFile(name: string | null): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = (name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '').trim().slice(0, 40)
  return cleaned || 'メンバー'
}

/** 'MM-DD' of a time, in Japan (the companies' day). */
function monthDay(at: string | null, nowMs: number): string {
  const ms = at ? Date.parse(at) : nowMs
  return new Date((Number.isFinite(ms) ? ms : nowMs) + 9 * 60 * 60 * 1000).toISOString().slice(5, 10)
}

/** The folder's files by pathKey, and the folders they are in. */
function indexTree(tree: FolderTree | null): { files: Map<string, FolderFile>; dirs: Set<string> } {
  const files = new Map<string, FolderFile>()
  const dirs = new Set<string>()
  for (const f of tree?.files ?? []) {
    const key = pathKey(f.path)
    files.set(key, f)
    const segments = key.split('/')
    for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join('/'))
  }
  return { files, dirs }
}

function standingOf(key: string, tip: Map<string, FolderFile>, base: Map<string, FolderFile> | null): HoldingFileStanding {
  if (!base) return 'unknown'
  return (tip.get(key)?.oid ?? null) === (base.get(key)?.oid ?? null) ? 'unchanged' : 'changed'
}

export function createHoldingReviewService(deps: HoldingReviewDeps) {
  const { companyData, accounts, blobs, transactions, clock, companyLock, canManagePath, pushSnapshot } = deps

  const expiresAt = (item: HoldingItem) => new Date(Date.parse(item.finishedAt ?? item.createdAt) + HOLDING_ITEM_DAYS * DAY_MS).toISOString()

  /**
   * I5, the one check: the item (received, any state after) and its folder (null: no longer a private
   * folder), when the actor may review it; otherwise the one 404.
   */
  function reviewable(actor: Member, itemId: string): Outcome<{ handle: CompanyData; item: HoldingItem; folder: PrivateFolderRecord | null }> {
    const handle = companyData.forCompany(actor.companyId)
    const item = handle.holdingItems.get(itemId)
    if (!item || item.state === 'receiving') return NOT_FOUND()
    const folder = handle.privateFolders.get(item.scopeId)
    if (!folder) return hasFullAccess(actor.role) ? ok({ handle, item, folder: null }) : NOT_FOUND()
    if (!canReadPrivateScope(folder.scope, actor.userId, actor.role)) return NOT_FOUND()
    if (!hasFullAccess(actor.role) && !canManagePath(actor, folder.scope.path)) return NOT_FOUND()
    return ok({ handle, item, folder })
  }

  function summary(handle: CompanyData, item: HoldingItem, folder: PrivateFolderRecord | null, names: Map<string, { name: string | null; email: string }>): HoldingReviewItem {
    const files = handle.holdingItems.files(item.id)
    const count = (k: HoldingFile['kind']) => files.filter(f => f.kind === k).length
    return {
      itemId: item.id,
      scopeId: item.scopeId,
      folderPath: folder?.scope.path ?? item.folderPath,
      folderGone: !folder,
      userId: item.userId,
      userName: names.get(item.userId)?.name ?? names.get(item.userId)?.email ?? null,
      cause: (handle.holding.get(item.ticketId)?.cause ?? 'readers') as HoldingCause,
      state: item.state === 'taking' ? 'taking' : 'waiting',
      receivedAt: item.finishedAt ?? item.createdAt,
      expiresAt: expiresAt(item),
      counts: { changed: count('changed'), deleted: count('deleted'), backup: count('backup'), personal: count('personal'), namesOnly: count('names-only') },
      bytes: item.totalBytes,
    }
  }

  /** The items the actor may review (waiting or being taken in). */
  function visible(actor: Member): Array<{ handle: CompanyData; item: HoldingItem; folder: PrivateFolderRecord | null }> {
    const handle = companyData.forCompany(actor.companyId)
    const out = []
    for (const item of handle.holdingItems.forReview()) {
      const r = reviewable(actor, item.id)
      if (r.ok) out.push(r.value)
    }
    return out
  }

  /** taking → taken, recorded; then the contents go (the sweep catches up if this fails). */
  async function finishTaken(handle: CompanyData, item: HoldingItem, commit: string | null, files: number | null, byUser: string): Promise<boolean> {
    const at = clock.now()
    const done = transactions.run(() => {
      if (!handle.holdingItems.markTaken(item.id, commit, at)) return false
      handle.permissionHistory.append({
        action: 'holding-taken', detail: { itemId: item.id, ticketId: item.ticketId, scopeId: item.scopeId, userId: item.userId, files, commit }, at, byUser,
      })
      return true
    })
    if (done) await dropContents(handle, item.id)
    return done
  }

  async function dropContents(handle: CompanyData, itemId: string): Promise<void> {
    try {
      await blobs.removeItem(handle.companyId, itemId)
      handle.holdingItems.markBlobsDeleted(itemId, clock.now())
    } catch (error) {
      logError('holding', 'could not remove a decided item\'s contents', error, { company: handle.companyId, item: itemId })
    }
  }

  /**
   * Under the company lock: an item left `taking` (no take-in runs now — they hold the lock) is
   * settled by the folder's history: the commit with its line there → taken; else waiting again.
   */
  async function settle(handle: CompanyData, itemId: string): Promise<void> {
    const item = handle.holdingItems.get(itemId)
    if (!item || item.state !== 'taking') return
    const folder = handle.privateFolders.get(item.scopeId)
    const landed = folder ? await handle.privateFolders.findCommitWithLine(folder, `${TRAILER} ${item.id}`).catch(() => null) : null
    if (landed) await finishTaken(handle, item, landed, null, item.decidedBy ?? CLOCK_ACTOR.id)
    else handle.holdingItems.backToWaiting(item.id, clock.now())
  }

  function parseTake(body: unknown): { files: number[]; overwrite: boolean } | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null
    const b = body as Record<string, unknown>
    if (!Array.isArray(b.files) || b.files.length === 0 || b.files.length > 5000) return null
    if (!b.files.every(n => Number.isSafeInteger(n) && (n as number) >= 0)) return null
    const when = b.whenChanged ?? 'alongside'
    if (when !== 'alongside' && when !== 'overwrite') return null
    return { files: [...new Set(b.files as number[])], overwrite: when === 'overwrite' }
  }

  /** What a decided or expired item answers to take / discard. */
  function decidedRefusal(item: HoldingItem): Outcome<never> | null {
    if (item.state === 'expired') return EXPIRED()
    if (item.state !== 'waiting') return ALREADY_DECIDED()
    return null
  }

  return {
    /** GET /holding */
    list(actor: Member): Outcome<HoldingReviewList> {
      const found = visible(actor)
      const names = accounts.byIds([...new Set(found.map(f => f.item.userId))])
      return ok({ items: found.map(f => summary(f.handle, f.item, f.folder, names)) })
    },

    /** The admin home's 「預かったファイルを確かめてください」 and 「あと7日で自動的に捨てます」. */
    attention(actor: Member): { waiting: number; expiringSoon: number } {
      const found = visible(actor)
      const soon = clock.nowMs() + EXPIRY_WARNING_DAYS * DAY_MS
      return { waiting: found.length, expiringSoon: found.filter(f => Date.parse(expiresAt(f.item)) <= soon).length }
    },

    /** GET /holding/:itemId — the entries, and how each stands against the folder today. */
    async detail(actor: Member, itemId: string): Promise<Outcome<HoldingReviewDetail>> {
      const found = reviewable(actor, itemId)
      if (!found.ok) return found
      const { handle, item, folder } = found.value
      if (item.state !== 'waiting' && item.state !== 'taking') return NOT_FOUND()
      const tip = folder ? indexTree(await handle.privateFolders.filesAt(folder, 'tip')) : null
      const base = folder && item.baseCommit ? await handle.privateFolders.filesAt(folder, item.baseCommit) : null
      const baseIndex = base ? indexTree(base).files : null
      const files: HoldingReviewFile[] = handle.holdingItems.files(item.id).map(f => {
        const key = pathKey(f.path)
        return {
          idx: f.idx, path: f.path, kind: f.kind, size: f.size, label: f.label,
          held: f.stored && !f.dropped && !!f.sha256,
          dropped: f.dropped === 'too-large' || f.dropped === 'secret' ? f.dropped : null,
          takeable: !!folder && isTakeableKind(f) && !hasGitSegment(f.path),
          standing: tip ? standingOf(key, tip.files, baseIndex) : 'unknown',
          inFolderNow: tip ? tip.files.has(key) : false,
        }
      })
      const names = accounts.byIds([item.userId])
      return ok({ ...summary(handle, item, folder, names), files })
    },

    /**
     * GET /holding/:itemId/files/:idx?version=held|base|current — one entry's bytes: as handed over,
     * as the folder had it at the member's base, or as it is now.
     */
    async content(actor: Member, itemId: string, idx: string, version: string | undefined): Promise<Outcome<{ bytes: Buffer; name: string }>> {
      const found = reviewable(actor, itemId)
      if (!found.ok) return found
      const { handle, item, folder } = found.value
      if (item.state !== 'waiting' && item.state !== 'taking') return NOT_FOUND()
      if (!/^\d{1,5}$/.test(idx)) return NOT_FOUND()
      const file = handle.holdingItems.files(item.id).find(f => f.idx === Number(idx))
      if (!file) return NOT_FOUND()
      const name = file.path.split('/').pop() ?? 'file'
      const which = version ?? 'held'
      if (which === 'held') {
        if (!file.stored || file.dropped || !file.sha256) return NOT_FOUND()
        const bytes = await blobs.read(handle.companyId, item.id, file.sha256)
        if (!bytes) return NOT_FOUND()
        handle.permissionHistory.append({ action: 'holding-downloaded', detail: { itemId: item.id, idx: file.idx }, at: clock.now(), byUser: actor.userId })
        return ok({ bytes, name })
      }
      if (which !== 'base' && which !== 'current') return INVALID()
      if (!folder || (which === 'base' && !item.baseCommit)) return NOT_FOUND()
      const tree = await handle.privateFolders.filesAt(folder, which === 'base' ? item.baseCommit as string : 'tip')
      const entry = tree ? indexTree(tree).files.get(pathKey(file.path)) : undefined
      if (!entry || entry.type !== 'blob' || entry.mode === '120000') return NOT_FOUND()
      const bytes = await handle.privateFolders.readBlob(folder, entry.oid)
      return bytes ? ok({ bytes, name }) : NOT_FOUND()
    },

    /** POST /holding/:itemId/take — the chosen entries into the folder, as one commit pushed as the reviewer. */
    async take(actor: Member, itemId: string, body: unknown): Promise<Outcome<HoldingTakeResult>> {
      const first = reviewable(actor, itemId)
      if (!first.ok) return first
      const parsed = parseTake(body)
      if (!parsed) return INVALID()
      return companyLock.run(actor.companyId, async (): Promise<Outcome<HoldingTakeResult>> => {
        await settle(first.value.handle, itemId)
        // Read again under the lock: who reads the folder, the item's state, the folder itself.
        const found = reviewable(actor, itemId)
        if (!found.ok) return found
        const { handle, item, folder } = found.value
        const decided = decidedRefusal(item)
        if (decided) return decided
        if (Date.parse(expiresAt(item)) <= clock.nowMs()) return EXPIRED()
        if (!folder) {
          return refuse('conflict', 'このフォルダはもうないため、ダウンロードするか捨てることだけができます。', { code: HOLDING_REVIEW_CODES.folderGone })
        }
        const all = handle.holdingItems.files(item.id)
        const chosen = parsed.files.map(i => all.find(f => f.idx === i))
        const notTakeable = parsed.files.filter((i, n) => {
          const f = chosen[n]
          return !f || !isTakeableKind(f) || hasGitSegment(f.path)
        })
        for (const f of chosen) {
          if (f && f.sha256 && isTakeableKind(f) && f.kind !== 'deleted' && !(await blobs.has(handle.companyId, item.id, f.sha256))) notTakeable.push(f.idx)
        }
        if (notTakeable.length > 0) {
          return refuse('bad-request', 'フォルダに入れられないものが選ばれています（本人のメモ・名前だけのもの）。', { code: HOLDING_REVIEW_CODES.notTakeable, files: notTakeable })
        }
        const entries = chosen as HoldingFile[]
        const base = item.baseCommit ? await handle.privateFolders.filesAt(folder, item.baseCommit) : null
        const baseIndex = base ? indexTree(base).files : null
        const who = nameForFile(accounts.byIds([item.userId]).get(item.userId)?.name ?? null)
        const day = monthDay(item.finishedAt, clock.nowMs())

        // The "done" guard: from here no discard, expiry or second take-in can run on this item.
        if (!handle.holdingItems.beginTaking(item.id, actor.userId, clock.now())) return ALREADY_DECIDED()

        const blobOf = new Map<string, string>()
        const decide = async (tipTree: FolderTree | null, writeBlob: (content: Buffer) => Promise<string>) => {
          const tip = indexTree(tipTree)
          const planned = new Set<string>()
          const occupied = (key: string) => tip.files.has(key) || tip.dirs.has(key) || planned.has(key)
          const fileInTheWay = (key: string) => {
            const segments = key.split('/')
            for (let i = 1; i < segments.length; i++) if (tip.files.has(segments.slice(0, i).join('/'))) return true
            return false
          }
          const alongside = (path: string) => {
            const slash = path.lastIndexOf('/')
            const dir = slash >= 0 ? path.slice(0, slash + 1) : ''
            const base = path.slice(slash + 1)
            const dot = base.lastIndexOf('.')
            const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, '']
            for (let n = 1; ; n++) {
              const candidate = `${dir}${stem}（${who}さんの版 ${day}${n > 1 ? ` ${n}` : ''}）${ext}`
              if (!occupied(pathKey(candidate))) return candidate
            }
          }
          const edits: FolderFileEdit[] = []
          const placed: HoldingTakeResult['placed'] = []
          const skipped: HoldingTakeResult['skipped'] = []
          for (const f of entries) {
            const key = pathKey(f.path)
            const there = tip.files.get(key)
            if (fileInTheWay(key)) { skipped.push({ idx: f.idx, reason: 'path-taken' }); continue }
            if (f.kind === 'deleted') {
              if (!there) skipped.push({ idx: f.idx, reason: 'absent' })
              else if (planned.has(key) || there.type !== 'blob' || standingOf(key, tip.files, baseIndex) !== 'unchanged') skipped.push({ idx: f.idx, reason: 'changed' })
              else { edits.push({ path: there.path, remove: true }); planned.add(key); placed.push({ idx: f.idx, path: there.path, how: 'deleted' }) }
              continue
            }
            const sha = f.sha256 as string
            let oid = blobOf.get(sha)
            if (!oid) {
              const bytes = await blobs.read(handle.companyId, item.id, sha)
              if (!bytes) throw new Error('held content missing')
              oid = await writeBlob(bytes)
              blobOf.set(sha, oid)
            }
            if (there && there.oid === oid && !planned.has(key)) { placed.push({ idx: f.idx, path: there.path, how: 'same' }); planned.add(key); continue }
            const regular = there && there.type === 'blob' && (there.mode === '100644' || there.mode === '100755')
            let how: 'placed' | 'alongside' | 'overwritten'
            if (!there && !tip.dirs.has(key) && !planned.has(key)) how = 'placed'
            else if (!regular || planned.has(key) || f.kind === 'backup') how = 'alongside'
            else if (standingOf(key, tip.files, baseIndex) === 'unchanged') how = 'placed'
            else how = parsed.overwrite ? 'overwritten' : 'alongside'
            const path = how === 'alongside' ? alongside(f.path) : (there?.path ?? f.path)
            edits.push({ path, blob: oid, mode: how === 'alongside' ? '100644' : (there?.mode ?? '100644') })
            planned.add(pathKey(path))
            placed.push({ idx: f.idx, path, how })
          }
          return { edits, result: { placed, skipped, changes: edits.length } }
        }

        let outcome: Awaited<ReturnType<CompanyData['privateFolders']['commitFiles']>> | null = null
        let lastResult: { placed: HoldingTakeResult['placed']; skipped: HoldingTakeResult['skipped']; changes: number } | null = null
        try {
          const r = await handle.privateFolders.commitFiles(folder, {
            // The member's name, a count and the item id: nothing of the content, no folder name.
            message: (_result, changes) => `${who}さんの預かりから取り込み（${changes}件）\n\n${TRAILER} ${item.id}`,
            as: pushSnapshot(actor),
            decide: async (tip, writeBlob) => {
              const d = await decide(tip, writeBlob)
              lastResult = d.result
              return d
            },
          })
          outcome = r
        } catch (error) {
          logError('holding', 'a take-in stopped', error, { company: handle.companyId, item: item.id })
        }
        if (outcome?.ok) {
          const result = outcome.result as { placed: HoldingTakeResult['placed']; skipped: HoldingTakeResult['skipped']; changes: number }
          await finishTaken(handle, item, outcome.commit, result.changes, actor.userId)
          return ok({ state: 'taken', commit: outcome.commit, placed: result.placed, skipped: result.skipped })
        }
        // Not known to have landed: the folder's history decides (an error after the push landed).
        const landed = await handle.privateFolders.findCommitWithLine(folder, `${TRAILER} ${item.id}`).catch(() => null)
        if (landed) {
          const result = lastResult as { placed: HoldingTakeResult['placed']; skipped: HoldingTakeResult['skipped']; changes: number } | null
          await finishTaken(handle, item, landed, result?.changes ?? null, actor.userId)
          return ok({ state: 'taken', commit: landed, placed: result?.placed ?? [], skipped: result?.skipped ?? [] })
        }
        handle.holdingItems.backToWaiting(item.id, clock.now())
        if (outcome && !outcome.ok && outcome.reason === 'REFUSED') {
          const reasons = [...new Set(outcome.rejections.map(r => REFUSAL_WORDS[r.marker] ?? 'サーバーの決まりに合いません'))]
          return refuse('conflict', `フォルダに入れられないファイルがありました（理由: ${reasons.join('、')}）。預かったものはそのまま残しています。`, {
            code: HOLDING_REVIEW_CODES.takeRefused, refused: outcome.rejections,
          })
        }
        return BUSY()
      })
    },

    /** POST /holding/:itemId/discard — 「預かったファイルを捨てます。元に戻せません。」 (the console asks first). */
    async discard(actor: Member, itemId: string): Promise<Outcome<HoldingDiscardResult>> {
      const first = reviewable(actor, itemId)
      if (!first.ok) return first
      return companyLock.run(actor.companyId, async (): Promise<Outcome<HoldingDiscardResult>> => {
        await settle(first.value.handle, itemId)
        const found = reviewable(actor, itemId)
        if (!found.ok) return found
        const { handle, item } = found.value
        const decided = decidedRefusal(item)
        if (decided) return decided
        const at = clock.now()
        const done = transactions.run(() => {
          if (!handle.holdingItems.discard(item.id, actor.userId, at)) return false
          handle.permissionHistory.append({
            action: 'holding-discarded', detail: { itemId: item.id, ticketId: item.ticketId, scopeId: item.scopeId, userId: item.userId }, at, byUser: actor.userId,
          })
          return true
        })
        if (!done) {
          const now = handle.holdingItems.get(item.id)
          return now ? (decidedRefusal(now) ?? ALREADY_DECIDED()) : NOT_FOUND()
        }
        await dropContents(handle, item.id)
        return ok({ state: 'discarded' })
      })
    },

    /** The server clock: items left `taking` by a stopped process are settled (under the company lock). */
    async settleStale(companyId: string): Promise<number> {
      const handle = companyData.forCompany(companyId)
      const taking = handle.holdingItems.forReview().filter(i => i.state === 'taking')
      if (taking.length === 0) return 0
      return companyLock.run(companyId, async () => {
        for (const item of taking) await settle(handle, item.id)
        return taking.length
      })
    },
  }
}

export type HoldingReviewService = ReturnType<typeof createHoldingReviewService>
