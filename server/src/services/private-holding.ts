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
 * - **Caps** (owner decision, question 4): 50 MB a file, 500 MB an item, 5,000 entries, 2 GB of a
 *   company's waiting items, reserved when the manifest arrives (one synchronous stretch, so two
 *   manifests cannot both take the last room). Over a cap an entry is kept as its name only
 *   (`too-large`); 413 only for a blob body over the file cap (the route's body limit).
 * - **No secret is kept** (I7): a secret's file name (`.env`, `.env.*`) is a name only; every
 *   text content is scanned with shared/core/secret-patterns.ts when it arrives and, on a hit,
 *   dropped (its entries become names only, `secret`). The app filters too; the server decides.
 * - **Idempotent**: one item per (ticket, PC key), at most 3 PCs; a repeat while receiving
 *   replaces the manifest (contents already stored stay); a blob PUT by its sha256 (stored → 204);
 *   `finish` again while waiting → the same 200, after a decision → 409 `ALREADY_RECEIVED`.
 * - **Retention** (I8, the server clock): receiving items older than 2 days are removed (a later
 *   upload starts again), waiting ones expire 30 days after arrival, and contents of every item
 *   done with them are deleted; directories no row holds are removed too. Rows stay as the record.
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
/** Tickets closed this long ago are still listed (the app learns why it may not hand over). */
const CLOSED_TICKETS_LISTED_DAYS = 90
const MAX_PATH = 1024
const MAX_LABEL = 200

/**
 * Per member and hour (in memory, per server). Blob PUTs: one full item (5,000 entries) fits;
 * the bytes are bounded by the caps. Items and finishes: a few PCs retrying for an hour.
 */
const rates = { blobsPerHour: 6000, writesPerHour: 120 }
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
  /** sha256 of bytes, lower-case hex (composition: node's crypto). */
  sha256(bytes: Uint8Array): string
  /** Let the event loop serve other requests (between chunks of a secret scan). */
  yieldNow(): Promise<void>
}

const NOT_FOUND = () => refuse('not-found', 'Not found')
const INVALID = () => refuse('bad-request', 'Invalid request', { code: HOLDING_CODES.invalid })
const ALREADY_RECEIVED = () => refuse('conflict', 'Already received', { code: HOLDING_CODES.alreadyReceived })

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
 * Which entries keep their content, within the caps: in manifest order, each distinct content
 * counted once. Returns the rows (with `stored` from `alreadyStored`) and the bytes reserved.
 */
function acceptEntries(entries: ParsedEntry[], otherHeldBytes: number, alreadyStored: Set<string>): { files: HoldingFile[]; totalBytes: number } {
  let total = 0
  const accepted = new Set<string>()
  const refused = new Set<string>()
  const files = entries.map((e, idx): HoldingFile => {
    const nameOnly = (dropped: HoldingFile['dropped']): HoldingFile =>
      ({ idx, path: e.path, kind: 'names-only', size: e.size, sha256: null, label: e.label, stored: false, dropped })
    if (idx >= HOLDING_LIMITS.files) return nameOnly(e.sha256 ? 'too-large' : null)
    if (!e.sha256) return { idx, path: e.path, kind: e.kind, size: e.size, sha256: null, label: e.label, stored: false, dropped: null }
    if (isSecretFileName(e.path)) return nameOnly('secret')
    const sha = e.sha256
    if (!accepted.has(sha)) {
      if (refused.has(sha) || e.size > HOLDING_LIMITS.fileBytes || total + e.size > HOLDING_LIMITS.itemBytes
        || otherHeldBytes + total + e.size > HOLDING_COMPANY_BYTES) {
        refused.add(sha)
        return nameOnly('too-large')
      }
      accepted.add(sha)
      total += e.size
    }
    return { idx, path: e.path, kind: e.kind, size: e.size, sha256: sha, label: e.label, stored: alreadyStored.has(sha), dropped: null }
  })
  return { files, totalBytes: total }
}

/** The contents still wanted (accepted, not stored), each once. */
const missingOf = (files: HoldingFile[]) => [...new Set(files.filter(f => f.sha256 && !f.stored && !f.dropped).map(f => f.sha256 as string))]

/** git's own test for "binary": a NUL byte in the first 8000 bytes. Only text is scanned for secrets. */
function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8000)
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true
  return false
}

const SCAN_CHUNK = 1024 * 1024
/** Longer than any secret pattern's match, so one cut between chunks never hides it. */
const SCAN_OVERLAP = 512

