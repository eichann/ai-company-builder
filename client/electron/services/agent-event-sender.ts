// Sends the AI action log (monitoring M1) to the server: the recorder's sink
// (services/agent-events.ts). Events wait in one queue per (signed-in
// account, company), kept on disk under <userData>/agent-events/ so nothing is
// lost while offline or across a restart, and go out in batches with the
// session cookie (POST /api/companies/:companyId/agent-events, contract
// shared/types/agent-events.ts).
//
// - Never another account's: an event is filed under the account signed in
//   when its turn first reported (services/session.ts `userId`, known once
//   /api/me confirmed the session), and a queue is sent only while that same
//   account is signed in. Events with no known account or company are dropped
//   (counted, logged once).
// - On disk: <dir>/<user>/<company>.jsonl, one `{ t, e }` line per event
//   (t = when it was queued), files 0600, folders 0700. Appends are batched
//   and asynchronous; after a send the file is rewritten (temporary file +
//   rename) with what is left. A torn last line (crash mid-write) is skipped.
//   Per queue at most 10 MB and 7 days: the oldest go first (counted, logged).
// - Sending: every 60 s while events wait (never with an empty queue), 2 s
//   after a chat turn ends (`turnEnded`, so its closing events are in), and at
//   once when a full batch (200) waits; one request in flight per queue. The
//   log is for looking back, not real time — the emergency stop (M2) has its
//   own path — so the app and server are not woken every few seconds. 2xx → removed (re-sends are fine,
//   the server drops duplicate ids); 401 → kept until the next sign-in;
//   404 "not a member" → the queue is deleted; 400 / 413 → the batch is
//   halved, a single event the server still refuses is dropped; 429 →
//   Retry-After; network / 5xx / anything else → backoff doubling to 5 min.
// - Quit: timers stop and what is only in memory is written synchronously
//   (no network wait). Sign-out: sending stops; the queues stay.
// - Logs counts and status codes only, never an event's content.

import fs from 'node:fs'
import path from 'node:path'
import {
  AGENT_EVENTS_MAX_PER_REQUEST,
  type AgentEventIngestResult,
  type AgentToolEvent,
} from '../../../shared/types/agent-events'
import type { AgentEventSink } from './agent-events'

export interface SenderClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface AgentEventSenderDeps {
  /** The folder the queues live in (<userData>/agent-events). */
  dir: () => string
  /** Server base URL ('' when not configured). */
  baseUrl: () => string
  /** The session cookies ([] when signed out). */
  cookies: () => string[]
  /** The signed-in account (null while unknown or signed out). */
  userId: () => string | null
  fetch?: typeof fetch
  clock?: SenderClock
  log?: Pick<Console, 'log' | 'warn'>
  /** Tuning (tests). */
  limits?: Partial<SenderLimits>
}

/** While events wait: one send per queue per minute at most (besides turn ends and full batches). */
export const AGENT_EVENTS_SEND_INTERVAL_MS = 60_000
/** After a chat turn ends: its last events (closing `unfinished` ones) come right after the response. */
export const AGENT_EVENTS_TURN_END_DELAY_MS = 2_000

export interface SenderLimits {
  sendIntervalMs: number
  turnEndDelayMs: number
  /** First retry after a network / 5xx failure; doubles up to maxBackoffMs. */
  backoffBaseMs: number
  writeDelayMs: number
  maxBatch: number
  maxBatchBytes: number
  maxQueueBytes: number
  maxAgeMs: number
  maxBackoffMs: number
  defaultRetryAfterMs: number
}

const DEFAULT_LIMITS: SenderLimits = {
  sendIntervalMs: AGENT_EVENTS_SEND_INTERVAL_MS,
  turnEndDelayMs: AGENT_EVENTS_TURN_END_DELAY_MS,
  backoffBaseMs: 10_000,
  writeDelayMs: 1_000,
  maxBatch: AGENT_EVENTS_MAX_PER_REQUEST,
  // The server takes ≤ 1 MB per request; events are well under 2 KB each.
  maxBatchBytes: 900 * 1024,
  maxQueueBytes: 10 * 1024 * 1024,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxBackoffMs: 5 * 60 * 1000,
  defaultRetryAfterMs: 60_000,
}

