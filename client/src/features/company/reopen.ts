// Reopening a company this computer remembers (App.tsx after sign-in, switching from the
// title bar): the same checks either way (restore-company.ts), its kind from the server.
import type { CompanyView } from '../../types'
import { answeredCompanyFolderKind, type CompanyFolderKind } from '../../../shared/company-folder'
import { registerCompanyFolder } from '../../shared/ipc/allowed-folders'
import { companyPathExists, getCompanies, openWorkingFolder } from './api'
import { checkRememberedCompany, type RestoreOutcome } from './restore-company'

/** `company` is what to open on 'open': the remembered one with the kind the server answered now. */
export async function reopenRememberedCompany(remembered: CompanyView): Promise<{ outcome: RestoreOutcome; company: CompanyView }> {
  // The kind comes from the server's answer, never from what this computer remembered.
  const kinds = new Map<string, CompanyFolderKind>()
  const outcome = await checkRememberedCompany(remembered, {
    accessibleCompanyIds: async () => {
      const result = await getCompanies()
      if (!result?.success || !Array.isArray(result.data)) return null
      for (const c of result.data) kinds.set(c.id, answeredCompanyFolderKind(c.folderKind))
      return result.data.map((c) => c.id)
    },
    registerAllowedRoot: (folder) => registerCompanyFolder(folder),
    exists: (target) => companyPathExists(target),
    withoutSharedFolder: (id) => kinds.get(id) === 'none',
    openWorkingFolder: async (folder, id) => (await openWorkingFolder(folder, id).catch(() => null))?.success === true,
  })
  return { outcome, company: { ...remembered, folderKind: kinds.get(remembered.id) ?? 'git' } }
}
