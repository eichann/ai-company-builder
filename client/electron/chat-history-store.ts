import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatSession, ChatSaveResult, ChatMetadataPatch, ChatSessionSummary } from '../shared/chat-history'
import { normalizeSearchText, summarizeSession } from '../shared/chat-history-summary'
import { isAgentId } from '../shared/agents/registry'
import { RECORD_ID_RE } from '../../shared/core/records'

interface HistoryFile {
  sessions: ChatSession[]
  deletedSessionIds?: string[]
}

function validId(id: string): void {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) {
    throw new Error('相談の識別子が不正です。')
  }
}

function validateSession(s: ChatSession, companyId: string): void {
  if (!s || typeof s !== 'object') throw new Error('相談データの形式が不正です。')
  validId(s.id)
  if (s.companyId !== companyId || typeof s.title !== 'string' ||
      !Array.isArray(s.messages) || !Number.isFinite(Date.parse(s.createdAt)) ||
      !Number.isFinite(Date.parse(s.updatedAt)) ||
      (s.writeSequence !== undefined && (!Number.isSafeInteger(s.writeSequence) || s.writeSequence < 0)) ||
      (s.writerId !== undefined && typeof s.writerId !== 'string') ||
      (s.revision !== undefined && (!Number.isSafeInteger(s.revision) || s.revision < 0))) {
    throw new Error('相談データの形式が不正です。元のファイルは変更していません。')
  }
  const ids = new Set<string>()
  for (const m of s.messages) {
    if (!m || typeof m.id !== 'string' || ids.has(m.id) ||
        !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' ||
        !Number.isFinite(Date.parse(m.timestamp))) {
      throw new Error('相談のメッセージを読み取れません。元のファイルは変更していません。')
    }
    ids.add(m.id)
  }
}

// Flush the replacement before renaming. Never truncate the only valid copy.
export function atomicWrite(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600)
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(temporary, file)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

/** Writes and flushes a new temporary file next to `file` (the slow part, off the main thread). */
async function writeTemporary(file: string, data: string): Promise<string> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await fs.promises.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
    return temporary
  } catch (error) {
    await fs.promises.rm(temporary, { force: true })
    throw error
  }
}

function writeTemporarySync(file: string, data: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600)
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    return temporary
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    throw error
  }
}

/**
 * Makes `${file}.bak` the current (previous) version of `file` without reading
 * it: a hard link to the same inode — the next rename gives `file` a new inode
 * and leaves the old one as the backup — or a copy where links are refused.
 */
