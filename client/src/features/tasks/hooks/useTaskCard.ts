import { useCallback, useState } from 'react'
import type { TaskCardResult } from '../../../../shared/task-card'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { isPersonalPath } from '../../../../shared/today-folder'
import { fileIsHere, getTaskCard, onTasksMayHaveChanged } from '../api'

/** What a record's tab shows of it (its title and kind). */
export interface CardLook { title: string; type: string; typeLabel: string; state: string | null }

/**
 * One task's card, read from main (null while loading): at mount, when the member's turn or
 * notices may have changed, and on `reload` after the member's own change. A failed re-read
 * keeps the card on screen. The caller keys the component by record id.
 */
export function useTaskCard(companyId: string, recordId: string, onLoaded?: (look: CardLook) => void, rootPath?: string) {
  const loadedRef = useLatestRef(onLoaded)
  const [result, setResult] = useState<TaskCardResult | null>(null)
  // Linked files inside a `.personal/` folder that are on this computer (the server never has them).
  const [personalHere, setPersonalHere] = useState<ReadonlySet<string>>(new Set())
  const reload = useCallback(() => {
    void getTaskCard(companyId, recordId).then(
      r => {
        if (!r) return
        setResult(prev => (!r.success && prev?.success && !r.notFound ? prev : r))
        if (r.success && rootPath) {
          const personal = r.card.files.map(f => f.path).filter(isPersonalPath)
          void Promise.all(personal.map(p => fileIsHere(`${rootPath}/${p}`).then(here => (here ? [p] : []), () => [])))
            .then(found => setPersonalHere(new Set(found.flat())))
        }
        if (r.success) loadedRef.current?.({ title: r.card.record.title, type: r.card.record.type, typeLabel: r.card.record.typeLabel, state: r.card.record.state })
      },
      () => setResult(prev => prev ?? { success: false, offline: true, error: '表示できませんでした。' }),
    )
  }, [companyId, recordId, loadedRef, rootPath])
  const subscribe = useCallback((listener: (payload: undefined) => void) => {
    listener(undefined)
    return onTasksMayHaveChanged(companyId, () => listener(undefined))
  }, [companyId])
  useIpcEvent(subscribe, reload)
  return { result, reload, personalHere }
}
