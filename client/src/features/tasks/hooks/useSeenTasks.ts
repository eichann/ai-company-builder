import { useCallback, useState } from 'react'

// Per company in localStorage `tasks-seen:<company id>`: the ids of あなたの番 the member has seen
// in the やること tab, so its dot shows only for what came after (owner 2026-11-02: no count on the tab).
const KEY = 'tasks-seen:'
const MAX_IDS = 500

function read(companyId: string | undefined): ReadonlySet<string> {
  if (!companyId) return new Set()
  try {
    const raw = JSON.parse(localStorage.getItem(`${KEY}${companyId}`) ?? '[]') as unknown
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/** The items of あなたの番 the member has seen, and marking the ones on screen as seen. */
export function useSeenTasks(companyId: string | undefined) {
  const [state, setState] = useState(() => ({ companyId, seen: read(companyId) }))
  if (state.companyId !== companyId) setState({ companyId, seen: read(companyId) })
  const markSeen = useCallback((ids: readonly string[]) => {
    setState(s => {
      if (ids.every(id => s.seen.has(id))) return s
      const seen = new Set([...ids, ...s.seen].slice(0, MAX_IDS))
      try {
        if (s.companyId) localStorage.setItem(`${KEY}${s.companyId}`, JSON.stringify([...seen]))
      } catch {
        // Storage may be unavailable: the dot then only lasts for this session.
      }
      return { ...s, seen }
    })
  }, [])
  return { seen: state.seen, markSeen }
}
