'use client'

import { departmentsApi, type Department, type DepartmentManager } from './api'
import { useQuery } from './use-query'

export type ManagersByDepartment = Record<string, DepartmentManager[]>

/** Managers of every listed department, fetched in parallel. */
export function useDepartmentManagers(companyId: string, departments: Department[] | undefined) {
  const ids = departments?.map((d) => d.id) ?? null
  return useQuery<ManagersByDepartment>(
    ids ? `managers:${companyId}:${ids.join(',')}` : null,
    async () => {
      const entries = await Promise.all(
        (ids ?? []).map(async (id) => [id, (await departmentsApi.getManagers(companyId, id)).managers] as const)
      )
      return Object.fromEntries(entries)
    }
  )
}

/** userId -> departments that user manages. */
export function departmentsByManager(
  departments: Department[] | undefined,
  managers: ManagersByDepartment | undefined
): Record<string, Department[]> {
  const result: Record<string, Department[]> = {}
  if (!departments || !managers) return result
  for (const d of departments) {
    for (const m of managers[d.id] ?? []) {
      ;(result[m.userId] ??= []).push(d)
    }
  }
  return result
}
