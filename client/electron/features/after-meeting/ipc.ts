// Kept whole (~330 lines): the card's one main part — its files, its mark and what it reads from the server.
// 「会議のあと」 (4b-4 PR6-A, jobs.md "The set watch (schema 5)" "The 4b-4 screens (PR6-A)"): main's small part of the card —
// files on this PC only; the server is only read (the type list for 確度's choices, the 案件 the member reads, owner FB #43). Built to be removed with
// `src/features/after-meeting/` and `shared/after-meeting.ts` (`client/tests/after-meeting-removable.test.ts`).
//   afterMeeting:read  (companyId, rootPath, occurrenceId)          the run's record, 更新案.json, result.json, the mark, the 案件 to choose
//   afterMeeting:note  (companyId, rootPath, occurrenceId, change)  record a press (never the same item twice), an undo, ［いらない］
// Why IPC at all: the run folder is named only in the run's record in the app's data, which the screen cannot read.
import path from 'node:path'
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { isOccurrenceId } from '../../../../shared/core/jobs'
import { diskKey } from '../../../../shared/core/paths'
import type { FieldDef } from '../../../../shared/core/record-types'
import { RECORD_ID_RE } from '../../../../shared/core/records'
import type { RecordDetail, RecordQueryResult, RecordSummary, RecordTypeView } from '../../../../shared/types/records'
import {
  AFTER_MEETING_FILE_MAX, AFTER_MEETING_RESULT_FILE, APPLY_ID_RE, dealPicks, handedItems, movedDeals, readMark, readProposalFile, readResultFile, refusedKeys,
  type AfterMeetingChange, type AfterMeetingMark, type AfterMeetingNoteResult, type AfterMeetingRead, type AfterMeetingRun, type DealChoice, type ResultItem,
  type SetUpdateItem,
} from '../../../shared/after-meeting'
import { SET_WATCH_UPDATES_FILE } from '../../../shared/ai-turn-steps/set-watch'
import type { IpcRegistrar } from '../../ipc/registrar'

export interface AfterMeetingDeps {
  /** The registered company folders (the renderer's path checked by name and by real location). */
  paths: { validate: (p: string) => string }
  /** Where PR5 keeps each run's record (`<userData>/job-set-runs`). */
  recordsRoot: () => string
  /** Where this card keeps its marks (`<userData>/after-meeting`). */
  marksRoot: () => string
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  now?: () => number
  log?: Pick<Console, 'warn'>
}

const COMPANY_RE = /^[A-Za-z0-9_-]{1,100}$/
const BAD: AfterMeetingNoteResult = { success: false, code: 'BAD_REQUEST', error: '入力が正しくありません。' }
const KEY_MAX = 200
const STAGES_KEPT_MS = 5 * 60_000
/** The 案件 offered are read again at most this often (the card reads every 15 s while a press waits). */
const DEALS_KEPT_MS = 60_000
const DEALS_MAX = 10
/** A 新規 取引's company name, searched also without the corporate form (案件 names often leave it out). */
const NEW_DEAL_RE = /^新規[:：]\s*(.+)$/
const CORPORATE_FORMS = /株式会社|有限会社|合同会社|一般社団法人|一般財団法人|\(株\)|\(有\)|㈱|㈲/g
/** A press whose consultation did not start may be taken back only this soon after it (and only while nothing answered it). */
const CANCEL_WITHIN_MS = 60_000

/** A run folder as PR5 writes it: `<place>/.personal/<folder>/<run>`, plain segments only. */
function runFolderOk(rel: unknown): rel is string {
  if (typeof rel !== 'string' || rel.length > 400) return false
  const parts = rel.split('/')
  return parts.length === 4 && parts[1] === '.personal' && parts.every(s => s !== '' && s !== '.' && s !== '..' && !s.includes('\\') && !s.includes('\0'))
}

