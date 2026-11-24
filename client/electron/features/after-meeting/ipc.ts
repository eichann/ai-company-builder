// 「会議のあと」 (4b-4 PR6-A, jobs.md "The set watch (schema 5)" "The 4b-4 screens (PR6-A)"): main's small part of the card —
// files on this PC only, the server asked nothing but the type list (確度's choices). Built to be removed with
// `src/features/after-meeting/` and `shared/after-meeting.ts` (`client/tests/after-meeting-removable.test.ts`).
//   afterMeeting:read  (companyId, rootPath, occurrenceId)          the run's record, 更新案.json, result.json, the mark
//   afterMeeting:note  (companyId, rootPath, occurrenceId, change)  record a press (never the same item twice), an undo, ［いらない］
// Why IPC at all: the run folder is named only in the run's record in the app's data, which the screen cannot read.
import path from 'node:path'
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { isOccurrenceId } from '../../../../shared/core/jobs'
import { diskKey } from '../../../../shared/core/paths'
import type { FieldDef } from '../../../../shared/core/record-types'
import type { RecordTypeView } from '../../../../shared/types/records'
import {
  AFTER_MEETING_FILE_MAX, AFTER_MEETING_RESULT_FILE, APPLY_ID_RE, handedItems, readMark, readProposalFile, readResultFile, refusedKeys,
  type AfterMeetingChange, type AfterMeetingMark, type AfterMeetingNoteResult, type AfterMeetingRead, type AfterMeetingRun, type ResultItem,
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
    return {
      success: true, run, mark, stages,
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
        mark.applies = [...mark.applies, { id: c.id, at: new Date(now()).toISOString(), kind: c.kind, keys: [...c.keys], ...(handed ? { items: handed } : {}) }].slice(-50)
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
