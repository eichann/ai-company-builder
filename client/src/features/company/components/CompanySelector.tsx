// Choosing a company and setting its folder up (download-choices.md "First setup").
import { useState } from 'react'
import { SignOut, SpinnerGap } from '@phosphor-icons/react'
import { useAppStore } from '../../../stores/appStore'
import { useAuthStore } from '../../../stores/authStore'
import type { CompanyInfo } from '../../../../shared/ipc-contract'
import { chooseFolder } from '../api'
import { prepareCompanyFolder } from '../folderSetup'
import type { PickableDepartment, SelectorView, SetupKind } from '../model'
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
  const { user, signOut } = useAuthStore()
  const list = useCompanies()
  const setup = useFolderSetup(addCompany)
  const [view, setView] = useState<SelectorView>('list')
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

  if (list.isLoading) {
    return (
      <div className="h-full bg-editor-bg flex items-center justify-center">
        <SpinnerGap size={48} className="animate-spin text-accent" />
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
            onSelect={select}
            onCreate={() => setView('create')}
          />
        )}

        {view === 'create' && (
          <CreateCompanyForm
            onCreated={company => { list.add(company); select(company) }}
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
