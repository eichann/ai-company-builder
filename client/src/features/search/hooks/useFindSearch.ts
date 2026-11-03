import { useState } from 'react'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { fileTimes, findRecords, listCompanyFiles, searchFileContents } from '../api'
import type { FindConsultation } from '../find'
import { createFindRunner, type FindState } from '../findRunner'

interface Options {
  rootPath: string
  companyId?: string
  /** This PC's 「AIへの相談」, read again for each search. */
  loadConsultations?: () => Promise<FindConsultation[]>
}

/** The newest 探す search's answers (`findRunner.ts`); `run` starts one and drops the previous one's. */
export function useFindSearch(options: Options): { state: FindState | null; run: (query: string, folder: string, today: string) => Promise<void> } {
  const [state, setState] = useState<FindState | null>(null)
  const latest = useLatestRef(options)
  const [runner] = useState(() => createFindRunner({
    findRecords: (text, today) => {
      const id = latest.current.companyId
      return id ? findRecords(id, text, today) : Promise.resolve({ success: true as const, available: false, total: 0, hits: [], hubs: [] })
    },
    grep: (text, folder) => searchFileContents(latest.current.rootPath, text, folder),
    listFiles: () => listCompanyFiles(latest.current.rootPath, ''),
    fileTimes: paths => fileTimes(latest.current.rootPath, paths),
    consultations: () => latest.current.loadConsultations?.() ?? Promise.resolve([]),
  }, setState))
  // Another company folder: its file names are read again.
  const [root, setRoot] = useState(options.rootPath)
  if (root !== options.rootPath) { setRoot(options.rootPath); runner.forgetFiles() }
  return { state, run: runner.run }
}
