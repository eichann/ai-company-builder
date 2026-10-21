'use client'

import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'

import { capabilitiesApi, companiesApi, type Company, type Role } from './api'
import { isAdminRole } from './format'
import { useQuery, type QueryResult } from './use-query'

export const LAST_COMPANY_KEY = 'acb-admin:last-company'

export interface CompanyContextValue {
  companyId: string
  company: QueryResult<Company>
  companies: QueryResult<Company[]>
  /** Role in this company; null until known. */
  role: Role | null
  /** owner or admin: may change members, departments and settings. */
  isAdmin: boolean
  /** Departments the signed-in user is a manager (部署の責任者) of. */
  managedDepartmentIds: string[]
  /** Re-read the company, the company list and the user's role (after a rename or role change). */
  refresh: () => void
}

const CompanyContext = createContext<CompanyContextValue | null>(null)

export function CompanyProvider({ companyId, children }: { companyId: string; children: ReactNode }) {
  const company = useQuery(`company:${companyId}`, () => companiesApi.get(companyId))
  const companies = useQuery('companies', () => companiesApi.list())
  const capabilities = useQuery(`capabilities:${companyId}`, () => capabilitiesApi.get(companyId))

  useEffect(() => {
    if (!company.data) return
    try {
      localStorage.setItem(LAST_COMPANY_KEY, companyId)
    } catch {
      // Storage unavailable (private mode): only the "reopen last company" convenience is lost.
    }
  }, [company.data, companyId])

  // The role from capabilities is authoritative; the company record carries
  // the same role and covers the moment before capabilities arrive.
  const role = capabilities.data?.role ?? company.data?.role ?? null
  const managedDepartmentIds = capabilities.data?.managedDepartmentIds
  const { reload: reloadCompany } = company
  const { reload: reloadCompanies } = companies
  const { reload: reloadCapabilities } = capabilities

  const value = useMemo<CompanyContextValue>(
    () => ({
      companyId,
      company,
      companies,
      role,
      isAdmin: isAdminRole(role),
      managedDepartmentIds: managedDepartmentIds ?? [],
      refresh: () => {
        reloadCompany()
        reloadCompanies()
        reloadCapabilities()
      },
    }),
    [companyId, company, companies, role, managedDepartmentIds, reloadCompany, reloadCompanies, reloadCapabilities]
  )

  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>
}

export function useCompany(): CompanyContextValue {
  const ctx = useContext(CompanyContext)
  if (!ctx) throw new Error('useCompany must be used within CompanyProvider')
  return ctx
}
