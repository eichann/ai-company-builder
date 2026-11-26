import { useCallback, useRef, useState } from 'react'
import type { MyWorkSwitches, WorkSwitch } from '../../../../shared/work-switches'
import { getWorkSwitches, setWorkSwitch } from '../api'

/**
 * The member's own switches (自分の設定), read when the section mounts; a change shows what the
 * server answered (the company may have stopped one meanwhile). Errors are the server's words.
 */
export function useWorkSwitches(companyId: string) {
  const [switches, setSwitches] = useState<MyWorkSwitches | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A change refused because the company stopped that switch: something an admin can help with, not a failure.
  const [companyOff, setCompanyOff] = useState(false)
  const [busy, setBusy] = useState<WorkSwitch | null>(null)

  const reload = useCallback(async () => {
    try {
      const r = await getWorkSwitches(companyId)
      if (r.success) setSwitches(r.switches)
      else setError(r.error)
    } catch {
      setError('表示できませんでした。')
    }
  }, [companyId])

  // The first load starts when the section's element mounts (a callback ref, committed like an
  // effect): the renderer's effect count is capped (renderer-structure.md "Effects").
  const loadedFor = useRef<string | null>(null)
  const loadRef = useCallback((el: HTMLElement | null) => {
    if (!el || loadedFor.current === companyId) return
    loadedFor.current = companyId
    void reload()
  }, [companyId, reload])

  const change = useCallback(async (which: WorkSwitch, on: boolean) => {
    setBusy(which)
    setError(null)
    setCompanyOff(false)
    try {
      const r = await setWorkSwitch(companyId, which, on)
      if (r.success) setSwitches(r.switches)
      else {
        setError(r.error)
        setCompanyOff(r.code === 'WORK_SWITCH_COMPANY_OFF')
        // The company may have stopped it since the section opened: show what holds now.
        await reload()
      }
    } catch {
      setError('うまくいきませんでした。少し待ってから、もう一度押してください')
    } finally {
      setBusy(null)
    }
  }, [companyId, reload])

  return { loadRef, switches, error, companyOff, busy, change }
}
