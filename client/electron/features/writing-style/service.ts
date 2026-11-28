// 「返事の下書きを、わたしの書き方に合わせる」 on this PC (owner decision 2026-11-28; rules shared/core/writing-style.ts,
// words and shapes client/shared/writing-style.ts). The server hands the member's own newest sent messages (read now with
// their own permission, kept nowhere); this module has their own AI summarize them — one tool-less one-shot per audience —
// and keeps **only the summaries**, here, per account and company:
//   <dir>/<userId>/<companyId>.json   { version: 1, enabled, styles: { <connectorId>: { inside?, outside? } }, note }
// (owner-only, written atomically). Never sent anywhere, never logged (only counts and fixed words), never handed to anyone
// but this member's own AI, and only for a reply it drafts (`forThread`). Another account or company reads another file.
// It knows no tool: connectors are the ids the server answered.
import fs from 'fs'
import path from 'path'
import { atomicWrite } from '../../chat-history-store'
import {
  audiencesToSummarize, chooseWritingStyle, isWritingAudience, isWritingConnectorId, parseWritingStyle, parseWritingStyleSet,
  writingStyleStale, WRITING_AUDIENCES, type WritingAudience, type WritingSample, type WritingStyle, type WritingStyleSet,
} from '../../../../shared/core/writing-style'
import type { WritingSamplesView, WritingSourcesView, WritingStyleKey } from '../../../../shared/types/writing-style'
import { writingStyleForAi, type WritingStyleStatus } from '../../../shared/writing-style'

/** Ids that go into a file name or the server URL: no separators, dots or encoded characters. */
const ID = /^[A-Za-z0-9_-]{1,100}$/

export interface KeptFile {
  version: 1
  enabled: boolean
  styles: WritingStyleSet
  note: string | null
}

/** The server's answers, read with the member's session (null = not reached). */
export interface WritingSourcesPort {
  sources(companyId: string): Promise<WritingSourcesView | null>
  /** `ok: false` with the server's status (409: not readable now). */
  samples(companyId: string, connectorId: string): Promise<{ ok: true; value: WritingSamplesView } | { ok: false; status: number } | null>
}

export interface WritingStylesDeps {
  /** The folder holding every account's files (<userData>/writing-style). */
  dir: () => string
  /** The signed-in member (services/session.ts); null = nobody: nothing read or written. */
  userId: () => string | null
  server: WritingSourcesPort
  /** The member's own AI, one tool-less call: the summary of one audience's messages, or null. */
  summarize: (samples: readonly WritingSample[], signal: AbortSignal) => Promise<WritingStyle | null>
  /**
   * Which sign-in this is (services/session.ts' cookies: a new array at every sign-in): a build or a turn started under
   * one sign-in never reads or writes under another, also the same account signed in again (A → B → A).
   */
  session?: () => unknown
  /** False while an administrator has stopped the AI (agent-stop.md): nothing is summarized. */
  aiAllowed?: () => boolean
  now?: () => number
  log?: Pick<Console, 'info' | 'warn'>
}

const NOTE = {
  made: '書き方のまとめを作りました。',
  fewMessages: '送ったメッセージが少ないため、まとめを作れなかったものがあります。',
  noSource: '送ったメッセージを読める許可がありません（仕事の道具の「受信を読む」の許可が要ります）。',
  aiStopped: '管理者が AI を止めているため、まとめを作れませんでした。',
  aiFailed: 'AI がまとめを作れませんでした。あとでもう一度試してください。',
  offline: 'サーバーにつながらないため、まとめを作れませんでした。',
} as const

/** A stale summary is made again from a thread read at most this often. */
export const REFRESH_RETRY_MS = 6 * 60 * 60 * 1000

const empty = (): KeptFile => ({ version: 1, enabled: false, styles: {}, note: null })

