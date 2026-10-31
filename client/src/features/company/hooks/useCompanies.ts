import { useCallback, useEffect, useState } from 'react'
import type { CompanyInfo } from '../../../../shared/ipc-contract'
import { getCompanies } from '../api'

/** The companies the member belongs to, loaded once from the company server. */
export function useCompanies() {
  const [companies, setCompanies] = useState<CompanyInfo[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    getCompanies()
      .then(result => {
        if (!live) return
        if (result.success && result.data) setCompanies(result.data)
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