export function createPrivateHoldingService(deps: PrivateHoldingDeps) {
  const { companyData, ticketLookup, blobs, transactions, clock, ids } = deps
  const budgets = new Map<string, { windowStart: number; used: number }>()

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

  /** Does this content hold a secret (text only, scanned in chunks with a yield between)? */
  async function holdsSecret(bytes: Uint8Array): Promise<boolean> {
    if (looksBinary(bytes)) return false
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let start = 0; start < buf.length; start += SCAN_CHUNK) {
      // latin1: one character per byte; the patterns are ASCII, as the push checker reads git's bytes.
      const chunk = buf.subarray(Math.max(0, start - SCAN_OVERLAP), Math.min(buf.length, start + SCAN_CHUNK)).toString('latin1')
      if (secretIn(chunk)) return true
      if (start + SCAN_CHUNK < buf.length) await deps.yieldNow()
    }
    return false
  }

  /** The distinct accepted contents' bytes of these rows. */
  const bytesOf = (files: HoldingFile[]) => {
    const seen = new Map<string, number>()
    for (const f of files) if (f.sha256 && !f.dropped) seen.set(f.sha256, f.size)
    return [...seen.values()].reduce((a, b) => a + b, 0)
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
    startItem(userId: string, ticketId: string, body: unknown): Outcome<HoldingItemResponse> {
      const wait = takeBudget('writes', userId)
      if (wait !== null) return rateLimited(wait)
      const found = ticketFor(userId, ticketId)
      if (!found.ok) return found
      const { handle, ticket } = found.value
      const parsed = parseItem(body)
      const existing = parsed ? handle.holdingItems.forDevice(ticket.id, parsed.deviceKey) : null
      // Received already: the app may remove its copy, whatever happened to the ticket since.
      if (existing && existing.state !== 'receiving') return ALREADY_RECEIVED()
      const shut = closed(ticket)
      if (shut) return shut
      if (!parsed) return INVALID()
      const at = clock.now()
      const result = transactions.run(() => {
        // Read again inside the transaction: the caps and the device count are decided here.
        const current = handle.holdingItems.forDevice(ticket.id, parsed.deviceKey)
        if (current && current.state !== 'receiving') return ALREADY_RECEIVED()
        if (!current && handle.holdingItems.countForTicket(ticket.id) >= HOLDING_LIMITS.devices) {
          return refuse('conflict', 'This ticket has its items from enough PCs', { code: HOLDING_CODES.tooManyDevices })
        }
        const stored = new Set(current ? handle.holdingItems.files(current.id).filter(f => f.stored && f.sha256).map(f => f.sha256 as string) : [])
        const { files, totalBytes } = acceptEntries(parsed.manifest, handle.holdingItems.heldBytes(current?.id), stored)
        const itemId = current?.id ?? ids.newId()
        if (current) {
          if (!handle.holdingItems.replaceFiles(itemId, files, totalBytes, at)) return ALREADY_RECEIVED()
        } else {
          handle.holdingItems.create({
            id: itemId, ticketId: ticket.id, userId, deviceKey: parsed.deviceKey, scopeId: ticket.scopeId,
            folderPath: ticket.folderPath, baseCommit: parsed.baseCommit, totalBytes, at,
          }, files)
        }
        const dropped = [...stored].filter(sha => !files.some(f => f.sha256 === sha))
        return ok({ itemId, files, dropped })
      })
      if (!result.ok) return result
      const { itemId, files, dropped } = result.value
      // Contents the new manifest no longer names: not kept (best effort; the clock removes the rest with the item).
      for (const sha of dropped) void blobs.remove(handle.companyId, itemId, sha).catch(() => undefined)
      return ok({ itemId, missing: missingOf(files), namesOnly: files.filter(f => f.dropped !== null).map(f => f.idx) })
    },

    /** PUT /api/me/holding/items/:itemId/blobs/:sha256: one content (the route limits the body). */
    async putBlob(userId: string, itemId: string, sha256: string, bytes: Uint8Array): Promise<Outcome<null>> {
      const wait = takeBudget('blobs', userId)
      if (wait !== null) return rateLimited(wait)
      const found = itemFor(userId, itemId)
      if (!found.ok) return found
      const { handle, item, ticket } = found.value
      if (item.state !== 'receiving') return ALREADY_RECEIVED()
      const shut = closed(ticket)
      if (shut) return shut
      if (!SHA.test(sha256)) return INVALID()
      const named = handle.holdingItems.files(item.id).filter(f => f.sha256 === sha256)
      if (named.length === 0) return NOT_FOUND()
      const wanted = named.filter(f => !f.dropped)
      // Dropped as a secret already: nothing more to send for it, and nothing is kept.
      if (wanted.length === 0) return ok(null)
      if (wanted.every(f => f.stored)) return ok(null)
      if (bytes.byteLength !== wanted[0].size || deps.sha256(bytes) !== sha256) {
        return refuse('bad-request', 'The content is not the one named', { code: HOLDING_CODES.hashMismatch })
      }
      if (await holdsSecret(bytes)) {
        // I7: never kept. Its entries become names only; the bytes go nowhere.
        transactions.run(() => {
          const rest = handle.holdingItems.files(item.id).filter(f => f.sha256 !== sha256)
          handle.holdingItems.dropContent(item.id, sha256, bytesOf(rest), clock.now())
        })
        return ok(null)
      }
      try {
        await blobs.put(handle.companyId, item.id, sha256, bytes)
      } catch (error) {
        logError('holding', 'could not store a held content', error, { company: handle.companyId, item: item.id })
        return refuse('unavailable', 'Could not store the content; try again', { code: 'STORE_FAILED' })
      }
      // Read again after the await: the item may have been finished, removed or erased meanwhile.
      if (!handle.holdingItems.markStored(item.id, sha256, clock.now())) {
        await blobs.remove(handle.companyId, item.id, sha256).catch(() => undefined)
        return handle.holdingItems.get(item.id) ? ALREADY_RECEIVED() : NOT_FOUND()
      }
      return ok(null)
    },

    /** POST /api/me/holding/items/:itemId/finish: received; it waits for the folder's managers. */
    finish(userId: string, itemId: string): Outcome<HoldingFinishResponse> {
      const wait = takeBudget('writes', userId)
      if (wait !== null) return rateLimited(wait)
      const found = itemFor(userId, itemId)
      if (!found.ok) return found
      const { handle, item, ticket } = found.value
      if (item.state === 'waiting') return ok({ state: 'waiting' })
      if (item.state !== 'receiving') return ALREADY_RECEIVED()
      const shut = closed(ticket)
      if (shut) return shut
      const missing = missingOf(handle.holdingItems.files(item.id))
      if (missing.length > 0) return refuse('conflict', 'Some contents have not arrived', { code: HOLDING_CODES.missingFiles, missing })
      const at = clock.now()
      const done = transactions.run(() => {
        if (!handle.holdingItems.finish(item.id, at)) return false
        const files = handle.holdingItems.files(item.id)
        handle.permissionHistory.append({
          action: 'holding-received',
          detail: {
            itemId: item.id, ticketId: ticket.id, scopeId: item.scopeId, userId,
            files: files.length, held: files.filter(f => f.stored).length, namesOnly: files.filter(f => f.kind === 'names-only').length,
            bytes: bytesOf(files),
          },
          at,
          byUser: userId,
        })
        return true
      })
      if (!done) {
        const now = handle.holdingItems.get(item.id)
        return now?.state === 'waiting' ? ok({ state: 'waiting' }) : now ? ALREADY_RECEIVED() : NOT_FOUND()
      }
      return ok({ state: 'waiting' })
    },

    /**
     * The server clock (I8), one company: receiving items left for 2 days removed, waiting items
     * expired after 30 days, then the contents of every item done with them deleted, and any
     * directory no row holds. Running twice changes nothing more. Returns the items expired or removed.
     */
    async sweep(companyId: string): Promise<number> {
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
      const keep = new Set(handle.holdingItems.holdingContents())
      for (const id of await blobs.itemIds(companyId)) {
        // Read again: an item may have been started since the list above.
        if (!keep.has(id) && !handle.holdingItems.holdingContents().includes(id)) await blobs.removeItem(companyId, id)
      }
      return abandoned.length + expired.length
    },

    /**
     * The operator's erasure (src/cli/erase-content.ts `holding`): the item's file rows and
     * contents go, the item stays as discarded (so the app's retry is told it was received).
     */
    async erase(companyId: string, itemId: string, reason: string): Promise<boolean> {
      const handle = companyData.forCompany(companyId)
      const at = clock.now()
      const erased = transactions.run(() => {
        if (!handle.holdingItems.erase(itemId, at)) return false
        handle.permissionHistory.append({ action: 'holding-erased', detail: { itemId, reason }, at, byUser: 'operator' })
        return true
      })
      if (!erased) return false
      await blobs.removeItem(companyId, itemId)
      handle.holdingItems.markBlobsDeleted(itemId, clock.now())
      return true
    },
  }
}

export type PrivateHoldingService = ReturnType<typeof createPrivateHoldingService>