export function createWritingStyles(deps: WritingStylesDeps) {
  const now = deps.now ?? (() => Date.now())
  const log = deps.log ?? console
  /** Bumped by 「消す」: a build started before it saves nothing (its summaries would come back). */
  const generation = new Map<string, number>()
  /** When a stale summary's making was last started from a thread read, per account and company (memory only). */
  const refreshTried = new Map<string, number>()
  /** Builds running, per account and company: one at a time (`full`: every summary, else only the missing or stale). */
  const building = new Map<string, { job: Promise<void>; generation: number; full: boolean }>()
  /** Still the sign-in a piece of work started under. */
  const sameSignIn = (userId: string, session: unknown) => deps.userId() === userId && (deps.session?.() ?? null) === session

  const fileOf = (userId: string, companyId: string): string | null =>
    ID.test(userId) && ID.test(companyId) ? path.join(deps.dir(), userId, `${companyId}.json`) : null

  function read(userId: string, companyId: string): KeptFile {
    const file = fileOf(userId, companyId)
    if (!file) return empty()
    let raw: unknown
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return empty() }
    if (!raw || typeof raw !== 'object') return empty()
    const r = raw as Record<string, unknown>
    return { version: 1, enabled: r.enabled === true, styles: parseWritingStyleSet(r.styles), note: typeof r.note === 'string' ? r.note.slice(0, 200) : null }
  }

  function write(userId: string, companyId: string, kept: KeptFile): void {
    const file = fileOf(userId, companyId)
    if (!file) return
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    atomicWrite(file, JSON.stringify(kept))
  }

  /**
   * Make every summary again from the member's newest sent messages (`full`), or only the ones missing or older than a
   * month (a thread read: a fresh summary is never made twice). Only connectors readable now keep a summary; an
   * audience with too few messages has none. Written only when the same account is still signed in.
   */
  async function build(userId: string, companyId: string, full = true): Promise<void> {
    const key = `${userId}\u0000${companyId}`
    const running = building.get(key)
    const startedAt = generation.get(key) ?? 0
    if (running) {
      // One started before a 「消す」 saves nothing, and one making only the missing ones is not 「作り直す」: this one runs after it.
      return running.generation === startedAt && (running.full || !full) ? running.job : running.job.then(() => build(userId, companyId, full))
    }
    const session = deps.session?.() ?? null
    const current = () => (generation.get(key) ?? 0) === startedAt && sameSignIn(userId, session)
    const job = (async () => {
      if (deps.aiAllowed?.() === false) { save(userId, companyId, k => ({ ...k, note: NOTE.aiStopped })); return }
      const sources = await deps.server.sources(companyId)
      if (!sources) { if (current()) save(userId, companyId, k => ({ ...k, note: NOTE.offline })); return }
      // A summary the member corrected by hand is theirs: never made again over it.
      const before = read(userId, companyId)
      const styles: WritingStyleSet = {}
      let few = false
      let failed = false
      let made = 0
      // Pairs whose making failed for a passing reason (offline, the server or the AI not answering): the kept one stays.
      const keepOld = new Set<string>()
      const controller = new AbortController()
      /** Kept and made within the month: a thread read's making leaves it as it is. */
      const fresh = (connectorId: string, a: WritingAudience) => {
        const k = before.styles[connectorId]?.[a]
        return !full && k !== undefined && !writingStyleStale(k, now())
      }
      for (const source of sources.sources) {
        if (!source.readable || !isWritingConnectorId(source.connectorId)) continue
        if (WRITING_AUDIENCES.every(a => fresh(source.connectorId, a))) {
          for (const a of WRITING_AUDIENCES) keepOld.add(`${source.connectorId}:${a}`)
          continue
        }
        const r = await deps.server.samples(companyId, source.connectorId)
        // 409 / 404: no longer readable or served — its summaries go. Anything else passes: they stay.
        if (!r || (!r.ok && r.status !== 409 && r.status !== 404)) {
          failed = true
          for (const a of WRITING_AUDIENCES) keepOld.add(`${source.connectorId}:${a}`)
          continue
        }
        if (!r.ok) continue
        const samples = r.value.samples
        const audiences = audiencesToSummarize(samples)
        if (audiences.length < WRITING_AUDIENCES.length) few = true
        for (const a of WRITING_AUDIENCES) if (fresh(source.connectorId, a)) keepOld.add(`${source.connectorId}:${a}`)
        for (const audience of audiences) {
          if (before.styles[source.connectorId]?.[audience]?.edited || fresh(source.connectorId, audience)) continue
          if (deps.aiAllowed?.() === false) { failed = true; keepOld.add(`${source.connectorId}:${audience}`); continue }
          const mine = samples.filter(s => s.audience === audience)
          let style: WritingStyle | null = null
          try { style = await deps.summarize(mine, controller.signal) } catch { style = null }
          if (!style) { failed = true; keepOld.add(`${source.connectorId}:${audience}`); continue }
          ;(styles[source.connectorId] ??= {})[audience] = { style, madeAt: new Date(now()).toISOString(), sampleCount: mine.length, edited: false }
          made++
        }
      }
      // Never under another account: a sign-in meanwhile drops what this build made.
      if (!current()) return
      const readable = sources.sources.some(s => s.readable)
      const note = !readable ? NOTE.noSource : failed && made === 0 ? NOTE.aiFailed : few ? NOTE.fewMessages : NOTE.made
      save(userId, companyId, k => {
        // A summary the member edited by hand stays while its connector is still readable.
        const next: WritingStyleSet = {}
        for (const s of sources.sources) {
          if (!s.readable || !isWritingConnectorId(s.connectorId)) continue
          for (const a of WRITING_AUDIENCES) {
            const old = k.styles[s.connectorId]?.[a]
            const fresh = styles[s.connectorId]?.[a]
            const pick = old?.edited ? old : fresh ?? (keepOld.has(`${s.connectorId}:${a}`) ? old : undefined)
            if (pick) (next[s.connectorId] ??= {})[a] = pick
          }
        }
        return { ...k, styles: next, note }
      })
      log.info(`[writing-style] made ${made} summaries`)
    })().catch(() => { log.warn('[writing-style] making the summaries failed') })
      .finally(() => building.delete(key))
    building.set(key, { job, generation: startedAt, full })
    return job
  }

  function save(userId: string, companyId: string, change: (k: KeptFile) => KeptFile): void {
    if (deps.userId() !== userId) return
    try { write(userId, companyId, change(read(userId, companyId))) } catch { log.warn('[writing-style] the summaries could not be saved') }
  }

  async function status(companyId: string): Promise<WritingStyleStatus | null> {
    const userId = deps.userId()
    if (!userId || !ID.test(companyId)) return null
    const session = deps.session?.() ?? null
    const sources = await deps.server.sources(companyId)
    // Another sign-in meanwhile: never this one's summaries.
    if (!sources || !sameSignIn(userId, session)) return null
    const kept = read(userId, companyId)
    const labelOf = (id: string) => sources.sources.find(s => s.connectorId === id)?.label ?? id
    return {
      available: sources.sources.some(s => s.readable),
      enabled: kept.enabled,
      building: building.has(`${userId}\u0000${companyId}`),
      sources: sources.sources,
      styles: Object.entries(kept.styles).flatMap(([connectorId, by]) =>
        WRITING_AUDIENCES.filter(a => by[a]).map(audience => ({ connectorId, label: labelOf(connectorId), audience, kept: by[audience]! }))),
      note: kept.note,
    }
  }

  return {
    status,

    /** The check: on makes the summaries (in the background), off keeps them but hands them to nobody. */
    async setEnabled(companyId: string, on: boolean): Promise<WritingStyleStatus | null> {
      const userId = deps.userId()
      if (!userId || !ID.test(companyId)) return null
      save(userId, companyId, k => ({ ...k, enabled: on }))
      if (on) void build(userId, companyId)
      return status(companyId)
    },

    /** 「作り直す」. */
    async rebuild(companyId: string): Promise<WritingStyleStatus | null> {
      const userId = deps.userId()
      if (!userId || !ID.test(companyId)) return null
      void build(userId, companyId)
      return status(companyId)
    },

    /** The member's own correction of one summary (checked like the AI's: nothing personal is kept). */
    async update(companyId: string, connectorId: unknown, audience: unknown, raw: unknown): Promise<WritingStyleStatus | null | 'bad'> {
      const userId = deps.userId()
      if (!userId || !ID.test(companyId) || !isWritingConnectorId(connectorId) || !isWritingAudience(audience)) return 'bad'
      const style = parseWritingStyle(raw)
      if (!style) return 'bad'
      const kept = read(userId, companyId)
      const old = kept.styles[connectorId]?.[audience]
      if (!old) return 'bad'
      save(userId, companyId, k => ({ ...k, styles: { ...k.styles, [connectorId]: { ...k.styles[connectorId], [audience]: { ...old, style, edited: true } } } }))
      return status(companyId)
    },

    /** 「消す」: one summary, or every one (and the check off) when none is named. */
    async remove(companyId: string, connectorId?: unknown, audience?: unknown): Promise<WritingStyleStatus | null | 'bad'> {
      const userId = deps.userId()
      if (!userId || !ID.test(companyId)) return 'bad'
      // A build still running would bring back what is removed now.
      const key = `${userId}\u0000${companyId}`
      generation.set(key, (generation.get(key) ?? 0) + 1)
      if (connectorId === undefined) {
        const file = fileOf(userId, companyId)
        try { if (file) fs.rmSync(file, { force: true }) } catch { log.warn('[writing-style] the summaries could not be removed') }
        return status(companyId)
      }
      if (!isWritingConnectorId(connectorId) || !isWritingAudience(audience)) return 'bad'
      save(userId, companyId, k => {
        const by = { ...k.styles[connectorId] }
        delete by[audience as WritingAudience]
        const styles = { ...k.styles, [connectorId]: by }
        if (Object.keys(by).length === 0) delete styles[connectorId]
        return { ...k, styles }
      })
      return status(companyId)
    },

    /**
     * What the drafting AI of one turn is handed beside a thread it reads for a reply, bound to the sign-in the turn
     * started under (another sign-in since: nothing): the member's own summary for the thread's connector and audience
     * (or the other audience standing in), only while the check is on. A month-old one, or none yet for the thread's
     * connector (a tool connected or allowed after the check was turned on), is made in the background (only those; at
     * most every `REFRESH_RETRY_MS`); this answer uses what is kept.
     */
    forTurn(companyId: string): ((key: WritingStyleKey | null | undefined) => string | null) | null {
      const userId = deps.userId()
      if (!userId || !ID.test(companyId)) return null
      const session = deps.session?.() ?? null
      return key => {
        if (!sameSignIn(userId, session) || !key || !isWritingConnectorId(key.connectorId) || !isWritingAudience(key.audience)) return null
        const kept = read(userId, companyId)
        if (!kept.enabled) return null
        const tryKey = `${userId}\u0000${companyId}`
        const stale = Object.values(kept.styles).some(by => WRITING_AUDIENCES.some(a => by[a] && writingStyleStale(by[a]!, now())))
        const missing = !Object.prototype.hasOwnProperty.call(kept.styles, key.connectorId)
        if ((stale || missing) && now() - (refreshTried.get(tryKey) ?? -Infinity) >= REFRESH_RETRY_MS) {
          // Tried at most every few hours: a making that keeps failing (or too few messages) never costs a read per thread.
          refreshTried.set(tryKey, now())
          void build(userId, companyId, false)
        }
        const choice = chooseWritingStyle(kept.styles, key.connectorId, key.audience)
        return choice ? writingStyleForAi(choice) : null
      }
    },

    /** Tests: wait for a build started by `setEnabled` / `rebuild` / `forThread`. */
    whenIdle: async () => { while (building.size > 0) await Promise.all([...building.values()].map(b => b.job)) },
  }
}

