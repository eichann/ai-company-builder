// What the app shows of records (milestone 5 U8, records.md "The app's views"), read with
// the member's session (it stays here):
//   recordViews:search   検索: records whose title or summary holds the words
//   recordViews:card     the read-only card a record opens in (fields, 経緯, つながっているもの);
//                        opening it also tells the server (POST …/opened), which keeps the first
//                        opening of the turn when the record waits for this member (records.md
//                        "Whose turn it was") — nothing is shown or kept here
//   recordViews:forFile  「つながっているもの」 of an open file
//   recordViews:topics   the やること / 案件 the member's AI consultations are about (title and kind
//                        only, for 「AIへの相談」); a plain read — never tells the server it was opened
//   recordViews:find     探す: records found by words, with department, mine, 案件 and summaries
//   recordViews:findHome 探す with nothing typed: the member's unfinished 案件, this week's meetings
// The server answers only what the member may read (counts included); nothing is added here.

import type { TypeDefinition } from '../../../../shared/core/record-types'
import type { LedgerEntry } from '../../../../shared/core/record-ledger'
import { fileLinkPath, RECORD_ID_RE } from '../../../../shared/core/records'
import type { RecordDetail, RecordFindHome, RecordFindResult, RecordQueryResult, RecordTypeView } from '../../../../shared/types/records'
import {
  cardFields, findHitView, historyEntries, historyLines, linkedPathOf, linkedPaths, RECORD_VIEWS_OFFLINE_TEXT, removableOf, summaryView,
  type FindHomeResult, type FindResult, type RecordCardLink, type RecordCardResult, type RecordCardView, type RecordListResult,
} from '../../../shared/record-views'
import { bundleDetailOf, DETAIL_FIELDS, recordDetailOf } from '../../../shared/record-details'
import type { AiRunView } from '../../../../shared/types/ai-runs'
import type { ViewersAnswer, ViewersLabel } from '../../../../shared/types/viewers'
import type { IpcRegistrar } from '../../ipc/registrar'
import { consultationTopicOf, MAX_TOPIC_IDS, type ConsultationTopic, type ConsultationTopicsResult } from '../../../shared/consultation-topics'

export interface RecordViewsDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  timeoutMs?: number
}

const COMPANY = /^[A-Za-z0-9_-]{1,100}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const BAD_INPUT = { success: false as const, offline: false, error: '入力が正しくありません。' }

type Answer = { status: number; json: { data?: unknown; error?: unknown; code?: unknown } | null } | null

