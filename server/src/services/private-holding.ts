/**
 * The holding place — the member's upload (private-folders.md "Holding: the member's upload";
 * owner decision 2026-11-23 「B」, design memo §3.2–3.3, stage S2). Contract:
 * shared/types/private-holding.ts.
 *
 * Someone who stopped reading a private folder holds a ticket for it (services/holding-tickets.ts).
 * With it, and only with it, their app hands over what never reached the server — one item per
 * ticket and PC — before it removes the folder from the PC. These are the first endpoints that
 * accept company data from a person who may no longer be a member, so:
 *
 * - **One entry check** (I3): `ticketFor` / `itemFor` find the ticket or item among the caller's
 *   own tickets only (the control-plane lookup by user id, then that company's handle). A ticket
 *   or item that is not the caller's, unknown or another company's is the same 404. Expired → 410
 *   `EXPIRED`, cancelled (they read the folder again) → 410 `CANCELLED`: told only to the ticket's
 *   own member, never anything about the folder.
 * - **Nothing names the folder**: no answer and no log line carries its path or name (the ticket's
 *   `folder_path` stays server-side); entry paths are the member's own, relative to the folder,
 *   and are never answered back (indexes are).
 * - **A blob is admitted before its body is read**: rate, owner, item and ticket state, the content
 *   named and still wanted, `Content-Length` equal to its size and within the file cap, and room
 *   among the uploads running (2 per member, 8 per server). Then it streams into a temporary file
 *   of its own, hashed and scanned as it arrives (never held in memory).
 * - **Caps** (owner decision, question 4): 50 MB a file, 500 MB an item, 1 GB a ticket (all its
 *   PCs), 5,000 entries — over one an entry is a name only (`too-large`). The company's room
 *   (2 GB) counts what is **stored**, not what a manifest announced, so nobody's announcement can
 *   squeeze others out; an entry with no room now is `company-full`: the app keeps its copy and
 *   tries again later (never removed on that answer).
 * - **No secret is kept** (I7): a secret's file name (`.env`, `.env.*`) is a name only; every
 *   content is scanned with shared/core/secret-patterns.ts as it arrives (all bytes, binary too) and,
 *   on a hit, dropped (its entries become names only, `secret`). The app filters too; the server decides.
 * - **Never a received item without its content** (I2): the step that names a content and marks it
 *   stored runs under the company's holding lock (with the sweep and erasure), after the item is read
 *   again; a request that finds the item finished or the content no longer wanted removes only its
 *   own temporary file. `finish` needs every wanted content stored and nothing `company-full`.
 * - **Idempotent**: one item per (ticket, PC key), at most 3 PCs; a repeat while receiving
 *   replaces the manifest (contents already stored stay); a blob PUT by its sha256 (stored → 204);
 *   `finish` again while waiting → the same 200, after a decision → 409 `ALREADY_RECEIVED`.
 * - **Retention** (I8, the server clock): receiving items older than 2 days are removed (a later
 *   upload starts again), waiting ones expire 30 days after arrival, and contents of every item
 *   done with them are deleted; files no stored entry names and old temporary files go too.
 */
import { normalizeRepoPath } from '../../shared/core/paths'
import { isSecretFileName, secretIn } from '../../shared/core/secret-patterns'
import { CLOCK_ACTOR } from '../../shared/core/core-types'
import {
  HOLDING_CODES, HOLDING_COMPANY_BYTES, HOLDING_CONTENT_KINDS, HOLDING_ENTRY_KINDS, HOLDING_LIMITS, HOLDING_PROTOCOL,
  type HoldingEntryKind, type HoldingFinishResponse, type HoldingItemResponse, type HoldingTicketView, type HoldingTicketsResponse,
} from '../../shared/types/private-holding'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource, CompanyData } from '../ports/company-data'
import type { HoldingBlobStore, HoldingFile, HoldingItem, HoldingTicket, HoldingTicketLookup } from '../ports/holding'
import type { Transactions } from '../ports/transactions'
import { logError } from '../lib/error-log'
import { ok, refuse, type Outcome } from './outcome'