export type WritingStyles = ReturnType<typeof createWritingStyles>

/** The server's two routes, with the member's session (the session stays in main). */
export function createWritingSourcesApi(deps: { baseUrl: () => string; cookies: () => string[]; fetch?: typeof fetch; timeoutMs?: number; log?: Pick<Console, 'warn'> }): WritingSourcesPort {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console
  async function get(companyId: string, rest: string): Promise<{ status: number; data: unknown } | null> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0 || !ID.test(companyId)) return null
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}/me/writing-sources${rest}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 60_000),
        headers: { Cookie: cookies.join('; ') },
      })
      const json = await res.json().catch(() => null) as { data?: unknown } | null
      return { status: res.status, data: json?.data }
    } catch {
      log.warn('[writing-style] the server could not be reached')
      return null
    }
  }
  return {
    async sources(companyId) {
      const r = await get(companyId, '')
      if (!r || r.status !== 200) return r && r.status === 404 ? { sources: [] } : null
      const list = (r.data as { sources?: unknown } | undefined)?.sources
      if (!Array.isArray(list)) return null
      return {
        sources: list.flatMap(s => {
          const x = s as Record<string, unknown>
          return isWritingConnectorId(x?.connectorId) && typeof x.label === 'string'
            ? [{ connectorId: x.connectorId, label: x.label.slice(0, 100), readable: x.readable === true }] : []
        }),
      }
    },
    async samples(companyId, connectorId) {
      if (!isWritingConnectorId(connectorId)) return { ok: false, status: 400 }
      const r = await get(companyId, `/${encodeURIComponent(connectorId)}/samples`)
      if (!r) return null
      if (r.status !== 200) return { ok: false, status: r.status }
      const list = (r.data as { samples?: unknown } | undefined)?.samples
      const samples = (Array.isArray(list) ? list : []).flatMap(s => {
        const x = s as Record<string, unknown>
        return typeof x?.text === 'string' && isWritingAudience(x.audience)
          ? [{ text: x.text.slice(0, 4000), at: typeof x.at === 'string' ? x.at : null, audience: x.audience }] : []
      })
      return { ok: true, value: { connectorId, samples } }
    },
  }
}