export interface AgentEventSender extends AgentEventSink {
  /** A chat turn ended: send the signed-in account's waiting events shortly. */
  turnEnded(): void
  /** An account was confirmed signed in (sign-in, or the session restored): send its queues. */
  sessionStarted(): void
  /** Signed out: stop sending (the queues stay for the next sign-in of that account). */
  signedOut(): void
  /** Quit: stop timers, write what is only in memory synchronously. No network. */
  flushSync(): void
  /** Tests: resolves once no write or send is running. */
  whenIdle(): Promise<void>
  /** Tests / diagnostics: events waiting per `<user>/<company>`. */
  pending(): Record<string, number>
  /** Tests / diagnostics. */
  stats(): { droppedNoAccount: number; droppedCap: number; droppedRejected: number }
}

interface Entry { t: number; e: AgentToolEvent; line: string; bytes: number }

interface Queue {
  key: string
  userId: string
  companyId: string
  file: string
  events: Entry[]
  bytes: number
  /** Entries queued since the last write (appended next, unless the file is rewritten). */
  unwritten: Entry[]
  rewrite: boolean
  loaded: boolean
  chain: Promise<void>
  writing: boolean
  writeTimer: unknown
  sendTimer: unknown
  /** When sendTimer fires. */
  sendAt: number
  sending: Promise<void> | null
  /** Earliest time the next send may start (backoff / Retry-After). */
  notBefore: number
  failures: number
  /** After a 401: wait for the next sign-in. */
  authBlocked: boolean
  batchLimit: number
  droppedUnlogged: number
  removed: boolean
}

const SIDE_FILE = '.quit'

/** A file-name-safe spelling of an id (never '.', '..' or a separator). */
export function safeSegment(id: string): string {
  return encodeURIComponent(id).replace(/[.!'()*~]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
}

function parseLines(text: string): { entries: Entry[]; bad: number } {
  const entries: Entry[] = []
  let bad = 0
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const value = JSON.parse(line) as { t?: unknown; e?: unknown }
      const e = value?.e as AgentToolEvent | undefined
      if (typeof value?.t !== 'number' || !e || typeof e !== 'object' || typeof e.id !== 'string') { bad++; continue }
      entries.push({ t: value.t, e, line, bytes: Buffer.byteLength(line) + 1 })
    } catch {
      bad++
    }
  }
  return { entries, bad }
}

function retryAfterMs(value: string | null, now: number): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

