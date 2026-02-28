import { useState, useEffect, useCallback } from 'react'
import type { DepartmentConfig } from '../types'

interface DepartmentFromAPI {
  id: string
  companyId: string
  parentId: string | null
  name: string
  nameEn: string | null
  folder: string
  icon: string
  color: string
  description: string | null
  sortOrder: number
  isActive: boolean
  createdAt: string
  updatedAt: string
}

interface UseDepartmentsResult {
  departments: DepartmentConfig[]
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useDepartments(companyId: string | undefined): UseDepartmentsResult {
  const [departments, setDepartments] = useState<DepartmentConfig[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchDepartments = useCallback(async () => {
    if (!companyId) {
      setDepartments([])
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      const result = await window.electronAPI.getDepartments(companyId)

      if (result.success && result.data) {
        // Convert API response to DepartmentConfig format
        const deptConfigs: DepartmentConfig[] = result.data
          .filter((d: DepartmentFromAPI) => d.isActive)
          .sort((a: DepartmentFromAPI, b: DepartmentFromAPI) => a.sortOrder - b.sortOrder)
          .map((d: DepartmentFromAPI) => ({
            id: d.id,
            name: d.name,
            folder: d.folder,
            icon: d.icon,
            color: d.color,
            description: d.description || '',
          }))

        setDepartments(deptConfigs)
      } else {
        setError(result.error || 'Failed to fetch departments')
        setDepartments([])
      }
    } catch (err) {
      console.error('Failed to fetch departments:', err)
      setError(err instanceof Error ? err.message : 'Unknown error')
      setDepartments([])
    } finally {
      setIsLoading(false)
    }
  }, [companyId])

  useEffect(() => {
    fetchDepartments()
  }, [fetchDepartments])

  return {
    departments,
    isLoading,
    error,
    refresh: fetchDepartments,
  }
}
