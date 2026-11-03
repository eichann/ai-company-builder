import { useRef, useState } from 'react'
import { suggestTaskTags } from '../api'

/** How long typing pauses before the title is sent (typing is never held up). */
const PAUSE_MS = 700

/**
 * Tag suggestions for a title as it is typed: asked once typing pauses, and only the newest
 * answer is kept, so an older, slower answer never replaces it. Called from the input's change
 * handler (no effect): `ask(title)`.
 */
export function useTagSuggestions(companyId: string, tagsInUse: string[]) {
  const [shown, setShown] = useState<{ title: string; tags: string[] } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(0)
  const ask = (title: string) => {
    if (timer.current) clearTimeout(timer.current)
    const asked = ++latest.current
    const t = title.trim()
    if (!t || tagsInUse.length === 0) { setShown(null); return }
    timer.current = setTimeout(() => {
      void suggestTaskTags(companyId, t, tagsInUse)
        .then(r => { if (asked === latest.current) setShown({ title: t, tags: r.tags }) })
        .catch(() => { /* no suggestions: typing goes on as before */ })
    }, PAUSE_MS)
  }
  return { suggestions: shown, ask }
}