const DAY_MS = 24 * 60 * 60 * 1000
/** How long an item stays after it arrived (owner decision, question 3). */
export const HOLDING_ITEM_DAYS = 30
/** A receiving item left unfinished this long is removed; the app's next try starts again. */
export const HOLDING_RECEIVING_DAYS = 2
/** A temporary file this old belongs to no running upload (an upload stopped halfway): the sweep removes it. */
const TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000
/** Tickets closed this long ago are still listed (the app learns why it may not hand over). */
const CLOSED_TICKETS_LISTED_DAYS = 90
const MAX_PATH = 1024
const MAX_LABEL = 200

/**
 * Per member and hour (in memory, per server): blob PUTs (one full item of 5,000 entries fits; the
 * bytes are bounded by the caps) and items / finishes. Uploads running at once: per member and per server.
 */
const rates = { blobsPerHour: 6000, writesPerHour: 120, uploadsPerUser: 2, uploadsPerServer: 8 }
const RATE_WINDOW_MS = 60 * 60 * 1000

/** Tests only. */
export function setHoldingRatesForTests(next: Partial<typeof rates>): void {
  Object.assign(rates, next)
}

export interface PrivateHoldingDeps {
  companyData: CompanyDataSource
  ticketLookup: HoldingTicketLookup
  blobs: HoldingBlobStore
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
}

const NOT_FOUND = () => refuse('not-found', 'Not found')
const INVALID = (error = 'Invalid request') => refuse('bad-request', error, { code: HOLDING_CODES.invalid })
const ALREADY_RECEIVED = () => refuse('conflict', 'Already received', { code: HOLDING_CODES.alreadyReceived })
const ERASED = () => refuse('gone', 'The operator erased what was handed over', { code: HOLDING_CODES.erased })
/**
 * An item that is not receiving any more, to its own member: received (`ALREADY_RECEIVED`: the app may
 * remove its copy) — unless the operator erased it (`ERASED`: never told it was received, owner
 * decision L4, 2026-11-24; the app keeps its copy).
 */
const notReceiving = (item: HoldingItem | null | undefined) => (item?.erasedAt ? ERASED() : ALREADY_RECEIVED())
const COMPANY_FULL = () => refuse('conflict', 'The holding place is full for now; keep the files and try again later', { code: HOLDING_CODES.companyFull })
const HASH_MISMATCH = () => refuse('bad-request', 'The content is not the one named', { code: HOLDING_CODES.hashMismatch })

const SHA = /^[0-9a-f]{64}$/
const DEVICE_KEY = /^[A-Za-z0-9_-]{8,128}$/
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

const isContentKind = (k: HoldingEntryKind) => HOLDING_CONTENT_KINDS.includes(k)

interface ParsedEntry { path: string; kind: HoldingEntryKind; size: number; sha256: string | null; label: string | null }
interface ParsedItem { deviceKey: string; baseCommit: string | null; manifest: ParsedEntry[] }

/** The manifest as the server keeps it, or null (one fixed 400: never the request's values). */
function parseItem(body: unknown): ParsedItem | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  if (typeof b.deviceKey !== 'string' || !DEVICE_KEY.test(b.deviceKey)) return null
  const baseCommit = b.baseCommit ?? null
  if (baseCommit !== null && (typeof baseCommit !== 'string' || !COMMIT.test(baseCommit))) return null
  if (!Array.isArray(b.manifest) || b.manifest.length === 0) return null
  const manifest: ParsedEntry[] = []
  const sizeOf = new Map<string, number>()
  for (const raw of b.manifest) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const e = raw as Record<string, unknown>
    if (typeof e.path !== 'string' || e.path.length === 0 || e.path.length > MAX_PATH || CONTROL.test(e.path)) return null
    const path = normalizeRepoPath(e.path)
    if (!path) return null
    if (typeof e.kind !== 'string' || !(HOLDING_ENTRY_KINDS as readonly string[]).includes(e.kind)) return null
    const kind = e.kind as HoldingEntryKind
    if (typeof e.size !== 'number' || !Number.isSafeInteger(e.size) || e.size < 0) return null
    const sha256 = e.sha256 ?? null
    if (isContentKind(kind)) {
      if (typeof sha256 !== 'string' || !SHA.test(sha256)) return null
      // One content, one size: a manifest that says otherwise is not consistent.
      if (sizeOf.has(sha256) && sizeOf.get(sha256) !== e.size) return null
      sizeOf.set(sha256, e.size)
    } else if (sha256 !== null) {
      return null
    }
    let label: string | null = null
    if (e.label !== undefined && e.label !== null) {
      if (typeof e.label !== 'string' || e.label.length > MAX_LABEL || CONTROL.test(e.label)) return null
      label = e.label.normalize('NFC')
    }
    manifest.push({ path, kind, size: e.size, sha256: isContentKind(kind) ? sha256 as string : null, label })
  }
  return { deviceKey: b.deviceKey, baseCommit, manifest }
}

