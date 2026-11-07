import { useCallback, useState } from 'react'
import type { TaskCardResult } from '../../../../shared/task-card'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { useShown } from '../../../shared/hooks/useShown'
import { createShownCache } from '../../../shared/lib/shownCache'
import { isPersonalPath } from '../../../../shared/today-folder'
import { fileIsHere, getTaskCard, onTasksMayHaveChanged } from '../api'
import { nextCard } from '../model'

/** The cards shown before, so a tab switched back to shows its card at once and reads it again (owner FB #14). */
const shownCards = createShownCache<TaskCardResult>()

/** What a record's tab shows of it (its title and kind). */
export interface CardLook { title: string; type: string; typeLabel: string; state: string | null }

/**
 * One task's card, read from main (null only before the first answer): at mount, when the member's
 * turn or notices may have changed, on `reload` after the member's own change, and when the list
 * knows a newer version (`knownVersion`, e.g. a press in the list). A re-read never blanks the card:
 * the shown one stays until the new one arrives, so folds and scroll stay (owner 2026-11-03,
 * 使い心地のメモ #3: a remount per version made the screen flicker). Mounted again (a tab switched
 * back to), it starts from the card shown last and reads it again (owner FB #14: no 「読み込んでいます」
 * on every switch); a card read as gone is forgotten. The caller keys the component by record id only.
 */
export function useTaskCard(companyId: string, recordId: string, onLoaded?: (look: CardLook) => void, rootPath?: string, knownVersion?: number) {
  const loadedRef = useLatestRef(onLoaded)
  const [result, show] = useShown(shownCards, companyId, recordId)
  // Linked files inside a `.personal/` folder that are on this computer (the server never has them).
  const [personalHere, setPersonalHere] = useState<ReadonlySet<string>>(new Set())
  // A company without the shared folder: the member's own PC files linked here that are on this computer.
  const [localHere, setLocalHere] = useState<ReadonlySet<string> | null>(null)
  const reload = useCallback(() => {
    void getTaskCard(companyId, recordId).then(
      r => {
        if (!r) return
        // Two reads may race: an older version landing last never replaces a newer one.
        show(r, nextCard)
        if (r.success && rootPath) {
          const personal = r.card.files.map(f => f.path).filter(isPersonalPath)
          void Promise.all(personal.map(p => fileIsHere(`${rootPath}/${p}`).then(here => (here ? [p] : []), () => [])))
            .then(found => setPersonalHere(new Set(found.flat())))
          const local = r.card.localFiles.map(f => f.path)
          void Promise.all(local.map(p => fileIsHere(`${rootPath}/${p}`).then(here => (here ? [p] : []), () => [])))
            .then(found => setLocalHere(new Set(found.flat())))
        }
        if (r.success) loadedRef.current?.({ title: r.card.record.title, type: r.card.record.type, typeLabel: r.card.record.typeLabel, state: r.card.record.state })
      },
      () => show({ success: false, offline: true, error: '表示できませんでした。' }),
    )
  }, [companyId, recordId, loadedRef, rootPath, show])
  // The newest version the list told us of that the card has not shown: read again once for it
  // (adjusted while rendering; it only grows, so each newer version asks once).
  const [asked, setAsked] = useState(0)
  const shown = result?.success ? result.card.record.version : null
  if (knownVersion !== undefined && shown !== null && knownVersion > shown && knownVersion > asked) setAsked(knownVersion)
  // Subscribing reads the card: at mount, and again for each newer version (`asked` re-subscribes).
  const subscribe = useCallback((listener: (newest: number) => void) => {
    listener(asked)
    return onTasksMayHaveChanged(companyId, () => listener(asked))
  }, [companyId, asked])
  useIpcEvent(subscribe, reload)
  return { result, reload, personalHere, localHere }
}