export function createRecordViewsApi(deps: RecordViewsDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console
  let me: { cookies: string; id: string } | null = null

  async function call(companyId: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return null
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000),
        headers: { Cookie: cookies.join('; '), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      return { status: res.status, json: await res.json().catch(() => null) as NonNullable<Answer>['json'] }
    } catch {
      log.warn(`[record-views] ${path.split('/').slice(0, 3).join('/')}: the server could not be reached`)
      return null
    }
  }

  const disabled = (a: NonNullable<Answer>) => a.status === 404 && a.json?.code === 'RECORDS_DISABLED'
  const failure = (a: Answer) => ({
    success: false as const, offline: a === null || a.status >= 500,
    error: a === null || a.status >= 500 ? RECORD_VIEWS_OFFLINE_TEXT : '表示できませんでした。',
  })

  async function types(companyId: string): Promise<Map<string, TypeDefinition>> {
    const a = await call(companyId, 'GET', '/records/types')
    const list = a?.status === 200 ? (a.json?.data as { types?: RecordTypeView[] } | undefined)?.types ?? [] : []
    return new Map(list.map(t => [t.definition.name, t.definition]))
  }

  async function list(companyId: string, query: Record<string, unknown>): Promise<RecordListResult> {
    const [a, defs] = await Promise.all([call(companyId, 'POST', '/records/query', { ...query, limit: 100 }), types(companyId)])
    if (a && disabled(a)) return { success: true, available: false, total: 0, records: [] }
    if (a?.status !== 200) return failure(a)
    const result = a.json?.data as RecordQueryResult
    return { success: true, available: true, total: result.total, records: result.records.map(r => summaryView(r, defs.get(r.type))) }
  }

  return {
    search(companyId: string, text: string): Promise<RecordListResult> | RecordListResult {
      const t = typeof text === 'string' ? text.normalize('NFC').trim() : ''
      if (!COMPANY.test(companyId) || t.length === 0 || t.length > 100) return BAD_INPUT
      return list(companyId, { text: t })
    },

    async find(companyId: string, text: string, today: string): Promise<FindResult> {
      const t = typeof text === 'string' ? text.normalize('NFC').trim() : ''
      if (!COMPANY.test(companyId) || t.length === 0 || t.length > 100 || typeof today !== 'string' || !DAY.test(today)) return BAD_INPUT
      const [a, defs] = await Promise.all([call(companyId, 'POST', '/records/find', { text: t, today }), types(companyId)])
      if (a && disabled(a)) return { success: true, available: false, total: 0, hits: [], hubs: [] }
      if (a?.status !== 200) return failure(a)
      const r = a.json?.data as RecordFindResult
      return { success: true, available: true, total: r.total, hits: r.hits.map(h => findHitView(h, defs.get(h.record.type))), hubs: r.hubs }
    },

    async findHome(companyId: string, today: string, from: string, to: string): Promise<FindHomeResult> {
      if (!COMPANY.test(companyId) || ![today, from, to].every(d => typeof d === 'string' && DAY.test(d))) return BAD_INPUT
      const [a, defs] = await Promise.all([call(companyId, 'POST', '/records/find-home', { today, from, to }), types(companyId)])
      if (a && disabled(a)) return { success: true, available: false, bundles: [], meetings: [] }
      if (a?.status !== 200) return failure(a)
      const r = a.json?.data as RecordFindHome
      return {
        success: true, available: true,
        bundles: r.bundles.map(b => ({ ...findHitView(b, defs.get(b.record.type)), hub: b.hub })),
        meetings: r.meetings.map(h => findHitView(h, defs.get(h.record.type))),
      }
    },

    forFile(companyId: string, companyPath: string): Promise<RecordListResult> | RecordListResult {
      const p = typeof companyPath === 'string' ? fileLinkPath(companyPath) : null
      if (!COMPANY.test(companyId) || !p) return BAD_INPUT
      return list(companyId, { linkedToFile: p })
    },

    async topics(companyId: string, recordIds: string[]): Promise<ConsultationTopicsResult> {
      if (!COMPANY.test(companyId) || !Array.isArray(recordIds)) return BAD_INPUT
      const ids = [...new Set(recordIds.filter(id => typeof id === 'string' && RECORD_ID_RE.test(id)))].slice(0, MAX_TOPIC_IDS)
      if (ids.length === 0) return { success: true, topics: {} }
      const defs = await types(companyId)
      const topics: Record<string, ConsultationTopic | null> = {}
      let unreachable: Answer | undefined
      // A few at a time: a member's history can name many records.
      for (let i = 0; i < ids.length; i += 6) {
        await Promise.all(ids.slice(i, i + 6).map(async id => {
          const a = await call(companyId, 'GET', `/records/item/${encodeURIComponent(id)}`)
          if (a?.status === 200) topics[id] = consultationTopicOf(a.json?.data as RecordDetail, defs)
          // Not found, not allowed and records turned off are the same to the member: nothing to show.
          else if (a && (a.status === 404 || a.status === 403)) topics[id] = null
          else unreachable = a
        }))
      }
      if (unreachable !== undefined && Object.keys(topics).length === 0) return failure(unreachable)
      return { success: true, topics }
    },

    async card(companyId: string, recordId: string): Promise<RecordCardResult> {
      if (!COMPANY.test(companyId) || typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId)) return BAD_INPUT
      const id = encodeURIComponent(recordId)
      const [item, history, defs, members, runs, me, viewers] = await Promise.all([
        call(companyId, 'GET', `/records/item/${id}`),
        call(companyId, 'GET', `/records/item/${id}/history`),
        types(companyId),
        memberNames(companyId),
        call(companyId, 'GET', '/ai-runs'),
        myId(),
        call(companyId, 'POST', '/viewers', { records: [recordId] }),
      ])
      if (item?.status === 404) return { success: false, offline: false, notFound: true, error: '見つかりません。消されたか、見られないものです。' }
      if (item?.status !== 200) return failure(item)
      // Not awaited: the card never waits for it, and a failure changes nothing on screen.
      void call(companyId, 'POST', `/records/item/${id}/opened`, {})
      const detail = item.json?.data as RecordDetail
      const def = defs.get(detail.record.type)
      const entries = history?.status === 200 ? (history.json?.data as { entries?: LedgerEntry[] } | undefined)?.entries ?? [] : []
      // 「〇人はこのファイルを開けません」: a count per linked path (never who), when the server says.
      const paths = linkedPaths(detail.links)
      const gaps = paths.length > 0 ? await call(companyId, 'POST', '/viewers', { linked: { record: recordId, paths } }) : null
      const cannotOpen = gaps?.status === 200 ? (gaps.json?.data as { cannotOpen?: unknown } | undefined)?.cannotOpen : undefined
      const links: RecordCardLink[] = detail.links.map(l => {
        // Only this record's own link names say something; another record's link to it says nothing more than its kind.
        const label = l.direction === 'out' ? def?.links[l.name]?.label ?? l.name : ''
        const removable = removableOf(detail.record, l)
        return l.record
          ? { label, record: summaryView(l.record, defs.get(l.record.type)), ...(l.direction === 'out' && l.name === 'bundle' ? { bundle: true as const } : {}), ...(l.direction === 'out' && l.name === 'counterpart' ? { counterpart: true as const } : {}), recordVersion: l.record.version, ...(removable ? { removable } : {}) }
          : { label, ...linkedPathOf({ ...l, path: l.path as string }, cannotOpen) }
      })
      const isBundle = def?.implements.includes('bundle') ?? false
      const view = isBundle
        ? bundleDetailOf(detail.record, detail.links.flatMap(l => (l.record ? [l.record] : [])), me, members)
        : recordDetailOf(detail.record, members, me, def)
      const shownElsewhere = DETAIL_FIELDS[isBundle ? 'bundle' : detail.record.type]
      const runList = runs?.status === 200 ? (runs.json?.data as { runs?: AiRunView[] } | undefined)?.runs ?? [] : []
      const rest = shownElsewhere ? { ...detail.record, fields: Object.fromEntries(Object.entries(detail.record.fields).filter(([k]) => !shownElsewhere.has(k))) } : detail.record
      return {
        success: true,
        card: {
          record: summaryView(detail.record, def),
          version: detail.record.version,
          ...(view ? { detail: view } : {}),
          fields: cardFields(rest, def, members),
          history: historyLines(entries, def, members),
          links,
          ai: aiOnRecord(recordId, runList, entries, def, members),
          ...viewersOf(viewers, recordId),
        },
      }
    },
  }

  /** The member's own id (for 「あなたの番」), cached per session; null when unreachable. */
  async function myId(): Promise<string | null> {
    const cookies = deps.cookies().join('; ')
    if (me && me.cookies === cookies) return me.id
    const base = deps.baseUrl().replace(/\/+$/, '')
    if (!base || !cookies) return null
    try {
      const res = await doFetch(`${base}/api/me`, { redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000), headers: { Cookie: cookies } })
      const id = ((await res.json().catch(() => null)) as { data?: { id?: unknown } } | null)?.data?.id
      if (res.status !== 200 || typeof id !== 'string') return null
      me = { cookies, id }
      return id
    } catch {
      return null
    }
  }

  /** Member ids → names (any member may list the company's members); empty when unreachable. */
  async function memberNames(companyId: string): Promise<Record<string, string>> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return {}
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}/members`, {
        redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000), headers: { Cookie: cookies.join('; ') },
      })
      const json = await res.json().catch(() => null) as { data?: Array<{ userId?: unknown; id?: unknown; name?: unknown; email?: unknown }> } | null
      const out: Record<string, string> = {}
      for (const m of json?.data ?? []) {
        const id = typeof m.userId === 'string' ? m.userId : typeof m.id === 'string' ? m.id : null
        const name = typeof m.name === 'string' && m.name ? m.name : null
        if (id && name) out[id] = name
      }
      return out
    } catch {
      return {}
    }
  }
}

/** 見られる人 of this record, only when the server answered it (a record left out says nothing). */
function viewersOf(a: Answer, recordId: string): { viewers?: ViewersLabel } {
  const label = a?.status === 200 ? (a.json?.data as ViewersAnswer | undefined)?.records?.[recordId] : undefined
  return label && typeof label.text === 'string' && typeof label.kind === 'string' ? { viewers: label } : {}
}

/**
 * The AI on a record (plan I.4): a run of it the AI holds or may pick up now is 「反映しています」;
 * otherwise, when the newest change is the AI's, what it did. Nothing about the run's contents.
 */
export function aiOnRecord(recordId: string, runs: AiRunView[], entries: LedgerEntry[], def: TypeDefinition | undefined, people: Record<string, string>): RecordCardView['ai'] {
  const working = runs.some(r => r.recordId === recordId && (r.state === 'running' || r.state === 'open'))
  // The newest change 経緯 shows (a tag change is not one).
  const newest = historyEntries(entries, def)[0]
  const done = !working && newest?.actorKind === 'ai'
    ? { at: newest.at, text: historyLines([newest], def, people)[0].text.replace(/^AI：/, '') }
    : null
  return { working, done }
}

export function registerRecordViewsIpc(ipc: IpcRegistrar, deps: RecordViewsDeps): void {
  const api = createRecordViewsApi(deps)
  ipc.handle('recordViews:search', (_event, companyId, text) => api.search(companyId, text))
  ipc.handle('recordViews:card', (_event, companyId, recordId) => api.card(companyId, recordId))
  ipc.handle('recordViews:find', (_event, companyId, text, today) => api.find(companyId, text, today))
  ipc.handle('recordViews:findHome', (_event, companyId, today, from, to) => api.findHome(companyId, today, from, to))
  ipc.handle('recordViews:forFile', (_event, companyId, companyPath) => api.forFile(companyId, companyPath))
  ipc.handle('recordViews:topics', (_event, companyId, recordIds) => api.topics(companyId, recordIds))
}
