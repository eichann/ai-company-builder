// One 探す search at a time: records from the server, lines from the files on this computer (git
// grep, capped in main, which also stops the previous grep), file names and this PC's
// consultations — merged as each arrives. A newer search makes every answer of an older one
// arrive nowhere, so a slow answer never paints over newer words. No React: the hook drives it.
import type { FindHitView, FindResult } from '../../../shared/record-views'
import type { RecordFindHub } from '../../../../shared/types/records'
import { foldWords, type FindConsultation, type FindLine } from './find'

export interface FindPorts {
  findRecords?: (text: string, today: string) => Promise<FindResult>
  grep: (text: string, folder: string) => Promise<{ success: boolean; results: FindLine[]; truncated?: boolean; cancelled?: boolean }>
  /** Every file name of the company on this computer (downloaded folders only). */
  listFiles: () => Promise<{ success: boolean; files: string[] }>
  fileTimes: (paths: readonly string[]) => Promise<Record<string, string>>
  consultations?: () => Promise<FindConsultation[]>
}

export interface FindState {
  query: string
  /** The folder the file contents were searched in ('' = the whole company). */
  folder: string
  hits: FindHitView[]
  hubs: RecordFindHub[]
  /** Records off for the company, or none asked. */
  recordsShown: boolean
  recordsFailed: string | null
  lines: FindLine[]
  linesTruncated: boolean
  filesFailed: boolean
  files: string[]
  fileTimes: Record<string, string>
  consultations: FindConsultation[]
  /** Answers still on their way. */
  pending: number
}

/** Files whose times are read per search (the rows a member scans). */
export const MAX_TIMED_FILES = 80
const FILE_LIST_FRESH_MS = 30_000

export function createFindRunner(ports: FindPorts, onChange: (s: FindState | null) => void, now: () => number = Date.now) {
  let seq = 0
  let state: FindState | null = null
  let fileList: { at: number; files: Promise<string[]> } | null = null
  const set = (mine: number, change: (s: FindState) => Partial<FindState>) => {
    if (mine !== seq || !state) return
    state = { ...state, ...change(state) }
    onChange(state)
  }
  const files = () => {
    if (!fileList || now() - fileList.at > FILE_LIST_FRESH_MS) {
      fileList = { at: now(), files: ports.listFiles().then(r => (r?.success ? r.files : []), () => []) }
    }
    return fileList.files
  }

  return {
    /** Start a search (empty words: stop showing results). Resolves once every answer arrived or was dropped. */
    async run(query: string, folder: string, today: string): Promise<void> {
      const mine = ++seq
      const q = query.trim()
      if (!q) { state = null; onChange(null); return }
      state = {
        query: q, folder, hits: [], hubs: [], recordsShown: !!ports.findRecords, recordsFailed: null, lines: [], linesTruncated: false,
        filesFailed: false, files: [], fileTimes: {}, consultations: [], pending: 3 + (ports.findRecords ? 1 : 0),
      }
      onChange(state)
      const done = (s: FindState) => ({ pending: s.pending - 1 })
      const records = ports.findRecords?.(q, today).then(r => set(mine, s => ({
        ...done(s),
        ...(r?.success ? { hits: r.hits, hubs: r.hubs, recordsShown: r.available } : { recordsFailed: r?.error ?? '記録は探せませんでした' }),
      })), () => set(mine, s => ({ ...done(s), recordsFailed: '記録は探せませんでした' })))
      const consults = (ports.consultations?.() ?? Promise.resolve([])).then(c => set(mine, s => ({ ...done(s), consultations: c ?? [] })), () => set(mine, done))
      const grep = ports.grep(q, folder).then(r => (r?.cancelled ? null : r ?? { success: false, results: [] as FindLine[], truncated: false }), () => ({ success: false, results: [] as FindLine[], truncated: false }))
      const names = files()
      const [g, list] = await Promise.all([grep, names])
      if (mine !== seq) return
      set(mine, s => ({ ...done(s), files: list, lines: g?.success ? g.results : [], linesTruncated: !!g?.truncated, filesFailed: g !== null && !g.success }))
      // The times of the files shown: name hits and files with lines, at most MAX_TIMED_FILES.
      const w = foldWords(q)
      const shown = [...new Set([...(g?.results ?? []).map(l => l.file), ...list.filter(f => foldWords(f.slice(f.lastIndexOf('/') + 1)).includes(w))])]
      const times = await ports.fileTimes(shown.slice(0, MAX_TIMED_FILES)).catch(() => ({}))
      set(mine, s => ({ ...done(s), fileTimes: times }))
      await Promise.all([records, consults])
    },
    /** Forget the file names (a sync or a download changed them). */
    forgetFiles() { fileList = null },
  }
}