/**
 * Which entries keep their content: in manifest order, each distinct content counted once, within
 * the file and item caps (else a name only) and the room now — the ticket's share and the
 * company's (else `company-full`: the app keeps its copy and tries again; the ticket's share frees
 * up when the folder's managers decide its other items, so it is not a cap that loses work).
 * `ticketOther` / `companyOther`: bytes stored by the ticket's / company's other items.
 */
function acceptEntries(entries: ParsedEntry[], room: { ticketOther: number; companyOther: number }, alreadyStored: Map<string, number>): HoldingFile[] {
  let total = 0
  const decided = new Map<string, HoldingFile['dropped']>()
  return entries.map((e, idx): HoldingFile => {
    const nameOnly = (dropped: HoldingFile['dropped']): HoldingFile =>
      ({ idx, path: e.path, kind: 'names-only', size: e.size, sha256: null, label: e.label, stored: false, dropped })
    if (idx >= HOLDING_LIMITS.files) return nameOnly(e.sha256 ? 'too-large' : null)
    if (!e.sha256) return { idx, path: e.path, kind: e.kind, size: e.size, sha256: null, label: e.label, stored: false, dropped: null }
    if (isSecretFileName(e.path)) return nameOnly('secret')
    const sha = e.sha256
    if (!decided.has(sha)) {
      let dropped: HoldingFile['dropped'] = null
      if (e.size > HOLDING_LIMITS.fileBytes || total + e.size > HOLDING_LIMITS.itemBytes) {
        dropped = 'too-large'
      } else if (room.ticketOther + total + e.size > HOLDING_LIMITS.ticketBytes || room.companyOther + total + e.size > HOLDING_COMPANY_BYTES) {
        dropped = 'company-full'
      } else {
        total += e.size
      }
      decided.set(sha, dropped)
    }
    const dropped = decided.get(sha) ?? null
    if (dropped === 'too-large') return nameOnly('too-large')
    // company-full keeps its kind and sha256: the next manifest judges it again.
    return { idx, path: e.path, kind: e.kind, size: e.size, sha256: sha, label: e.label, stored: dropped === null && alreadyStored.has(sha), dropped }
  })
}

/** The contents still wanted (not dropped, not stored), each once. */
const missingOf = (files: HoldingFile[]) => [...new Set(files.filter(f => f.sha256 && !f.stored && !f.dropped).map(f => f.sha256 as string))]

/** Longer than any secret pattern's match, so one cut between chunks never hides it. */
const SCAN_OVERLAP = 512

/** Pass the chunks through, scanning each (with the end of the one before) for a secret. */
async function* scanned(chunks: AsyncIterable<Uint8Array>, found: { secret: boolean }): AsyncGenerator<Uint8Array> {
  let tail = ''
  for await (const chunk of chunks) {
    // latin1: one character per byte; the patterns are ASCII, as the push checker reads git's bytes.
    // Every content, binary too (a hit there becomes a name only: the safe side).
    const text = tail + Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('latin1')
    if (!found.secret && secretIn(text)) found.secret = true
    tail = text.slice(-SCAN_OVERLAP)
    yield chunk
  }
}

