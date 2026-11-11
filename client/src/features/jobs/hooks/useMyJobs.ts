// 「定期の仕事」: the jobs the member is responsible for, as the server sees them, and their own acts on them.
import { useCallback, useRef, useState } from 'react'
import type { JobActionResult, MyJob } from '../../../../shared/jobs'
import { acceptJob, getMyJobs, pauseJob, resumeJob } from '../api'
import { acceptedText, runsLine } from '../model'

export function useMyJobs(companyId: string) {
  const [jobs, setJobs] = useState<MyJob[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async (): Promise<MyJob[] | null> => {
    const r = await getMyJobs(companyId)
    if (r.success) { setJobs(r.jobs); setError(null); return r.jobs }
    setError(r.error)
    return null
  }, [companyId])

  // The first load starts when the section's element mounts (a callback ref, committed like an
  // effect): the renderer's effect count is capped (renderer-structure.md "Effects").
  const loadedFor = useRef<string | null>(null)
  const loadRef = useCallback((el: HTMLElement | null) => {
    if (!el || loadedFor.current === companyId) return
    loadedFor.current = companyId
    void reload()
  }, [companyId, reload])

  /** `done`: the words from the job as the server answers after the act (it may still not run: paused, stopped, a PC job). */
  const run = useCallback(async (jobId: string, act: () => Promise<JobActionResult>, done: (after: MyJob | null) => string) => {
    setBusy(true)
    setMessage(null)
    try {
      const r = await act()
      const after = await reload()
      setMessage(r.success ? done(after?.find(j => j.id === jobId) ?? null) : r.error)
    } finally {
      setBusy(false)
    }
  }, [reload])

  const accept = useCallback((job: MyJob) => {
    const v = job.toAccept
    if (!v?.fingerprint) return Promise.resolve()
    return run(job.id, () => acceptJob(companyId, job.id, v.version, v.fingerprint as string), acceptedText)
  }, [companyId, run])
  const pause = useCallback((job: MyJob) => run(job.id, () => pauseJob(companyId, job.id), () => '止めました。止めている間の回は動きません。'), [companyId, run])
  const resume = useCallback((job: MyJob) => run(job.id, () => resumeJob(companyId, job.id), after => `再開しました。${after ? runsLine(after) : ''}`), [companyId, run])

  return { loadRef, jobs, error, message, busy, accept, pause, resume }
}
