// 「不在と代わりの人」: the member's absences as the server sees them, and adding / removing one.
import { useCallback, useRef, useState } from 'react'
import type { AbsenceAddInput, AbsenceMember } from '../../../../shared/absences'
import type { MemberAbsencesView } from '../../../../../shared/types/absences'
import { addAbsence, getAbsences, removeAbsence } from '../api'

export function useAbsences(companyId: string) {
  const [view, setView] = useState<MemberAbsencesView | null>(null)
  const [members, setMembers] = useState<AbsenceMember[]>([])
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    const r = await getAbsences(companyId)
    if (r.success) { setView(r.view); setMembers(r.members); setError(null) } else setError(r.error)
  }, [companyId])

  // The first load starts when the section's element mounts (a callback ref, committed like an
  // effect): the renderer's effect count is capped (renderer-structure.md "Effects").
  const loadedFor = useRef<string | null>(null)
  const loadRef = useCallback((el: HTMLElement | null) => {
    if (!el || loadedFor.current === companyId) return
    loadedFor.current = companyId
    void reload()
  }, [companyId, reload])

  /** True when it was added (the form clears). */
  const add = useCallback(async (input: AbsenceAddInput): Promise<boolean> => {
    setBusy(true)
    setMessage(null)
    try {
      const r = await addAbsence(companyId, input)
      if (!r.success) { setMessage(r.error); return false }
      const n = r.created.delegateCannotRead
      setMessage(n > 0 ? `代わりの人が見られないものが ${n} 件あります。部署の管理役に知らせました。` : '追加しました。')
      await reload()
      return true
    } finally {
      setBusy(false)
    }
  }, [companyId, reload])

  const remove = useCallback(async (absenceId: string) => {
    setBusy(true)
    setMessage(null)
    try {
      const r = await removeAbsence(companyId, absenceId)
      if (!r.success) setMessage(r.error)
      await reload()
    } finally {
      setBusy(false)
    }
  }, [companyId, reload])

  return { loadRef, view, members, error, message, busy, add, remove }
}