export function createPrivateHoldingService(deps: PrivateHoldingDeps) {
  const { companyData, ticketLookup, blobs, transactions, clock, ids } = deps
  const budgets = new Map<string, { windowStart: number; used: number }>()
  const uploading = new Map<string, number>()
  let uploadingAll = 0
  const locks = new Map<string, Promise<void>>()

  /**
   * One company's holding storage steps, one at a time: naming and marking a content, the sweep, the
   * erasure. (Receiving a body runs outside it, into the request's own temporary file.)
   */
  async function withLock<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
    const before = locks.get(companyId) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>(resolve => { release = resolve })
    const chain = before.then(() => mine)
    locks.set(companyId, chain)
    await before
    try {
      return await fn()
    } finally {
      release()
      if (locks.get(companyId) === chain) locks.delete(companyId)
    }
  }

  /** Null when there is room; else the seconds to wait. */
  function takeBudget(kind: 'blobs' | 'writes', userId: string): number | null {
    const now = clock.nowMs()
    const key = `${kind}\u0000${userId}`
    let b = budgets.get(key)
    if (!b || now - b.windowStart >= RATE_WINDOW_MS) {
      b = { windowStart: now, used: 0 }
      budgets.set(key, b)
    }
    const limit = kind === 'blobs' ? rates.blobsPerHour : rates.writesPerHour
    if (b.used + 1 > limit) return Math.max(1, Math.ceil((b.windowStart + RATE_WINDOW_MS - now) / 1000))
    b.used++
    if (budgets.size > 10_000) for (const [k, v] of budgets) if (now - v.windowStart >= RATE_WINDOW_MS) budgets.delete(k)
    return null
  }
  const rateLimited = (wait: number) => refuse('rate-limited', 'Too many requests; try again later', { code: HOLDING_CODES.rateLimited, retryAfterSeconds: wait })

  const companiesOf = (userId: string) => [...new Set(ticketLookup.ofUser(userId).map(t => t.companyId))]

  /** The caller's own ticket (I3: the one entry check), or the one 404. */
  function ticketFor(userId: string, ticketId: string): Outcome<{ handle: CompanyData; ticket: HoldingTicket }> {
    const found = ticketLookup.ofUser(userId).find(t => t.ticketId === ticketId)
    if (!found) return NOT_FOUND()
    const handle = companyData.forCompany(found.companyId)
    const ticket = handle.holding.get(ticketId)
    // The lookup found it among the caller's own tickets (by their user id): it is theirs.
    if (!ticket) return NOT_FOUND()
    return ok({ handle, ticket })
  }

  /** The caller's own item (through their own tickets' companies), or the one 404. */
  function itemFor(userId: string, itemId: string): Outcome<{ handle: CompanyData; item: HoldingItem; ticket: HoldingTicket }> {
    for (const companyId of companiesOf(userId)) {
      const handle = companyData.forCompany(companyId)
      const item = handle.holdingItems.get(itemId)
      if (!item || item.userId !== userId) continue
      const ticket = handle.holding.get(item.ticketId)
      // An item's ticket is always its own member's (made from it): the check above is the one.
      if (!ticket) return NOT_FOUND()
      return ok({ handle, item, ticket })
    }
    return NOT_FOUND()
  }

  /** What the ticket's own member is told about a ticket that cannot take more. */
  function closed(ticket: HoldingTicket): Outcome<never> | null {
    if (ticket.state === 'cancelled') return refuse('gone', 'You can read this folder again', { code: HOLDING_CODES.cancelled })
    if (ticket.state !== 'open' || Date.parse(ticket.expiresAt) <= clock.nowMs()) {
      return refuse('gone', 'The time to hand over has passed', { code: HOLDING_CODES.expired })
    }
    return null
  }

  function view(companyId: string, t: HoldingTicket): HoldingTicketView {
    const expired = t.state === 'expired' || t.state === 'used' || (t.state === 'open' && Date.parse(t.expiresAt) <= clock.nowMs())
    return {
      ticketId: t.id, companyId, scopeId: t.scopeId,
      state: t.state === 'cancelled' ? 'cancelled' : expired ? 'expired' : 'open',
      expiresAt: t.expiresAt, limits: { ...HOLDING_LIMITS },
    }
  }

  /** Under the company's lock: is this content still wanted by the receiving item, and is there room? Then name it and mark it stored. */
  async function commitBlob(handle: CompanyData, itemId: string, sha256: string, size: number, temp: string): Promise<Outcome<null>> {
    // `size` is the verified one: the bytes received, whose sha256 is the one named.
    const companyId = handle.companyId
    const item = handle.holdingItems.get(itemId)
    // Received, removed or erased meanwhile (another PUT of the same content finished first): only
    // this request's temporary file goes — never a content an item names.
    if (!item) { await blobs.discard(companyId, itemId, temp); return NOT_FOUND() }
    if (item.state !== 'receiving') { await blobs.discard(companyId, itemId, temp); return notReceiving(item) }
    const rows = handle.holdingItems.files(itemId).filter(f => f.sha256 === sha256 && !f.dropped)
    if (rows.length === 0) { await blobs.discard(companyId, itemId, temp); return NOT_FOUND() }
    // The manifest was replaced during the upload with another size for this content: not this one.
    if (rows.some(f => f.size !== size)) { await blobs.discard(companyId, itemId, temp); return HASH_MISMATCH() }
    if (rows.every(f => f.stored) && await blobs.has(companyId, itemId, sha256)) { await blobs.discard(companyId, itemId, temp); return ok(null) }
    // Every cap again, on what is stored (never announcements), read here under the lock: several
    // PCs of one member, or several members, announcing in parallel cannot pass them together.
    if (!rows.some(f => f.stored)) {
      if (item.totalBytes + size > HOLDING_LIMITS.itemBytes) {
        await blobs.discard(companyId, itemId, temp)
        handle.holdingItems.dropContent(itemId, sha256, 'too-large', clock.now())
        return refuse('too-large', 'The content is too large', { code: HOLDING_CODES.tooLarge })
      }
      if (handle.holdingItems.ticketStoredBytes(item.ticketId) + size > HOLDING_LIMITS.ticketBytes
        || handle.holdingItems.storedBytes() + size > HOLDING_COMPANY_BYTES) {
        await blobs.discard(companyId, itemId, temp)
        handle.holdingItems.dropContent(itemId, sha256, 'company-full', clock.now())
        return COMPANY_FULL()
      }
    }
    await blobs.commit(companyId, itemId, temp, sha256)
    if (!handle.holdingItems.markStored(itemId, sha256, clock.now())) {
      // The manifest changed during the rename: keep the file only if a stored entry names it.
      if (!handle.holdingItems.files(itemId).some(f => f.sha256 === sha256 && f.stored)) await blobs.remove(companyId, itemId, sha256)
      const now = handle.holdingItems.get(itemId)
      return now?.state === 'receiving' ? NOT_FOUND() : notReceiving(now)
    }
    return ok(null)
  }

  /** Under the company's lock: entries marked stored whose file is gone are unmarked. The item's entries after it. */
  async function storedOnDisk(handle: CompanyData, itemId: string): Promise<HoldingFile[]> {
    const shas = new Set(handle.holdingItems.files(itemId).filter(f => f.stored && f.sha256).map(f => f.sha256 as string))
    for (const sha of shas) {
      if (!await blobs.has(handle.companyId, itemId, sha)) handle.holdingItems.unmarkStored(itemId, sha, clock.now())
    }
    return handle.holdingItems.files(itemId)
  }

  return {
    /** GET /api/me/holding/tickets: the caller's open tickets, and those closed in the last 90 days. */
    tickets(userId: string): Outcome<HoldingTicketsResponse> {
      const since = clock.nowMs() - CLOSED_TICKETS_LISTED_DAYS * DAY_MS
      const tickets: HoldingTicketView[] = []
      for (const companyId of companiesOf(userId)) {
        for (const t of companyData.forCompany(companyId).holding.ofUser(userId)) {
          if (t.state !== 'open' && Date.parse(t.closedAt ?? t.updatedAt) < since) continue
          tickets.push(view(companyId, t))
        }
      }
      return ok({ protocol: HOLDING_PROTOCOL, tickets })
    },

    /** POST /api/me/holding/tickets/:ticketId/items: the item for this ticket and PC, with the contents still wanted. */
    async startItem(userId: string, ticketId: string, body: unknown): Promise<Outcome<HoldingItemResponse>> {
      const wait = takeBudget('writes', userId)
      if (wait !== null) return rateLimited(wait)
      const found = ticketFor(userId, ticketId)
      if (!found.ok) return found
      const { handle, ticket } = found.value
      const parsed = parseItem(body)
      const existing = parsed ? handle.holdingItems.forDevice(ticket.id, parsed.deviceKey) : null
      // Received already: the app may remove its copy, whatever happened to the ticket since.
      if (existing && existing.state !== 'receiving') return notReceiving(existing)
      const shut = closed(ticket)
      if (shut) return shut
      if (!parsed) return INVALID()
      const at = clock.now()
      const result = transactions.run(() => {
        // Read again inside the transaction: the caps and the device count are decided here.
        const current = handle.holdingItems.forDevice(ticket.id, parsed.deviceKey)
        if (current && current.state !== 'receiving') return notReceiving(current)
        if (!current && handle.holdingItems.countForTicket(ticket.id) >= HOLDING_LIMITS.devices) {
          return refuse('conflict', 'This ticket has its items from enough PCs', { code: HOLDING_CODES.tooManyDevices })
        }
        // Contents already stored keep their verified size: a manifest naming one with another size is refused.
        const stored = new Map(current ? handle.holdingItems.files(current.id).filter(f => f.stored && f.sha256 && !f.dropped).map(f => [f.sha256 as string, f.size]) : [])
        if (parsed.manifest.some(e => e.sha256 && stored.has(e.sha256) && stored.get(e.sha256) !== e.size)) return INVALID()
        const files = acceptEntries(parsed.manifest, {
          ticketOther: handle.holdingItems.ticketStoredBytes(ticket.id, current?.id),
          companyOther: handle.holdingItems.storedBytes(current?.id),
        }, stored)
        const itemId = current?.id ?? ids.newId()
        if (current) {
          if (!handle.holdingItems.replaceFiles(itemId, files, at)) return notReceiving(handle.holdingItems.get(itemId))
        } else {
          handle.holdingItems.create({
            id: itemId, ticketId: ticket.id, userId, deviceKey: parsed.deviceKey, scopeId: ticket.scopeId,
            folderPath: ticket.folderPath, baseCommit: parsed.baseCommit, at,
          }, files)
        }
        return ok({ itemId, files })
      })
      if (!result.ok) return result
      const { itemId } = result.value
      // What is wanted is what is really there: a content marked stored but gone from the disk is
      // asked for again. Contents the new manifest no longer names are removed by the sweep.
      const files = await withLock(handle.companyId, () => storedOnDisk(handle, itemId))
      return ok({
        itemId,
        missing: missingOf(files),
        namesOnly: files.filter(f => f.dropped === 'too-large' || f.dropped === 'secret').map(f => f.idx),
        companyFull: files.filter(f => f.dropped === 'company-full').map(f => f.idx),
      })
    },

    /**
     * PUT /api/me/holding/items/:itemId/blobs/:sha256. Everything that can refuse is asked before
     * `body()` is read; the body then streams into this request's own temporary file.
     */
    async putBlob(userId: string, itemId: string, sha256: string, contentLength: string | undefined,
      body: () => AsyncIterable<Uint8Array> | null): Promise<Outcome<null>> {
      const wait = takeBudget('blobs', userId)
      if (wait !== null) return rateLimited(wait)
      const found = itemFor(userId, itemId)
      if (!found.ok) return found
      const { handle, item, ticket } = found.value
      if (item.state !== 'receiving') return notReceiving(item)
      const shut = closed(ticket)
      if (shut) return shut
      if (!SHA.test(sha256)) return INVALID()
      const named = handle.holdingItems.files(item.id).filter(f => f.sha256 === sha256)
      if (named.length === 0) return NOT_FOUND()
      const wanted = named.filter(f => !f.dropped)
      if (wanted.length === 0) {
        // Dropped as a secret: nothing more to send for it, nothing is kept. No room: try again later.
        return named.some(f => f.dropped === 'company-full') ? COMPANY_FULL() : ok(null)
      }
      // Stored and on disk: nothing to read. (A content lost from the disk is taken again.)
      if (wanted.every(f => f.stored) && await blobs.has(handle.companyId, item.id, sha256)) return ok(null)
      const size = wanted[0].size
      const length = contentLength !== undefined && /^\d{1,16}$/.test(contentLength) ? Number(contentLength) : null
      if (length === null) return INVALID('Content-Length is required')
      if (length > HOLDING_LIMITS.fileBytes) return refuse('too-large', 'The content is too large', { code: HOLDING_CODES.tooLarge })
      if (length !== size) return HASH_MISMATCH()
      const mine = uploading.get(userId) ?? 0
      if (mine >= rates.uploadsPerUser || uploadingAll >= rates.uploadsPerServer) {
        return refuse('rate-limited', 'Enough uploads are running; try again shortly', { code: HOLDING_CODES.busy, retryAfterSeconds: 5 })
      }
      const source = body()
      if (!source) return INVALID()
      uploading.set(userId, mine + 1)
      uploadingAll++
      try {
        const found = { secret: false }
        let received
        try {
          received = await blobs.receive(handle.companyId, item.id, scanned(source, found), size)
        } catch (error) {
          // The connection broke or the disk failed: nothing kept (the store removed its temporary file).
          logError('holding', 'could not receive a held content', error, { company: handle.companyId, item: item.id })
          return refuse('unavailable', 'Could not store the content; try again', { code: 'STORE_FAILED' })
        }
        if (!received) return HASH_MISMATCH()
        if (received.bytes !== size || received.sha256 !== sha256) {
          await blobs.discard(handle.companyId, item.id, received.temp)
          return HASH_MISMATCH()
        }
        if (found.secret) {
          // I7: never kept. Its entries become names only; the bytes go nowhere.
          await blobs.discard(handle.companyId, item.id, received.temp)
          handle.holdingItems.dropContent(item.id, sha256, 'secret', clock.now())
          return ok(null)
        }
        const temp = received.temp
        try {
          return await withLock(handle.companyId, () => commitBlob(handle, item.id, sha256, size, temp))
        } catch (error) {
          await blobs.discard(handle.companyId, item.id, temp).catch(() => undefined)
          logError('holding', 'could not store a held content', error, { company: handle.companyId, item: item.id })
          return refuse('unavailable', 'Could not store the content; try again', { code: 'STORE_FAILED' })
        }
      } finally {
        uploadingAll--
        const left = (uploading.get(userId) ?? 1) - 1
        if (left > 0) uploading.set(userId, left)
        else uploading.delete(userId)
      }
    },

    /** POST /api/me/holding/items/:itemId/finish: received; it waits for the folder's managers. */
    async finish(userId: string, itemId: string): Promise<Outcome<HoldingFinishResponse>> {
      const wait = takeBudget('writes', userId)
      if (wait !== null) return rateLimited(wait)
      const found = itemFor(userId, itemId)
      if (!found.ok) return found
      const { handle, item, ticket } = found.value
      if (item.state === 'waiting') return ok({ state: 'waiting' })
      if (item.state !== 'receiving') return notReceiving(item)
      const shut = closed(ticket)
      if (shut) return shut
      // Under the lock, every content marked stored is looked for on the disk first: one that is gone
      // (a restore from an older copy) is wanted again, so the app never removes what is not held.
      return withLock(handle.companyId, async (): Promise<Outcome<HoldingFinishResponse>> => {
        const files = await storedOnDisk(handle, item.id)
        // Something there is no room for: the app keeps its copy and comes back (never finished half-held).
        if (files.some(f => f.dropped === 'company-full')) return COMPANY_FULL()
        const missing = missingOf(files)
        if (missing.length > 0) return refuse('conflict', 'Some contents have not arrived', { code: HOLDING_CODES.missingFiles, missing })
        const at = clock.now()
        const done = transactions.run(() => {
          if (!handle.holdingItems.finish(item.id, at)) return false
          const now = handle.holdingItems.files(item.id)
          handle.permissionHistory.append({
            action: 'holding-received',
            detail: {
              itemId: item.id, ticketId: ticket.id, scopeId: item.scopeId, userId,
              files: now.length, held: now.filter(f => f.stored).length, namesOnly: now.filter(f => f.kind === 'names-only').length,
              bytes: handle.holdingItems.get(item.id)?.totalBytes ?? 0,
            },
            at,
            byUser: userId,
          })
          return true
        })
        if (!done) {
          const now = handle.holdingItems.get(item.id)
          return now?.state === 'waiting' ? ok({ state: 'waiting' }) : now ? notReceiving(now) : NOT_FOUND()
        }
        return ok({ state: 'waiting' })
      })
    },

    /**
     * The server clock (I8), one company: receiving items left for 2 days removed, waiting items
     * expired after 30 days, then the contents of every item done with them deleted, any directory
     * no row holds removed, and in a live item's directory every file no stored entry names and every
     * temporary file older than an hour. Under the company's lock. Running twice changes nothing
     * more. Returns the items expired or removed.
     */
    async sweep(companyId: string): Promise<number> {
      return withLock(companyId, async () => {
        const handle = companyData.forCompany(companyId)
        const nowMs = clock.nowMs()
        const at = clock.now()
        const abandoned = handle.holdingItems.removeAbandoned(new Date(nowMs - HOLDING_RECEIVING_DAYS * DAY_MS).toISOString())
        const expired = transactions.run(() => {
          const ids = handle.holdingItems.expireWaiting(new Date(nowMs - HOLDING_ITEM_DAYS * DAY_MS).toISOString(), at)
          for (const id of ids) {
            const item = handle.holdingItems.get(id)
            handle.permissionHistory.append({
              action: 'holding-expired', detail: { itemId: id, ticketId: item?.ticketId, scopeId: item?.scopeId, userId: item?.userId }, at, byUser: CLOCK_ACTOR.id,
            })
          }
          return ids
        })
        for (const id of handle.holdingItems.blobsToDelete()) {
          await blobs.removeItem(companyId, id)
          handle.holdingItems.markBlobsDeleted(id, clock.now())
        }
        const live = new Set(handle.holdingItems.holdingContents())
        for (const id of await blobs.itemIds(companyId)) {
          if (!live.has(id)) { await blobs.removeItem(companyId, id); continue }
          const kept = new Set(handle.holdingItems.files(id).filter(f => f.stored && f.sha256 && !f.dropped).map(f => f.sha256 as string))
          for (const e of await blobs.entries(companyId, id)) {
            if (e.temp ? clock.nowMs() - e.mtimeMs > TEMP_FILE_MAX_AGE_MS : !kept.has(e.name)) {
              if (e.temp) await blobs.discard(companyId, id, e.name)
              else await blobs.remove(companyId, id, e.name)
            }
          }
        }
        return abandoned.length + expired.length
      })
    },

    /**
     * The operator's erasure (src/cli/erase-content.ts `holding`): the item's file rows and
     * contents go, the item stays as discarded and marked erased (the member's app is then told
     * `ERASED`, never `ALREADY_RECEIVED`). Refused while the item is still `receiving` (the member's
     * app is uploading — owner decision L4, 2026-11-24) or `taking` (a take-in reads it now): judged
     * in the erase's own transaction, nothing changed.
     */
    async erase(companyId: string, itemId: string, reason: string): Promise<'erased' | 'unknown' | 'receiving' | 'taking'> {
      return withLock(companyId, async () => {
        const handle = companyData.forCompany(companyId)
        const at = clock.now()
        const answer = transactions.run(() => {
          const r = handle.holdingItems.erase(itemId, at)
          if (r === 'erased') handle.permissionHistory.append({ action: 'holding-erased', detail: { itemId, reason }, at, byUser: 'operator' })
          return r
        })
        if (answer !== 'erased') return answer
        await blobs.removeItem(companyId, itemId)
        handle.holdingItems.markBlobsDeleted(itemId, clock.now())
        return answer
      })
    },
  }
}

export type PrivateHoldingService = ReturnType<typeof createPrivateHoldingService>