function preserveBackupSync(file: string): void {
  if (!fs.existsSync(file)) return
  const temporary = `${file}.bak.${randomUUID()}.tmp`
  try {
    try { fs.linkSync(file, temporary) } catch { fs.copyFileSync(file, temporary, fs.constants.COPYFILE_FICLONE) }
    fs.renameSync(temporary, `${file}.bak`)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function diskStamp(file: string): string | null {
  try {
    const stat = fs.statSync(file)
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const READ_ERROR = '相談履歴を読み取れません。履歴を保護するため保存を停止しました。バックアップからの復旧が必要です。'

/** One company's history, as the store holds it in memory. */
interface Entry {
  data: HistoryFile
  /** Top-level keys this version does not know, written back unchanged. */
  extra: Record<string, unknown>
  byId: Map<string, ChatSession>
  deleted: Set<string>
  /** Identity of the file on disk that `data` matches (null: no file). */
  stamp: string | null
  /** Memory is ahead of the disk. */
  dirty: boolean
  /** A deletion is waiting: the next write also replaces `.bak` with the new content. */
  sanitize: boolean
  /** Every write takes a number; a write commits only if no later one already has. */
  sequence: number
  committed: number
  writing: Promise<void> | null
  timer: ReturnType<typeof setTimeout> | null
  writeError: Error | null
}

export interface ChatHistoryStoreOptions {
  /** Coalescing window for writes after a save / patch (default 250 ms). */
  writeDelayMs?: number
  /** Retry delay after a failed write (default 5 s). */
  retryDelayMs?: number
}

// Serialised form of each session, keyed by the (never mutated) session object:
// a write re-serialises only the sessions that changed since the last one.
const sessionJson = new WeakMap<ChatSession, string>()
const sessionSummary = new WeakMap<ChatSession, ChatSessionSummary>()
const sessionSearchText = new WeakMap<ChatSession, string>()

function serializedSession(session: ChatSession): string {
  let json = sessionJson.get(session)
  if (json === undefined) { json = JSON.stringify(session); sessionJson.set(session, json) }
  return json
}

function sortSessions<T extends { pinned?: boolean; updatedAt: string }>(sessions: T[]): T[] {
  return sessions.sort((a, b) =>
    Number(!!b.pinned) - Number(!!a.pinned) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

/**
 * Main-process-owned store.
 *
 * Every operation is synchronous against an in-memory copy of the company's
 * history (loaded once, reloaded when the file's identity — inode, size,
 * mtime — changes underneath while nothing is pending), so read/modify/write
 * cannot interleave and reads never touch the disk. Writes are coalesced and
 * done off the main thread: the new file is written and fsynced as a
 * temporary file, then — on the main thread, in order — the current file
 * becomes `.bak` (hard link, no re-read) and the temporary file is renamed
 * over it. The file on disk is always a complete version; the format is the
 * same JSON as before (compact), so older app versions read it.
 *
 * Callers must not mutate returned sessions: the store replaces session
 * objects, it never edits them in place.
 */
export class ChatHistoryStore {
  private entries = new Map<string, Entry>()
  private failures = new Map<string, { stamp: string | null; error: Error }>()
  private writeDelayMs: number
  private retryDelayMs: number

  constructor(private directory: string, options: ChatHistoryStoreOptions = {}) {
    this.writeDelayMs = options.writeDelayMs ?? 250
    this.retryDelayMs = options.retryDelayMs ?? 5_000
  }

  private file(companyId: string): string {
    validId(companyId)
    return path.join(this.directory, `${companyId}.json`)
  }

  private load(companyId: string): Entry {
    const file = this.file(companyId)
    const cached = this.entries.get(companyId)
    // Pending changes make memory authoritative.
    if (cached && (cached.dirty || cached.writing)) return cached
    const stamp = diskStamp(file)
    if (cached && cached.stamp === stamp) return cached
    const failed = this.failures.get(companyId)
    if (failed && failed.stamp === stamp) throw failed.error
    let data: HistoryFile
    let extra: Record<string, unknown> = {}
    try {
      if (stamp === null) data = { sessions: [], deletedSessionIds: [] }
      else {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (!parsed || !Array.isArray(parsed.sessions) ||
            (parsed.deletedSessionIds !== undefined && !Array.isArray(parsed.deletedSessionIds))) throw new Error('schema')
        const { sessions, deletedSessionIds, ...rest } = parsed as HistoryFile & Record<string, unknown>
        data = { sessions, deletedSessionIds }
        extra = rest
        const ids = new Set<string>()
        for (const s of data.sessions) {
          validateSession(s, companyId)
          if (ids.has(s.id)) throw new Error('duplicate session id')
          ids.add(s.id)
        }
        for (const id of data.deletedSessionIds ?? []) validId(id)
      }
    } catch {
      const error = new Error(READ_ERROR)
      this.failures.set(companyId, { stamp, error })
      throw error
    }
    this.failures.delete(companyId)
    if (!cached) this.removeLeftoverTemporaries(file)
    const entry: Entry = {
      data, extra,
      byId: new Map(data.sessions.map(s => [s.id, s])),
      deleted: new Set(data.deletedSessionIds ?? []),
      stamp, dirty: false, sanitize: false,
      sequence: cached?.sequence ?? 0, committed: cached?.committed ?? 0,
      writing: null, timer: null, writeError: null,
    }
    // Times an earlier version stamped by re-saving are put back once, and written with the next save.
    const repaired = repairedUpdateTimes(data.sessions)
    for (const s of repaired) {
      const index = data.sessions.findIndex(x => x.id === s.id)
      data.sessions[index] = s
      entry.byId.set(s.id, s)
    }
    this.entries.set(companyId, entry)
    if (repaired.length > 0) this.schedule(companyId, entry)
    return entry
  }

  /** Temporary files a killed process left behind (never a complete version on their own). */
  private removeLeftoverTemporaries(file: string): void {
    try {
      const base = path.basename(file)
      for (const name of fs.readdirSync(path.dirname(file))) {
        if (name.startsWith(`${base}.`) && name.endsWith('.tmp')) fs.rmSync(path.join(path.dirname(file), name), { force: true })
      }
    } catch { /* best effort */ }
  }

  private serialize(entry: Entry): string {
    const tail = JSON.stringify({ ...entry.extra, deletedSessionIds: entry.data.deletedSessionIds ?? [] })
    return `{"sessions":[${entry.data.sessions.map(serializedSession).join(',')}],${tail.slice(1)}`
  }

  /** Last step of every write, always on the main thread: backup, then replace. */
  private commit(file: string, entry: Entry, sequence: number, temporary: string, backup: string | null): void {
    if (entry.committed > sequence) {
      // A later version is already on disk (a synchronous flush overtook this write).
      fs.rmSync(temporary, { force: true })
      if (backup) fs.rmSync(backup, { force: true })
      return
    }
    if (backup) fs.renameSync(backup, `${file}.bak`)
    else preserveBackupSync(file)
    fs.renameSync(temporary, file)
    entry.committed = sequence
    entry.stamp = diskStamp(file)
  }

  private schedule(companyId: string, entry: Entry, delay = this.writeDelayMs): void {
    entry.dirty = true
    if (entry.writing) return // its completion schedules the next write
    if (entry.timer) {
      if (delay > 0) return
      clearTimeout(entry.timer)
    }
    entry.timer = setTimeout(() => { entry.timer = null; this.startWrite(companyId, entry) }, delay)
  }

  private startWrite(companyId: string, entry: Entry): void {
    if (entry.writing || !entry.dirty) return
    entry.writing = this.writeAsync(companyId, entry).finally(() => {
      entry.writing = null
      if (entry.dirty && !entry.timer) this.schedule(companyId, entry, entry.writeError ? this.retryDelayMs : this.writeDelayMs)
    })
  }

  private async writeAsync(companyId: string, entry: Entry): Promise<void> {
    const file = this.file(companyId)
    const sequence = ++entry.sequence
    const json = this.serialize(entry)
    const sanitize = entry.sanitize
    entry.dirty = false
    entry.sanitize = false
    let temporary: string | null = null
    let backup: string | null = null
    try {
      temporary = await writeTemporary(file, json)
      // A deletion's backup must not keep the deleted conversation.
      if (sanitize) backup = await writeTemporary(`${file}.bak`, json)
      this.commit(file, entry, sequence, temporary, backup)
      entry.writeError = null
    } catch (error) {
      if (temporary) fs.rmSync(temporary, { force: true })
      if (backup) fs.rmSync(backup, { force: true })
      if (entry.committed < sequence) {
        entry.dirty = true
        entry.sanitize ||= sanitize
        entry.writeError = error instanceof Error ? error : new Error(String(error))
        console.error('[chat-history] Write failed; retrying:', entry.writeError.message)
      }
    }
  }

  private writeSync(companyId: string, entry: Entry): void {
    // An asynchronous write still in flight is overtaken (its commit is then discarded).
    if (!entry.dirty && !entry.writing) return
    const file = this.file(companyId)
    const sequence = ++entry.sequence
    const json = this.serialize(entry)
    const temporary = writeTemporarySync(file, json)
    let backup: string | null = null
    try {
      if (entry.sanitize) backup = writeTemporarySync(`${file}.bak`, json)
      this.commit(file, entry, sequence, temporary, backup)
    } catch (error) {
      fs.rmSync(temporary, { force: true })
      if (backup) fs.rmSync(backup, { force: true })
      throw error
    }
    entry.dirty = false
    entry.sanitize = false
    entry.writeError = null
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
  }

  /** Before a change: a store whose last write failed tries again now and reports the failure. */
  private writable(companyId: string): Entry {
    const entry = this.load(companyId)
    if (entry.writeError) this.writeSync(companyId, entry)
    return entry
  }

  /** Waits until everything changed so far is on disk (tests, shutdown). */
  async flush(): Promise<void> {
    for (;;) {
      const pending = [...this.entries.entries()].filter(([, e]) => e.dirty || e.writing)
      if (!pending.length) return
      for (const [companyId, entry] of pending) {
        if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
        if (!entry.writing) this.startWrite(companyId, entry)
      }
      await Promise.all(pending.map(([, e]) => e.writing))
      if (pending.some(([, e]) => e.writeError && e.dirty)) throw pending.find(([, e]) => e.writeError)![1].writeError
    }
  }

  /** Writes everything pending now, on the calling thread (app quit). */
  flushSync(): void {
    for (const [companyId, entry] of this.entries) {
      try { this.writeSync(companyId, entry) }
      catch (error) { console.error('[chat-history] Final write failed:', error instanceof Error ? error.message : error) }
    }
  }

  list(companyId: string): ChatSession[] {
    const entry = this.load(companyId)
    return sortSessions(entry.data.sessions.filter(s => !entry.deleted.has(s.id)))
  }

  /** The session list without message bodies (sidebar, tabs). */
  summaries(companyId: string): ChatSessionSummary[] {
    return this.list(companyId).map(session => {
      let summary = sessionSummary.get(session)
      if (!summary) { summary = summarizeSession(session); sessionSummary.set(session, summary) }
      return summary
    })
  }

  /** Ids of the sessions whose title, draft or any message contains `query` (NFKC, case-insensitive). */
  search(companyId: string, query: string): string[] {
    const needle = normalizeSearchText(String(query ?? '').trim())
    if (!needle) return []
    return this.list(companyId).filter(session => {
      let text = sessionSearchText.get(session)
      if (text === undefined) {
        // The app's instruction to the AI is not the member's words (app-instruction.ts): not searched.
        text = normalizeSearchText([session.title, session.draftInput ?? '', ...session.messages.map(m => m.appInstruction ? '' : m.content)].join('\u0000'))
        sessionSearchText.set(session, text)
      }
      return text.includes(needle)
    }).map(session => session.id)
  }

  get(companyId: string, sessionId: string): ChatSession | null {
    validId(sessionId)
    const entry = this.load(companyId)
    if (entry.deleted.has(sessionId)) return null
    return entry.byId.get(sessionId) ?? null
  }

  private replace(entry: Entry, session: ChatSession): void {
    const index = entry.data.sessions.findIndex(s => s.id === session.id)
    if (index >= 0) entry.data.sessions[index] = session
    else entry.data.sessions.push(session)
    entry.byId.set(session.id, session)
  }

  save(companyId: string, incoming: ChatSession): ChatSaveResult {
    validateSession(incoming, companyId)
    const entry = this.writable(companyId)
    if (entry.deleted.has(incoming.id)) return { status: 'deleted' }
    const existing = entry.byId.get(incoming.id)
    const sameWriter = !!incoming.writerId && incoming.writerId === existing?.writerId
    if (existing && ((sameWriter && (incoming.writeSequence ?? 0) <= (existing.writeSequence ?? 0)) ||
        (!sameWriter && (incoming.revision ?? 0) !== (existing.revision ?? 0)))) {
      return { status: 'conflict', session: existing }
    }
    const session: ChatSession = {
      ...incoming,
      // Metadata is edited through patch(), not a stale full-conversation snapshot.
      ...(existing ? {
        title: existing.titleAutoGenerated !== undefined ? existing.title : incoming.title,
        titleAutoGenerated: existing.titleAutoGenerated,
        pinned: existing.pinned,
        pinnedAt: existing.pinnedAt,
        createdAt: existing.createdAt,
        claudeSessionId: existing.claudeSessionId || incoming.claudeSessionId,
        agentSession: existing.agentSession !== undefined ? existing.agentSession : incoming.agentSession,
        // The topic set or taken off by patch() stays; a save only brings the first one (「相談する」).
        topicRecordId: existing.topicDetached ? undefined : existing.topicRecordId ?? incoming.topicRecordId,
        topicDetached: existing.topicDetached,
      } : {}),
      revision: (existing?.revision ?? 0) + 1,
      // 「更新」 is when the conversation itself changed (a message or the draft): a save of the same
      // words in another shape (a newer app's fields, a restore) keeps the time and the list's order.
      updatedAt: existing && (existing.draftInput ?? '') === (incoming.draftInput ?? '') &&
        sameConversation(existing.messages, incoming.messages)
        ? existing.updatedAt : new Date().toISOString(),
    }
    this.replace(entry, session)
    this.schedule(companyId, entry)
    return { status: 'saved', session }
  }

  patch(companyId: string, sessionId: string, patch: ChatMetadataPatch): ChatSession | null {
    validId(sessionId)
    const entry = this.writable(companyId)
    if (entry.deleted.has(sessionId)) return null
    const existing = entry.byId.get(sessionId)
    if (!existing) return null
    const session: ChatSession = { ...existing }
    if (patch.title !== undefined) {
      if (typeof patch.title !== 'string' || !patch.title.trim()) throw new Error('相談名が空です。')
      // Late AI title jobs never overwrite an explicit user rename.
      if (!(patch.titleAutoGenerated === true && session.titleAutoGenerated === false)) {
        session.title = patch.title.trim()
        session.titleAutoGenerated = patch.titleAutoGenerated ?? false
      }
    }
    if (typeof patch.pinned === 'boolean') {
      session.pinned = patch.pinned
      session.pinnedAt = patch.pinned ? new Date().toISOString() : undefined
    }
    if (patch.agentSession !== undefined) {
      if (patch.agentSession !== null && (!isAgentId(patch.agentSession.providerId) || typeof patch.agentSession.id !== 'string' || !patch.agentSession.id)) throw new Error('不正なAIセッションです。')
      session.agentSession = patch.agentSession
    }
    if (typeof patch.claudeSessionId === 'string') session.claudeSessionId = patch.claudeSessionId
    if (patch.topicRecordId === null) {
      delete session.topicRecordId
      session.topicDetached = true
    } else if (patch.topicRecordId !== undefined) {
      if (typeof patch.topicRecordId !== 'string' || !RECORD_ID_RE.test(patch.topicRecordId)) throw new Error('不正な記録です。')
      session.topicRecordId = patch.topicRecordId
    }
    this.replace(entry, session)
    this.schedule(companyId, entry)
    return session
  }

  delete(companyId: string, sessionId: string): void {
    validId(sessionId)
    const entry = this.writable(companyId)
    entry.data.sessions = entry.data.sessions.filter(s => s.id !== sessionId)
    entry.byId.delete(sessionId)
    entry.deleted.add(sessionId)
    entry.data.deletedSessionIds = [...entry.deleted]
    entry.sanitize = true
    // No coalescing window: the deleted conversation leaves the disk (and the backup) right away.
    this.schedule(companyId, entry, 0)
  }
}

/** Same messages as before (the autosave sends the whole conversation each time). */
/** The same messages, by what was said (id, who, words), whatever other fields a version stores with them. */
function sameConversation(a: ChatSession['messages'], b: ChatSession['messages']): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].content !== b[i].content || a[i].id !== b[i].id || a[i].role !== b[i].role) return false
  }
  return true
}

/** How far after its last message a conversation without a draft may have been saved (a long reply). */
const REPAIR_SLACK_MS = 15 * 60_000

/**
 * The time an earlier version stamped on conversations it only re-saved (2026-11-02: every
 * conversation showed the time the new app first opened). With no draft, a conversation changes only
 * by its messages, so a time well after its last message is put back to that message's time.
 * Answers the sessions to replace (none when nothing needs it).
 */
export function repairedUpdateTimes(sessions: readonly ChatSession[]): ChatSession[] {
  const out: ChatSession[] = []
  for (const s of sessions) {
    if (s.draftInput?.trim()) continue
    const last = s.messages.reduce((t, m) => Math.max(t, Date.parse(m.timestamp) || 0), Date.parse(s.createdAt) || 0)
    const at = Date.parse(s.updatedAt)
    if (last > 0 && at - last > REPAIR_SLACK_MS) out.push({ ...s, updatedAt: new Date(last).toISOString() })
  }
  return out
}
