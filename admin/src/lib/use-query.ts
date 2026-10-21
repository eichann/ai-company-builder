'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export interface QueryResult<T> {
  /** Latest data for this key; kept while a reload is in flight. */
  data: T | undefined
  error: unknown
  /** True until the first response for this key arrives. */
  loading: boolean
  /** True while any request (first load or reload) is in flight. */
  fetching: boolean
  reload: () => void
  /** Replace the data locally (optimistic updates). */
  setData: (updater: (prev: T | undefined) => T) => void
}

interface Settled<T> {
  key: string
  run: number
  data: T | undefined
  error: unknown
}

/**
 * Minimal data loader: fetches when `key` changes or `reload()` is called.
 * `key === null` skips fetching (e.g. until the user is known).
 *
 * Loading state is derived from which request last settled rather than set
 * inside the effect, so the effect only ever sets state from async callbacks.
 */
export function useQuery<T>(key: string | null, fetcher: () => Promise<T>): QueryResult<T> {
  const [run, setRun] = useState(0)
  const [settled, setSettled] = useState<Settled<T> | null>(null)
  const fetcherRef = useRef(fetcher)

  useEffect(() => {
    fetcherRef.current = fetcher
  })

  useEffect(() => {
    if (key === null) return
    let active = true
    fetcherRef.current().then(
      (data) => {
        if (active) setSettled({ key, run, data, error: undefined })
      },
      (error: unknown) => {
        if (active) {
          setSettled((prev) => ({
            key,
            run,
            // Keep showing what we had if a reload of the same key fails.
            data: prev?.key === key ? prev.data : undefined,
            error,
          }))
        }
      }
    )
    return () => {
      active = false
    }
  }, [key, run])

  const reload = useCallback(() => setRun((r) => r + 1), [])

  const setData = useCallback(
    (updater: (prev: T | undefined) => T) => {
      setSettled((prev) => {
        if (key === null) return prev
        const base = prev?.key === key ? prev : null
        return { key, run: base?.run ?? run, data: updater(base?.data), error: undefined }
      })
    },
    [key, run]
  )

  const sameKey = key !== null && settled?.key === key
  const current = sameKey && settled.run === run
  return {
    data: sameKey ? settled.data : undefined,
    error: current ? settled.error : undefined,
    loading: key !== null && !sameKey,
    fetching: key !== null && !current,
    reload,
    setData,
  }
}
