import { useCallback, useRef, useState } from 'react'
import { useAppStore } from '../../../stores/appStore'
import { companyHasSharedFolder } from '../../../../shared/company-folder'
import { getDepartments } from '../../../shared/ipc/departments'
import { readCompanyFolders, readCompanySkillFolders } from '../api'
import { foldersOf } from '../jobProposalEdit'

export interface JobProposalChoices { places: string[]; skills: Array<{ name: string; isDirectory: boolean }> }

/**
 * What a 「定期の仕事の案」 card offers to choose from, read once when the member first opens a place or Skill choice (never
 * before, never sent): the departments and, in a company with the shared folder, the folders and company Skills on this
 * computer. A company without the shared folder offers departments only and no other Skill (its Skills are the shelf's).
 */
export function useJobProposalChoices(companyId: string) {
  const company = useAppStore(s => s.currentCompany)
  const [choices, setChoices] = useState<JobProposalChoices | 'loading' | null>(null)
  const asked = useRef(false)
  const load = useCallback(() => {
    if (asked.current) return
    asked.current = true
    setChoices('loading')
    const root = company?.id === companyId ? company.rootPath : null
    const shared = root !== null && companyHasSharedFolder(company)
    void Promise.all([
      getDepartments(companyId).then(r => (r.success && r.data ? r.data.filter(d => d.isActive).map(d => d.folder) : [])).catch(() => [] as string[]),
      shared && root ? readCompanyFolders(root).then(nodes => foldersOf(nodes)) : Promise.resolve([] as string[]),
      shared && root ? readCompanySkillFolders(root) : Promise.resolve([]),
    ]).then(([departments, folders, skills]) => setChoices({ places: [...departments, ...folders], skills }))
  }, [company, companyId])
  return { choices, load }
}