const realClock: SenderClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    // Never keeps the process alive on its own.
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function createAgentEventSender(deps: AgentEventSenderDeps): AgentEventSender {
  const limits: SenderLimits = { ...DEFAULT_LIMITS, ...deps.limits }
  const clock = deps.clock ?? realClock
  const log = deps.log ?? console
  const doFetch = (url: string, init: RequestInit) => (deps.fetch ?? fetch)(url, init)
  const queues = new Map<string, Queue>()
  /** turnId → the account its first event was filed under (a turn never changes account). */
  const turnOwners = new Map<string, string>()
  const scannedUsers = new Set<string>()
  /** Work not tied to a live queue (folder scans, deleting a dropped queue's files). */
  const background = new Set<Promise<unknown>>()
  const track = (work: Promise<unknown>) => { background.add(work); void work.finally(() => background.delete(work)) }
  const stats = { droppedNoAccount: 0, droppedCap: 0, droppedRejected: 0 }
  let warnedNoAccount = false
  let warnedWrite = false
  let closed = false

  const userDir = (userId: string) => path.join(deps.dir(), safeSegment(userId))
  const label = (q: Queue) => `queue ${q.companyId}`

  function queueFor(userId: string, companyId: string): Queue {
    const key = `${userId}\u0000${companyId}`
    let q = queues.get(key)
    if (!q) {
      q = {
        key, userId, companyId,
        file: path.join(userDir(userId), `${safeSegment(companyId)}.jsonl`),
        events: [], bytes: 0, unwritten: [], rewrite: false, loaded: false,
        chain: Promise.resolve(), writing: false, writeTimer: undefined, sendTimer: undefined, sendAt: 0,
        sending: null, notBefore: 0, failures: 0, authBlocked: false, batchLimit: limits.maxBatch,
        droppedUnlogged: 0, removed: false,
      }
      queues.set(key, q)
      const queue = q
      enqueueIo(queue, () => load(queue))
    }
    return q
  }

  function enqueueIo(q: Queue, op: () => Promise<void>): Promise<void> {
    const next = q.chain.then(async () => {
      if (closed || q.removed) return
      q.writing = true
      try { await op() } finally { q.writing = false }
    }).catch(error => {
      if (!warnedWrite) { warnedWrite = true; log.warn(`[agent-events] could not write the queue: ${error instanceof Error ? (error as NodeJS.ErrnoException).code ?? 'error' : 'error'}`) }
      q.rewrite = true
    })
    q.chain = next
    return next
  }

  async function readIfExists(file: string): Promise<string | null> {
    try { return await fs.promises.readFile(file, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async function load(q: Queue): Promise<void> {
    const main = await readIfExists(q.file)
    const side = await readIfExists(q.file + SIDE_FILE)
    q.loaded = true
    if (main === null && side === null) { scheduleSend(q); return }
    const fromMain = parseLines(main ?? '')
    const fromSide = parseLines(side ?? '')
    const seen = new Set(q.events.map(entry => entry.e.id))
    const disk: Entry[] = []
    for (const entry of [...fromMain.entries, ...fromSide.entries]) {
      if (seen.has(entry.e.id)) continue
      seen.add(entry.e.id)
      disk.push(entry)
    }
    disk.sort((a, b) => a.t - b.t)
    q.events = [...disk, ...q.events]
    q.bytes = q.events.reduce((sum, entry) => sum + entry.bytes, 0)
    // A torn or unreadable line, or the quit side file: write the file afresh
    // (appending after a torn line would merge it with the next one).
    if (fromMain.bad > 0 || fromSide.bad > 0 || side !== null || (main !== null && main.length > 0 && !main.endsWith('\n'))) q.rewrite = true
    if (fromMain.bad + fromSide.bad > 0) log.warn(`[agent-events] ${label(q)}: skipped ${fromMain.bad + fromSide.bad} unreadable line(s)`)
    enforceCaps(q)
    if (q.rewrite) scheduleWrite(q, 0)
    // Left from before (offline, a restart): no reason to wait.
    scheduleSend(q, disk.length > 0 ? 0 : undefined)
  }

  function enforceCaps(q: Queue): void {
    const oldest = clock.now() - limits.maxAgeMs
    let drop = 0
    while (drop < q.events.length && (q.events[drop].t < oldest || q.bytes > limits.maxQueueBytes)) {
      q.bytes -= q.events[drop].bytes
      drop++
    }
    if (drop === 0) return
    const gone = new Set(q.events.slice(0, drop))
    q.events = q.events.slice(drop)
    q.unwritten = q.unwritten.filter(entry => !gone.has(entry))
    q.rewrite = true
    stats.droppedCap += drop
    q.droppedUnlogged += drop
  }

  function logDrops(q: Queue): void {
    if (q.droppedUnlogged === 0) return
    log.warn(`[agent-events] ${label(q)}: dropped the ${q.droppedUnlogged} oldest event(s) (over 10 MB or 7 days; ${stats.droppedCap} in all)`)
    q.droppedUnlogged = 0
  }

  async function writeFileAtomic(file: string, text: string): Promise<void> {
    const tmp = `${file}.tmp`
    await fs.promises.writeFile(tmp, text, { mode: 0o600 })
    if (closed) return
    await fs.promises.rename(tmp, file)
  }

  async function write(q: Queue): Promise<void> {
    if (!q.rewrite && q.unwritten.length === 0) return
    await fs.promises.mkdir(path.dirname(q.file), { recursive: true, mode: 0o700 })
    if (q.rewrite) {
      q.rewrite = false
      q.unwritten = []
      const snapshot = q.events
      if (snapshot.length === 0) {
        await fs.promises.rm(q.file, { force: true })
      } else {
        await writeFileAtomic(q.file, snapshot.map(entry => entry.line + '\n').join(''))
      }
      // Everything the side file held is in the queue file now.
      if (!closed) await fs.promises.rm(q.file + SIDE_FILE, { force: true })
    } else {
      const lines = q.unwritten.splice(0)
      await fs.promises.appendFile(q.file, lines.map(entry => entry.line + '\n').join(''), { mode: 0o600 })
    }
    logDrops(q)
  }

  function scheduleWrite(q: Queue, delay = limits.writeDelayMs): void {
    if (closed || q.writeTimer !== undefined) return
    q.writeTimer = clock.setTimeout(() => {
      q.writeTimer = undefined
      void enqueueIo(q, () => write(q))
    }, delay)
  }

  function canSend(q: Queue): boolean {
    return !closed && !q.removed && q.loaded && !q.authBlocked && q.events.length > 0
      && deps.userId() === q.userId && deps.cookies().length > 0 && deps.baseUrl() !== ''
  }

  function scheduleSend(q: Queue, delay?: number): void {
    if (!canSend(q) || q.sending) return
    const now = clock.now()
    // Waiting out a backoff / Retry-After replaces the interval; a full batch goes at once.
    const wait = Math.max(delay ?? (q.events.length >= q.batchLimit || q.notBefore > now ? 0 : limits.sendIntervalMs), q.notBefore - now, 0)
    if (q.sendTimer !== undefined) {
      // Keep the earlier of the two.
      if (q.sendAt <= now + wait) return
      clock.clearTimeout(q.sendTimer)
    }
    q.sendAt = now + wait
    q.sendTimer = clock.setTimeout(() => {
      q.sendTimer = undefined
      startSend(q)
    }, wait)
  }

  function batchOf(q: Queue): Entry[] {
    const batch: Entry[] = []
    let bytes = 0
    for (const entry of q.events) {
      if (batch.length >= q.batchLimit || (batch.length > 0 && bytes + entry.bytes > limits.maxBatchBytes)) break
      batch.push(entry)
      bytes += entry.bytes
    }
    return batch
  }

  function remove(q: Queue, batch: Entry[]): void {
    const gone = new Set(batch)
    q.events = q.events.filter(entry => !gone.has(entry))
    q.unwritten = q.unwritten.filter(entry => !gone.has(entry))
    q.bytes = q.events.reduce((sum, entry) => sum + entry.bytes, 0)
    q.rewrite = true
    scheduleWrite(q)
  }

  function backoff(q: Queue, ms?: number): void {
    q.failures++
    const delay = ms ?? Math.min(limits.maxBackoffMs, limits.backoffBaseMs * 2 ** (q.failures - 1))
    q.notBefore = clock.now() + delay
  }

  function dropQueue(q: Queue): void {
    q.removed = true
    queues.delete(q.key)
    if (q.writeTimer !== undefined) clock.clearTimeout(q.writeTimer)
    if (q.sendTimer !== undefined) clock.clearTimeout(q.sendTimer)
    const file = q.file
    q.chain = q.chain.then(async () => {
      await fs.promises.rm(file, { force: true })
      await fs.promises.rm(file + SIDE_FILE, { force: true })
    }).catch(() => {})
    track(q.chain)
  }

  function startSend(q: Queue): void {
    if (!canSend(q) || q.sending) return
    const batch = batchOf(q)
    if (batch.length === 0) return
    // Captured together: the request carries exactly the account the queue belongs to.
    const cookies = deps.cookies()
    const url = `${deps.baseUrl()}/api/companies/${encodeURIComponent(q.companyId)}/agent-events`
    const body = `{"events":[${batch.map(entry => JSON.stringify(entry.e)).join(',')}]}`
    q.sending = (async () => {
      let status = 0
      let response: Response | undefined
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Cookie': cookies.join('; ') },
          body,
        })
        status = response.status
      } catch {
        status = 0
      }
      if (q.removed) return
      if (status >= 200 && status < 300) {
        let result: Partial<AgentEventIngestResult> = {}
        try { result = ((await response!.json()) as { data?: AgentEventIngestResult })?.data ?? {} } catch { /* counts unknown */ }
        remove(q, batch)
        q.failures = 0
        q.notBefore = 0
        q.batchLimit = Math.min(limits.maxBatch, q.batchLimit * 2)
        if (result.rejected) {
          stats.droppedRejected += result.rejected
          log.warn(`[agent-events] ${label(q)}: the server refused ${result.rejected} event(s) as invalid`)
        }
        log.log(`[agent-events] ${label(q)}: sent ${batch.length} (accepted ${result.accepted ?? '?'}, duplicates ${result.duplicates ?? '?'}); ${q.events.length} waiting`)
        return
      }
      if (status === 401) {
        q.authBlocked = true
        log.warn(`[agent-events] ${label(q)}: HTTP 401; kept until the next sign-in`)
        return
      }
      if (status === 404) {
        const error = await response!.json().then((b: { error?: unknown }) => b?.error, () => undefined)
        if (error === 'Company not found or access denied') {
          log.warn(`[agent-events] ${label(q)}: no longer a member; dropped ${q.events.length} event(s)`)
          dropQueue(q)
          return
        }
        // An older server without the route: keep, retry later.
        backoff(q, limits.maxBackoffMs)
        log.warn(`[agent-events] ${label(q)}: HTTP 404 (server without the AI action log?); retrying later`)
        return
      }
      if (status === 400 || status === 413) {
        if (batch.length > 1) {
          q.batchLimit = Math.max(1, Math.floor(batch.length / 2))
          log.warn(`[agent-events] ${label(q)}: HTTP ${status} for ${batch.length}; sending ${q.batchLimit} at a time`)
        } else {
          stats.droppedRejected++
          remove(q, batch)
          log.warn(`[agent-events] ${label(q)}: HTTP ${status} for a single event; dropped it`)
        }
        return
      }
      if (status === 429) {
        const wait = retryAfterMs(response!.headers.get('Retry-After'), clock.now()) ?? limits.defaultRetryAfterMs
        q.notBefore = clock.now() + wait
        log.warn(`[agent-events] ${label(q)}: HTTP 429; retrying in ${Math.round(wait / 1000)} s`)
        return
      }
      backoff(q)
      log.warn(`[agent-events] ${label(q)}: ${status ? `HTTP ${status}` : 'server not reachable'}; retrying in ${Math.round((q.notBefore - clock.now()) / 1000)} s`)
    })().finally(() => {
      q.sending = null
      if (!q.removed) scheduleSend(q)
    })
  }

  function ownerOf(event: AgentToolEvent): string | null {
    const current = deps.userId()
    if (!event.turnId) return current
    const owner = turnOwners.get(event.turnId)
    // '' = the turn first reported while nobody was signed in: none of it is filed.
    if (owner !== undefined) return owner || null
    turnOwners.set(event.turnId, current ?? '')
    if (turnOwners.size > 500) turnOwners.delete(turnOwners.keys().next().value as string)
    return current
  }

  async function scanUser(userId: string): Promise<void> {
    let names: string[] = []
    try { names = await fs.promises.readdir(userDir(userId)) } catch { return }
    for (const name of names) {
      const match = /^(.+)\.jsonl(?:\.quit)?$/.exec(name)
      if (!match) continue
      let companyId: string
      try { companyId = decodeURIComponent(match[1]) } catch { continue }
      if (safeSegment(companyId) !== match[1]) continue
      scheduleSend(queueFor(userId, companyId))
    }
  }

  return {
    add(event) {
      try {
        if (closed) return
        const userId = ownerOf(event)
        const companyId = event.companyId
        if (!userId || !companyId) {
          stats.droppedNoAccount++
          if (!warnedNoAccount) { warnedNoAccount = true; log.warn('[agent-events] an event with no signed-in account or company was not sent (further ones are counted silently)') }
          return
        }
        const q = queueFor(userId, companyId)
        const line = JSON.stringify({ t: clock.now(), e: event })
        const entry: Entry = { t: clock.now(), e: event, line, bytes: Buffer.byteLength(line) + 1 }
        q.events.push(entry)
        q.unwritten.push(entry)
        q.bytes += entry.bytes
        enforceCaps(q)
        scheduleWrite(q)
        scheduleSend(q)
      } catch (error) {
        log.warn(`[agent-events] queueing failed: ${error instanceof Error ? error.name : 'error'}`)
      }
    },

    sessionStarted() {
      const userId = deps.userId()
      if (!userId || closed) return
      for (const q of queues.values()) {
        if (q.userId !== userId) continue
        q.authBlocked = false
        q.notBefore = 0
        q.failures = 0
        scheduleSend(q, 0)
      }
      if (!scannedUsers.has(userId)) {
        scannedUsers.add(userId)
        track(scanUser(userId))
      }
    },

    turnEnded() {
      const userId = deps.userId()
      if (!userId || closed) return
      for (const q of queues.values()) if (q.userId === userId) scheduleSend(q, limits.turnEndDelayMs)
    },

    signedOut() {
      for (const q of queues.values()) {
        if (q.sendTimer !== undefined) { clock.clearTimeout(q.sendTimer); q.sendTimer = undefined }
      }
    },

    flushSync() {
      if (closed) return
      closed = true
      for (const q of queues.values()) {
        if (q.writeTimer !== undefined) clock.clearTimeout(q.writeTimer)
        if (q.sendTimer !== undefined) clock.clearTimeout(q.sendTimer)
        if (!q.rewrite && q.unwritten.length === 0) continue
        try {
          fs.mkdirSync(path.dirname(q.file), { recursive: true, mode: 0o700 })
          const text = (entries: Entry[]) => entries.map(entry => entry.line + '\n').join('')
          if (q.writing || !q.loaded) {
            // An asynchronous read or write may still land on the queue file:
            // the whole queue goes to a side file, the next start merges both.
            fs.writeFileSync(q.file + SIDE_FILE, text(q.events), { mode: 0o600 })
          } else if (q.rewrite) {
            if (q.events.length === 0) fs.rmSync(q.file, { force: true })
            else {
              fs.writeFileSync(`${q.file}.tmp`, text(q.events), { mode: 0o600 })
              fs.renameSync(`${q.file}.tmp`, q.file)
            }
          } else {
            fs.appendFileSync(q.file, text(q.unwritten), { mode: 0o600 })
          }
          q.unwritten = []
          q.rewrite = false
        } catch (error) {
          log.warn(`[agent-events] ${label(q)}: could not save at quit (${(error as NodeJS.ErrnoException).code ?? 'error'})`)
        }
      }
      if (stats.droppedNoAccount > 0) log.log(`[agent-events] ${stats.droppedNoAccount} event(s) had no signed-in account or company and were not sent`)
    },

    async whenIdle() {
      for (let i = 0; i < 20; i++) {
        const busy = [...queues.values()].flatMap(q => [q.chain, q.sending].filter(Boolean)) as Promise<unknown>[]
        await Promise.all([...busy, ...background])
        await new Promise(resolve => setImmediate(resolve))
        if (background.size === 0 && [...queues.values()].every(q => !q.sending && !q.writing)) return
      }
    },

    pending() {
      const out: Record<string, number> = {}
      for (const q of queues.values()) out[`${q.userId}/${q.companyId}`] = q.events.length
      return out
    },

    stats: () => ({ ...stats }),
  }
}
