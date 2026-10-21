// Rendering a company page as the app does (providers + the API routes every
// company page loads). Shared by the page tests.
import type { ReactNode } from 'react'
import { render } from '@testing-library/react'

import { TooltipProvider } from '@/components/ui/tooltip'
import { AuthProvider } from '@/lib/auth-context'
import { CompanyProvider } from '@/lib/company-context'
import {
  COMPANY_ID,
  clientActivity,
  company,
  departments,
  invitations,
  managers,
  members,
  ok,
  ownerCapabilities,
} from './fixtures'

export const base = `/api/companies/${COMPANY_ID}`

export function companyRoutes(caps = ownerCapabilities) {
  const managerRoutes = Object.fromEntries(
    departments.map((d) => [`GET ${base}/departments/${d.id}/managers`, { body: ok({ managers: managers[d.id] }) }])
  )
  return {
    'GET /api/me': { body: ok({ id: 'u_owner', email: 'sato@example.com', name: '佐藤 花子' }) },
    [`GET ${base}`]: { body: ok({ ...company, role: caps.role }) },
    'GET /api/companies': { body: ok([company]) },
    [`GET ${base}/me/capabilities`]: { body: ok(caps) },
    [`GET ${base}/members`]: { body: ok(members) },
    [`GET ${base}/departments?flat=true`]: { body: ok(departments) },
    [`GET ${base}/client-activity`]: { body: ok(clientActivity) },
    [`GET ${base}/invitations`]: { body: ok(invitations) },
    ...managerRoutes,
  }
}

export function renderInCompany(ui: ReactNode) {
  return render(
    <TooltipProvider>
      <AuthProvider>
        <CompanyProvider companyId={COMPANY_ID}>{ui}</CompanyProvider>
      </AuthProvider>
    </TooltipProvider>
  )
}
