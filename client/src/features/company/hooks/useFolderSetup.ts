import { useState } from 'react'
import type { CompanyInfo } from '../../../../shared/ipc-contract'
import type { CompanyView } from '../../../types'
import { createCompanyFolder, onSetupProgress, setUpCompanyFolder } from '../api'
import { readFolderDepartments } from '../folderSetup'
import type { SetupKind, SetupStep } from '../model'

/**
 * Setting a chosen folder up and opening the company: create the folder,
 * download the company (only the picked departments, when some were picked),
 * read its departments, then hand the company to `onOpened`.
 */
export function useFolderSetup(onOpened: (company: CompanyView) => void) {
  const [kind, setKind] = useState<SetupKind>('firstSetup')
  const [step, setStep] = useState<SetupStep>('folder')
  const [error, setError] = useState<string | null>(null)
  const [receivedBytes, setReceivedBytes] = useState(0)

  async function run(company: CompanyInfo, companyPath: string, selectedFolders: string[], setupKind: SetupKind) {
    setKind(setupKind)
    setStep('folder')
    setError(null)
    setReceivedBytes(0)

    try {
      await createCompanyFolder(companyPath)

      setStep('git')
      // Main reports the bytes received only while this call runs.
      const stopProgress = onSetupProgress(progress => setReceivedBytes(progress.receivedBytes))
      let gitResult: Awaited<ReturnType<typeof setUpCompanyFolder>>
      try {
        gitResult = await setUpCompanyFolder(companyPath, company.id, selectedFolders.length > 0 ? selectedFolders : undefined)
      } finally {
        stopProgress()
      }
      if (!gitResult.success) {
        console.warn('Failed to setup git remote:', gitResult.error)
        if (gitResult.refused || setupKind === 'firstSetup') {
          // The folder cannot be used, or the first download failed: say so
          // instead of opening an empty company. Starting again resumes it.
          setError(gitResult.error || 'ダウンロードできませんでした。もう一度お試しください。')
          return
        }
        // An existing clone (offline, say) or the owner's first upload:
        // continue anyway — the next sync retries.
      }

      // Default department folders are seeded server-side at company creation.
      setStep('folder')
      const departments = await readFolderDepartments(companyPath)

      setStep('done')
      // Long enough to see the completion.
      await new Promise(resolve => setTimeout(resolve, 500))

      onOpened({
        id: company.id,
        name: company.name,
        rootPath: companyPath,
        departments,
        createdAt: new Date(company.createdAt),
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    }
  }

  return { kind, step, error, receivedBytes, run, clearError: () => setError(null) }
}
