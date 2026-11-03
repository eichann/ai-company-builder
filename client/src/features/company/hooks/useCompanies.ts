import { useCallback, useEffect, useRef, useState } from 'react'
import type { CompanyInfo } from '../../../../shared/ipc-contract'
import { getCompanies } from '../api'

/** The companies the member belongs to, loaded once from the company server; `onLoaded` sees them once. */
export function useCompanies(onLoaded?: (companies: CompanyInfo[]) => void) {
  // The callback given on the first render (the list loads once).
  const loaded = useRef(onLoaded)
  const [companies, setCompanies] = useState<CompanyInfo[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    getCompanies()
      .then(result => {
        if (!live) return
        if (result.success && result.data) {
          setCompanies(result.data)
          loaded.current?.(result.data)
        }
        else setLoadError(result.error || 'Failed to load companies')
      })
      .catch(e => { if (live) setLoadError(e instanceof Error ? e.message : 'Unknown error') })
      .finally(() => { if (live) setIsLoading(false) })
    return () => { live = false }
  }, [])

  /** A company just created: listed first. */
  const add = useCallback((company: CompanyInfo) => setCompanies(prev => [company, ...prev]), [])

  return { companies, isLoading, loadError, add }
}
