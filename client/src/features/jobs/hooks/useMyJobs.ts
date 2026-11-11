// 「定期の仕事」: the jobs the member is responsible for, as the server sees them, and their own acts on them.
import { useCallback, useRef, useState } from 'react'
import type { JobActionResult, MyJob } from '../../../../shared/jobs'
import { acceptJob, getMyJobs, pauseJob, resumeJob } from '../api'

export function useMyJobs(companyId: string) {
  const [jobs, setJobs] = useState<MyJob[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    const r = await getMyJobs(companyId)
    if (r.success) { setJobs(r.jobs); setError(null) } else setError(r.error)
  }, [companyId])

  // The first load starts when the section's element mounts (a callback ref, committed like an
  // effect): the renderer's effect count is capped (renderer-structure.md "Effects").
  const loadedFor = useRef<string | null>(null)
  const loadRef = useCallback((el: HTMLElement | null) => {
    if (!el || loadedFor.current === companyId) return
    loadedFor.current = companyId
    void reload()
  }, [companyId, reload])

  const run = useCallback(async (act: () => Promise<JobActionResult>, done: string) => {
    setBusy(true)
    setMessage(null)
    try {
      const r = await act()
      setMessage(r.success ? done : r.error)
      await reload()
    } finally {
      setBusy(false)
    }
  }, [reload])

  const accept = useCallback((job: MyJob) => {
    const v = job.toAccept
    if (!v?.fingerprint) return Promise.resolve()
    return run(() => acceptJob(companyId, job.id, v.version, v.fingerprint as string), '受け取りました。次の回から動きます。')
  }, [companyId, run])
  const pause = useCallback((job: MyJob) => run(() => pauseJob(companyId, job.id), '止めました。止めている間の回は動きません。'), [companyId, run])
  const resume = useCallback((job: MyJob) => run(() => resumeJob(companyId, job.id), '再開しました。'), [companyId, run])

  return { loadRef, jobs, error, message, busy, accept, pause, resume }
}
