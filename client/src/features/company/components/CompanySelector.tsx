// Choosing a company and setting its folder up (download-choices.md "First setup").
// A member's first time asks nothing when it can (管理画面の見直し 2-2): the only company
// opens by itself in ~/AI Company Builder/<会社名>, downloading the departments they belong
// to (所属). Any refusal (a folder of their own there, no 所属) falls back to asking.
import { useState } from 'react'
import { SignOut, SpinnerGap } from '@phosphor-icons/react'
import { useAppStore } from '../../../stores/appStore'
import { useAuthStore } from '../../../stores/authStore'
import type { CompanyInfo } from '../../../../shared/ipc-contract'
import { chooseFolder, getDefaultParentFolder } from '../api'
import { prepareCompanyFolder } from '../folderSetup'
import { companyToOpenWithoutChoosing, offersCompanyCreation, type PickableDepartment, type SelectorView, type SetupKind } from '../model'
import { hasRememberedCompany } from '../restore-company'
import { useCompanies } from '../hooks/useCompanies'
import { useFolderSetup } from '../hooks/useFolderSetup'
import { CompanyList } from './CompanyList'
import { CreateCompanyForm } from './CreateCompanyForm'
import { DepartmentPicker } from './DepartmentPicker'
import { FolderChoice, NewFolderChoice } from './FolderChoice'
import { SetupProgress } from './SetupProgress'

/** The picker's company folder, its departments, and where its 戻る goes. */
interface PickerState {
  folder: string
  departments: PickableDepartment[]
  backView: SelectorView
}

export function CompanySelector() {
  const addCompany = useAppStore(s => s.addCompany)
  const { user, signOut, refreshUser } = useAuthStore()
  const canCreate = offersCompanyCreation(user)
  const list = useCompanies(companies => {
    const only = user ? companyToOpenWithoutChoosing(companies, hasRememberedCompany(user.id)) : null
    if (only) void openWithoutChoosing(only)
  })
  const setup = useFolderSetup(addCompany)
  const [view, setView] = useState<SelectorView>('list')
  // Opening the only company by itself (until it shows a step or falls back to asking).
  const [opening, setOpening] = useState<string | null>(null)
  const [selected, setSelected] = useState<CompanyInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The folder 新しく作成 makes the company folder in.
  const [parentFolder, setParentFolder] = useState('')
  const [isPreparing, setIsPreparing] = useState(false)
  const [picker, setPicker] = useState<PickerState | null>(null)

  function select(company: CompanyInfo) {
    setSelected(company)
    setView('clone')
  }

  async function prepare(company: CompanyInfo, companyPath: string, backView: SelectorView) {
    setIsPreparing(true)
    setError(null)
    const next = await prepareCompanyFolder(companyPath, company.id).finally(() => setIsPreparing(false))
    if (next.kind === 'pick') {
      setPicker({ folder: companyPath, departments: next.departments, backView })
      setView('departments')
    } else if (next.kind === 'mine') {
      startSetup(company, companyPath, next.folders, 'firstSetup')
    } else if (next.kind === 'error') {
      setError(next.message)
      setView(backView)
    } else {
      startSetup(company, companyPath, [], next.kind)
    }
  }

  function startSetup(company: CompanyInfo, companyPath: string, folders: string[], kind: SetupKind) {
    setView('setup')
    void setup.run(company, companyPath, folders, kind)
  }

  // The only company, nothing remembered: its folder in the default place, no questions.
  // A refusal there (the member's own files) lands on the folder choice with the reason.
  async function openWithoutChoosing(company: CompanyInfo) {
    setOpening(company.name)
    setSelected(company)
    try {
      const parent = await getDefaultParentFolder().catch(() => null)
      if (!parent?.success || !parent.folder) {
        setView('clone')
        return
      }
      setParentFolder(parent.folder)
      await prepare(company, `${parent.folder}/${company.name}`, 'clone')
    } finally {
      setOpening(null)
    }
  }

  // 既存のフォルダを開く: the chosen folder itself is the company folder. It is
  // not 新しく作成's parent: a refused folder must not be preselected there.
  async function openExistingFolder(company: CompanyInfo) {
    const path = await chooseFolder()
    if (!path) return
    await prepare(company, path, 'clone')
  }

  async function pickParentFolder() {
    const path = await chooseFolder()
    if (path) setParentFolder(path)
  }

  if (list.isLoading || opening) {
    return (
      <div className="h-full bg-editor-bg flex flex-col items-center justify-center gap-4">
        <SpinnerGap size={48} className="animate-spin text-accent" />
        {opening && <p className="text-text-secondary">{opening}を準備しています</p>}
      </div>
    )
  }

  return (
    <div className="h-full bg-editor-bg flex items-center justify-center">
      <div className="w-full max-w-xl p-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center">
              <span className="text-accent font-medium">
                {user?.name?.[0] || user?.email?.[0] || '?'}
              </span>
            </div>
            <div>
              <div className="text-text-primary font-medium">
                {user?.name || user?.email}
              </div>
              {user?.name && (
                <div className="text-sm text-text-secondary">{user.email}</div>
              )}
            </div>
          </div>
          <button
            onClick={() => signOut()}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-sidebar-bg transition-colors"
          >
            <SignOut size={18} />
            <span className="text-sm">ログアウト</span>
          </button>
        </div>

        {view === 'list' && (
          <CompanyList
            companies={list.companies}
            error={error ?? list.loadError}
            canCreate={canCreate}
            onSelect={select}
            onCreate={() => setView('create')}
          />
        )}

        {view === 'create' && canCreate && (
          <CreateCompanyForm
            // The first company of a fresh server: its creator may not make another.
            onCreated={company => { list.add(company); select(company); void refreshUser() }}
            onBack={() => setView('list')}
          />
        )}

        {view === 'clone' && selected && (
          <FolderChoice
            company={selected}
            error={error}
            isPreparing={isPreparing}
            onOpenExisting={() => openExistingFolder(selected)}
            onCreateNew={() => setView('openExisting')}
            onBack={() => { setView('list'); setSelected(null); setParentFolder(''); setError(null) }}
          />
        )}

        {view === 'openExisting' && selected && (
          <NewFolderChoice
            company={selected}
            error={error}
            parentFolder={parentFolder}
            isPreparing={isPreparing}
            onPickParent={pickParentFolder}
            onStart={() => { if (parentFolder) void prepare(selected, `${parentFolder}/${selected.name}`, 'openExisting') }}
            onBack={() => { setView('clone'); setParentFolder(''); setError(null) }}
          />
        )}

        {view === 'departments' && selected && picker && (
          <DepartmentPicker
            departments={picker.departments}
            onBack={() => setView(picker.backView)}
            onDownload={folders => startSetup(selected, picker.folder, folders, 'firstSetup')}
          />
        )}

        {view === 'setup' && (
          <SetupProgress
            kind={setup.kind}
            step={setup.step}
            error={setup.error}
            receivedBytes={setup.receivedBytes}
            onBack={() => { setView('clone'); setup.clearError() }}
          />
        )}
      </div>
    </div>
  )
}