export function createAfterMeetingApi(deps: AfterMeetingDeps) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? console
  const doFetch = deps.fetch ?? fetch
  // One write at a time per occurrence: two presses never both pass the check.
  const queues = new Map<string, Promise<unknown>>()
  const serial = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const next = (queues.get(key) ?? Promise.resolve()).then(fn, fn)
    queues.set(key, next.catch(() => {}))
    return next
  }

  /** The newest record of the run on this PC that names a folder. */
  async function runOf(companyId: string, occurrenceId: string): Promise<AfterMeetingRun | null> {
    const dir = path.join(deps.recordsRoot(), companyId, occurrenceId)
    let best: AfterMeetingRun | null = null
    for (const f of (await readdir(dir).catch(() => [] as string[])).slice(0, 50)) {
      if (!f.endsWith('.json')) continue
      const r = await readFile(path.join(dir, f), 'utf8').then(t => JSON.parse(t) as Record<string, unknown>, () => null)
      if (!r || r.occurrenceId !== occurrenceId || !runFolderOk(r.folder) || typeof r.at !== 'string' || Number.isNaN(Date.parse(r.at))) continue
      if (best && Date.parse(best.at) >= Date.parse(r.at)) continue
      best = {
        folder: r.folder, at: r.at,
        decision: typeof r.decision === 'string' ? r.decision : null,
        confidence: typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1 ? r.confidence : null,
        minutesDocVersion: typeof r.minutesDocVersion === 'string' && r.minutesDocVersion.length <= 200 ? r.minutesDocVersion : null,
      }
    }
    return best
  }

  /** A file of the run folder, inside the company folder by its real location, never through a link; null when not there. */
  async function runFile(root: string, run: AfterMeetingRun, name: string): Promise<string | null> {
    const folder = path.join(root, ...run.folder.split('/'))
    const real = await realpath(folder).catch(() => null)
    const realRoot = await realpath(root).catch(() => null)
    // Compared as the disk folds names (a Mac's NFD spelling of a Japanese place or company is the same folder).
    if (!real || !realRoot || diskKey(real) !== diskKey(path.join(realRoot, ...run.folder.split('/')))) return null
    const file = path.join(real, name)
    const st = await lstat(file).catch(() => null)
    if (!st || !st.isFile() || st.size > AFTER_MEETING_FILE_MAX) return null
    return readFile(file, 'utf8').catch(() => null)
  }

  let tmpCount = 0
  const markFile = (companyId: string, occurrenceId: string) => path.join(deps.marksRoot(), companyId, `${occurrenceId}.json`)
  const markOf = async (companyId: string, occurrenceId: string) => readMark(await readFile(markFile(companyId, occurrenceId), 'utf8').catch(() => null))
  async function writeMark(companyId: string, occurrenceId: string, mark: AfterMeetingMark): Promise<boolean> {
    const file = markFile(companyId, occurrenceId)
    try {
      await mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.${++tmpCount}.tmp`
      await writeFile(tmp, JSON.stringify(mark), { mode: 0o600 })
      await rename(tmp, file)
      return true
    } catch {
      return false
    }
  }

  // The stages change with a plugin version: read at most every few minutes (the card reads again while a press waits).
  const stagesKept = new Map<string, { at: number; stages: string[] | null }>()
  async function stagesOf(companyId: string): Promise<string[] | null> {
    const kept = stagesKept.get(companyId)
    if (kept && now() - kept.at < STAGES_KEPT_MS) return kept.stages
    const stages = await readStages(companyId)
    stagesKept.set(companyId, { at: now(), stages })
    return stages
  }

  /** 確度's choices: a business type's choice field named 確度 in the types the server answers (its labels, in order). */
  async function readStages(companyId: string): Promise<string[] | null> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return null
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}/records/types`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { Cookie: cookies.join('; ') },
      })
      if (res.status !== 200) return null
      const types = ((await res.json().catch(() => null)) as { data?: { types?: Array<Partial<RecordTypeView>> } } | null)?.data?.types ?? []
      for (const t of Array.isArray(types) ? types : []) {
        for (const f of Object.values(t.definition?.fields ?? {})) {
          const field = f as Partial<FieldDef>
          if (field.label !== '確度' || field.kind !== 'choice' || !Array.isArray(field.options)) continue
          const labels = (typeof field.optionLabels === 'object' && field.optionLabels !== null ? field.optionLabels : {}) as Record<string, unknown>
          const out = field.options.filter((o): o is string => typeof o === 'string').map(o => (typeof labels[o] === 'string' ? labels[o] as string : o))
          return out.length > 0 && out.length <= 20 ? out : null
        }
      }
      return null
    } catch {
      log.warn('[after-meeting] the type list could not be read')
      return null
    }
  }

  type Answer = { status: number; data: unknown } | null
  async function call(companyId: string, method: 'GET' | 'POST', route: string, body?: unknown): Promise<Answer> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return null
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}${route}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Cookie: cookies.join('; '), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      return { status: res.status, data: ((await res.json().catch(() => null)) as { data?: unknown } | null)?.data ?? null }
    } catch {
      return null
    }
  }

  const dealsKept = new Map<string, { at: number; deals: DealChoice[] | null; meetingBundle: string | null }>()
  async function dealsOf(companyId: string, meetingId: string | null, items: readonly SetUpdateItem[]): Promise<{ deals: DealChoice[] | null; meetingBundle: string | null }> {
    const named = [...new Set(items.filter(i => i.書き先 === 'hubspot').map(i => i.取引))]
    if (named.length === 0) return { deals: null, meetingBundle: null }
    const key = `${companyId}\n${meetingId ?? ''}\n${named.join('\n')}`
    const kept = dealsKept.get(key)
    if (kept && now() - kept.at < DEALS_KEPT_MS) return { deals: kept.deals, meetingBundle: kept.meetingBundle }
    const read = await readDeals(companyId, meetingId, named).catch(() => null)
    if (!read) {
      log.warn('[after-meeting] the 案件 could not be read')
      return { deals: null, meetingBundle: null }
    }
    // Only an answer is kept: offline now, read again at the next look.
    dealsKept.set(key, { at: now(), ...read })
    return read
  }

  /**
   * The 案件 a HubSpot 取引 may go to (owner FB #43), from what the server answers the member (it leaves out what they cannot
   * read): the meeting's own 案件, a 案件 the file names by id, the 案件 of the meeting's 相手, and those whose name holds a
   * 新規 取引's company name; open ones only. `deals: null` when no type of 案件 (a まとまり with 確度) is there; null when the
   * server is not reached.
   */
  async function readDeals(companyId: string, meetingId: string | null, named: string[]): Promise<{ deals: DealChoice[] | null; meetingBundle: string | null } | null> {
    const types = await call(companyId, 'GET', '/records/types')
    if (types?.status !== 200) return null
    const defs = ((types.data as { types?: Array<Partial<RecordTypeView>> } | null)?.types ?? []).flatMap(t => (t.definition ? [t.definition] : []))
    type Def = typeof defs[number]
    const field = (d: Def, label: string) => Object.entries(d.fields ?? {}).find(([, f]) => (f as Partial<FieldDef>).label === label)
    const def = defs.find(d => (d.implements ?? []).includes('bundle') && field(d, '確度'))
    if (!def) return { deals: null, meetingBundle: null }
    const members = await call(companyId, 'GET', '/members')
    const names = new Map<string, string>()
    for (const m of Array.isArray(members?.data) ? members.data as Array<{ userId?: unknown; id?: unknown; name?: unknown }> : []) {
      const id = typeof m.userId === 'string' ? m.userId : typeof m.id === 'string' ? m.id : null
      if (id && typeof m.name === 'string' && m.name) names.set(id, m.name)
    }
    const found = new Map<string, { record: RecordSummary; why: DealChoice['why']; for?: string }>()
    const take = (r: RecordSummary | undefined | null, why: DealChoice['why'], deal?: string) => {
      if (r && typeof r.id === 'string' && r.type === def.name && !(def.final ?? []).includes(r.state ?? '') && !found.has(r.id)) found.set(r.id, { record: r, why, ...(deal ? { for: deal } : {}) })
    }
    // A search that did not answer is not "none found": the card would offer only 「新しく作る」 (a second 案件).
    const answered = (a: Answer, also404 = false): a is NonNullable<Answer> => {
      if (a && (a.status === 200 || (also404 && a.status === 404))) return true
      throw new Error('not answered')
    }
    let meetingBundle: string | null = null
    let counterpart: string | null = null
    if (meetingId && RECORD_ID_RE.test(meetingId)) {
      const meeting = await call(companyId, 'GET', `/records/item/${encodeURIComponent(meetingId)}`)
      for (const l of answered(meeting, true) && meeting.status === 200 ? (meeting.data as RecordDetail | null)?.links ?? [] : []) {
        if (l.direction !== 'out' || !l.record) continue
        if (l.name === 'bundle') { meetingBundle = l.record.id; take(l.record, 'linked') }
        if (l.name === 'counterpart') counterpart = l.record.id
      }
    }
    for (const id of named.filter(n => RECORD_ID_RE.test(n)).slice(0, 5)) {
      const r = await call(companyId, 'GET', `/records/item/${encodeURIComponent(id)}`)
      if (answered(r, true) && r.status === 200) take((r.data as RecordDetail | null)?.record, 'named', id)
    }
    const query = async (body: Record<string, unknown>, why: DealChoice['why'], deal?: string) => {
      const r = await call(companyId, 'POST', '/records/query', { type: def.name, limit: 20, ...body })
      for (const rec of answered(r) ? (r.data as RecordQueryResult | null)?.records ?? [] : []) take(rec, why, deal)
    }
    if (counterpart) await query({ linkedTo: { id: counterpart } }, 'customer')
    for (const n of named) {
      const company = NEW_DEAL_RE.exec(n)?.[1]?.normalize('NFKC').trim()
      if (!company) continue
      const bare = company.replace(CORPORATE_FORMS, '').trim()
      for (const text of new Set([company, bare].filter(t => t.length >= 2).map(t => t.slice(0, 100)))) await query({ text }, 'name', n)
    }
    const [confidenceId, confidence] = field(def, '確度') ?? []
    const amountId = field(def, '金額')?.[0]
    const assigneeId = field(def, '担当')?.[0]
    const labels = ((confidence as Partial<FieldDef> | undefined)?.optionLabels ?? {}) as Record<string, unknown>
    const deals = [...found.values()].slice(0, DEALS_MAX).map(({ record: r, why, for: deal }): DealChoice => {
      const c = confidenceId ? r.fields?.[confidenceId] : null
      const a = amountId ? r.fields?.[amountId] : null
      const who = assigneeId ? r.fields?.[assigneeId] : null
      return {
        id: r.id, title: String(r.title ?? '').slice(0, 200), why, ...(deal ? { for: deal } : {}),
        confidence: typeof c === 'string' && c ? (typeof labels[c] === 'string' ? labels[c] as string : c) : null,
        amount: typeof a === 'number' && Number.isFinite(a) ? a : null,
        assignee: typeof who === 'string' && who ? names.get(who) ?? null : null,
      }
    })
    return { deals, meetingBundle }
  }

  async function where(companyId: unknown, rootPath: unknown, occurrenceId: unknown): Promise<{ companyId: string; root: string; occurrenceId: string } | null> {
    if (typeof companyId !== 'string' || !COMPANY_RE.test(companyId) || !isOccurrenceId(occurrenceId) || typeof rootPath !== 'string') return null
    try { return { companyId, root: deps.paths.validate(rootPath), occurrenceId } } catch { return null }
  }

  async function read(companyId: unknown, rootPath: unknown, occurrenceId: unknown): Promise<AfterMeetingRead> {
    const w = await where(companyId, rootPath, occurrenceId)
    if (!w) return { success: false, error: '入力が正しくありません。' }
    const run = await runOf(w.companyId, w.occurrenceId)
    if (!run) return { success: true, run: null }
    const [proposalText, resultText, mark, stages] = await Promise.all([
      runFile(w.root, run, SET_WATCH_UPDATES_FILE), runFile(w.root, run, AFTER_MEETING_RESULT_FILE), markOf(w.companyId, w.occurrenceId), stagesOf(w.companyId),
    ])
    const proposals = proposalText === null ? null : readProposalFile(proposalText)
    const offered = proposals && 'items' in proposals ? await dealsOf(w.companyId, proposals.meetingId, proposals.items) : { deals: null, meetingBundle: null }
    return {
      success: true, run, mark, stages, ...offered,
      meetingId: proposals && 'items' in proposals ? proposals.meetingId : null,
      proposals: proposals && 'items' in proposals ? proposals.items : [],
      problem: proposals === null ? 'none' : 'problem' in proposals ? proposals.problem : null,
      results: resultText === null ? [] : readResultFile(resultText),
    }
  }

  async function note(companyId: unknown, rootPath: unknown, occurrenceId: unknown, change: unknown): Promise<AfterMeetingNoteResult> {
    const w = await where(companyId, rootPath, occurrenceId)
    const c = change as AfterMeetingChange | null
    if (!w || typeof c !== 'object' || c === null) return BAD
    const okKey = (k: unknown): k is string => typeof k === 'string' && k.length > 0 && k.length <= KEY_MAX
    if ((c.kind === 'apply' || c.kind === 'undo') && !(typeof c.id === 'string' && APPLY_ID_RE.test(c.id) && c.id.startsWith(c.kind === 'apply' ? 'a-' : 'u-')
      && Array.isArray(c.keys) && c.keys.length > 0 && c.keys.length <= 40 && c.keys.every(okKey))) return BAD
    // An apply keeps what it handed on (an added item, an edited value): exactly its keys, each of the file's shape.
    const handed = c.kind === 'apply' ? handedItems(c.items, c.keys) : null
    if (c.kind === 'apply' && !handed) return BAD
    const deals = c.kind === 'apply' && handed ? dealPicks(c.deals, handed) : []
    if (!deals) return BAD
    if (c.kind === 'undone' && !okKey(c.key)) return BAD
    if (c.kind === 'cancel' && !(typeof c.id === 'string' && APPLY_ID_RE.test(c.id))) return BAD
    if (c.kind !== 'apply' && c.kind !== 'undo' && c.kind !== 'undone' && c.kind !== 'draft-dismissed' && c.kind !== 'cancel') return BAD
    return serial(`${w.companyId}/${w.occurrenceId}`, async (): Promise<AfterMeetingNoteResult> => {
      const mark = await markOf(w.companyId, w.occurrenceId)
      if (c.kind === 'apply' || c.kind === 'undo') {
        const run = await runOf(w.companyId, w.occurrenceId)
        if (!run) return { success: false, code: 'NOT_HERE', error: 'この PC には、この回の更新案がありません。' }
        const resultText = await runFile(w.root, run, AFTER_MEETING_RESULT_FILE)
        const results: ResultItem[] = resultText === null ? [] : readResultFile(resultText)
        // The one check of "never twice": an item handed on and not answered yet, or already written, is not handed on again.
        if (mark.applies.some(a => a.id === c.id) || refusedKeys(c, mark, results, now()).length > 0) {
          return { success: false, code: 'ALREADY', error: 'この項目は、もう反映しているか、反映の途中です。画面を読み直しました。' }
        }
        // An earlier press is writing (or wrote) the 取引 to one 案件: a later press never sends its other items to another one.
        if (movedDeals(deals, handed ?? [], mark, results, now()).length > 0) {
          return { success: false, code: 'ALREADY', error: '前の反映で選んだ案件に、もう書き始めています。案件は変えられません。画面を読み直しました。' }
        }
        mark.applies = [...mark.applies, { id: c.id, at: new Date(now()).toISOString(), kind: c.kind, keys: [...c.keys], ...(handed ? { items: handed } : {}), ...(deals.length > 0 ? { deals } : {}) }].slice(-50)
      } else if (c.kind === 'cancel') {
        const run = await runOf(w.companyId, w.occurrenceId)
        const resultText = run ? await runFile(w.root, run, AFTER_MEETING_RESULT_FILE) : null
        const answered = (resultText === null ? [] : readResultFile(resultText)).some(r => r.回 === c.id)
        const entry = mark.applies.find(a => a.id === c.id)
        if (!entry || answered || now() - Date.parse(entry.at) > CANCEL_WITHIN_MS) return { success: false, code: 'ALREADY', error: 'この押した記録は、もう取り消せません。' }
        mark.applies = mark.applies.filter(a => a.id !== c.id)
      } else if (c.kind === 'undone') {
        if (!mark.undone.includes(c.key)) mark.undone = [...mark.undone, c.key].slice(-100)
      } else {
        mark.draftDismissed = true
      }
      return (await writeMark(w.companyId, w.occurrenceId, mark))
        ? { success: true, mark }
        : { success: false, code: 'NOT_HERE', error: 'この PC に記録を残せませんでした。もう一度押してください。' }
    })
  }

  return { read, note }
}

export function registerAfterMeetingIpc(ipc: IpcRegistrar, deps: AfterMeetingDeps) {
  const api = createAfterMeetingApi(deps)
  ipc.handle('afterMeeting:read', (_event, companyId, rootPath, occurrenceId) => api.read(companyId, rootPath, occurrenceId))
  ipc.handle('afterMeeting:note', (_event, companyId, rootPath, occurrenceId, change) => api.note(companyId, rootPath, occurrenceId, change))
}
