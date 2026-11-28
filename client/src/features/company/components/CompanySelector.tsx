// Choosing a company and setting its folder up (download-choices.md "First setup"). The PC's
// layout is not asked up front (UX review 20): the place is decided automatically
// (~/AI Company Builder/<会社名>), the departments are the member's 所属, and the member confirms
// both once on the join screen with ［始める］. The only company skips the list but still waits
// for that press. A refused place (another company's folder, the member's own files) says why on
// the join screen and nothing is set up until another place is chosen.
import { useRef, useState } from 'react'
import { SignOut, SpinnerGap } from '@phosphor-icons/react'
import { useAppStore } from '../../../stores/appStore'
import { useAuthStore } from '../../../stores/authStore'
import type { CompanyInfo } from '../../../../shared/ipc-contract'
import { chooseFolder, getCompanyServer, getDefaultParentFolder } from '../api'
import { checkCompanyPlace, openCompanyWithoutFolder } from '../folderSetup'
import {
  companyToJoinWithoutChoosing, firstDepartmentChoice, joinStart, needsDepartmentChoice, offersCompanyCreation, samePlaceCheck,
  type DepartmentChoice, type PlaceCheck, type SelectorView, type SetupKind,
} from '../model'
import { hasRememberedCompany } from '../restore-company'
import { useCompanies } from '../hooks/useCompanies'
import { useFolderSetup } from '../hooks/useFolderSetup'
import { CompanyList } from './CompanyList'
import { CreateCompanyForm } from './CreateCompanyForm'
import { DepartmentPicker } from './DepartmentPicker'
import { JoinScreen, type JoinPlace } from './JoinScreen'
import { SetupProgress } from './SetupProgress'

function hostOf(server: string | null): string | null {
  if (!server) return null
  try { return new URL(server).host } catch { return null }
}

export function CompanySelector() {
  const addCompany = useAppStore(s => s.addCompany)
  const { user, signOut, refreshUser } = useAuthStore()
  const canCreate = offersCompanyCreation(user)
  const list = useCompanies(companies => {
    // Switched to from the title bar, not known on this computer yet: its join screen.
    const chosen = companies.find(c => c.id === useAppStore.getState().companyToChoose)
    if (chosen) { void beginJoin(chosen); return }
    const only = user ? companyToJoinWithoutChoosing(companies, hasRememberedCompany(user.id)) : null
    if (only) void beginJoin(only)
  })
  const setup = useFolderSetup(addCompany)
  const [view, setView] = useState<SelectorView>('list')
  const [selected, setSelected] = useState<CompanyInfo | null>(null)
  const [host, setHost] = useState<string | null>(null)
  const [place, setPlace] = useState<JoinPlace | null>(null)
  const [check, setCheck] = useState<PlaceCheck | null>(null)
  const [choice, setChoice] = useState<DepartmentChoice>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Only the latest company's and place's answer counts (a slow check of an earlier one is dropped).
  const checkRun = useRef(0)

  async function checkPlace(company: CompanyInfo, next: JoinPlace | null, keptChoice: DepartmentChoice) {
    const run = ++checkRun.current
    setPlace(next)
    setCheck(null)
    if (!next) return
    const checked = await checkCompanyPlace(company, next.path)
    if (run !== checkRun.current) return
    setCheck(checked)
    const nextChoice = keptChoice ?? firstDepartmentChoice(checked)
    setChoice(nextChoice)
    // No 所属 known: the departments are asked first, then the join screen.
    if (needsDepartmentChoice(checked, nextChoice)) setView('departments')
  }

  // The join screen with the automatic place; nothing is put on this PC before ［始める］.
  async function beginJoin(company: CompanyInfo) {
    const run = ++checkRun.current
    setSelected(company)
    setChoice(null)
    setError(null)
    setView('join')
    setBusy(true)
    try {
      const [server, parent] = await Promise.all([
        getCompanyServer().catch(() => null),
        getDefaultParentFolder().catch(() => null),
      ])
      if (run !== checkRun.current) return
      setHost(hostOf(server))
      const automatic = parent?.success && parent.folder ? { path: `${parent.folder}/${company.name}`, automatic: true } : null
      await checkPlace(company, automatic, null)
    } finally {
      setBusy(false)
    }
  }

  // 「置き場所を変えたいとき」: a new folder inside a picked one, or a folder the company already has here.
  async function changePlace(how: 'new' | 'existing') {
    if (!selected) return
    const picked = await chooseFolder()
    if (!picked) return
    setError(null)
    await checkPlace(selected, { path: how === 'new' ? `${picked}/${selected.name}` : picked, automatic: false }, choice)
  }

  async function startJoin() {
    if (!selected || !place || !check) return
    const start = joinStart(check, choice)
    if (!start) return
    setError(null)
    setBusy(true)
    try {
      if (start.kind === 'working') {
        const opened = await openCompanyWithoutFolder(selected, place.path)
        if ('error' in opened) setError(opened.error)
        else addCompany(opened.company)
        return
      }
      // The screen may have been open a while: the place is asked again, and anything other than
      // what the member confirmed (an existing folder emptied, files put in) is shown, not set up.
      const run = ++checkRun.current
      const again = await checkCompanyPlace(selected, place.path)
      if (run !== checkRun.current) return
      if (!samePlaceCheck(check, again)) {
        setCheck(again)
        setError('置き場所の様子が変わりました。内容をもう一度確かめてください。')
        if (needsDepartmentChoice(again, choice)) setView('departments')
        return
      }
      startSetup(selected, place.path, start.folders, start.kind)
    } finally {
      setBusy(false)
    }
  }

  function startSetup(company: CompanyInfo, companyPath: string, folders: string[], kind: SetupKind) {
    setView('setup')
    void setup.run(company, companyPath, folders, kind)
  }

  function backToList() {
    checkRun.current++
    setView('list')
    setSelected(null)
    setPlace(null)
    setCheck(null)
    setError(null)
  }

  if (list.isLoading) {
    return (
      <div className="h-full bg-[var(--color-surface)] flex items-center justify-center">
        <SpinnerGap size={48} className="animate-spin text-primary" />
      </div>
    )
  }

  return (
    <div className="h-full bg-[var(--color-surface)] flex items-center justify-center overflow-y-auto">
      <div className="w-full max-w-xl p-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-selected-bg-hover flex items-center justify-center">
              <span className="text-selected-text font-medium">
                {user?.name?.[0] || user?.email?.[0] || '?'}
              </span>
            </div>
            <div>
              <div className="text-text font-medium">
                {user?.name || user?.email}
              </div>
              {user?.name && (
                <div className="text-sm text-text-muted">{user.email}</div>
              )}
            </div>
          </div>
          <button
            onClick={() => signOut()}
            className="flex items-center gap-2 px-3 py-2 rounded-control text-text-muted hover:text-text hover:bg-bg transition-colors"
          >
            <SignOut size={18} />
            <span className="text-sm">ログアウト</span>
          </button>
        </div>

        {view === 'list' && (
          <CompanyList
            companies={list.companies}
            error={list.loadError}
            canCreate={canCreate}
            onSelect={company => void beginJoin(company)}
            onCreate={() => setView('create')}
          />
        )}

        {view === 'create' && canCreate && (
          <CreateCompanyForm
            // The first company of a fresh server: its creator may not make another.
            onCreated={company => { list.add(company); void beginJoin(company); void refreshUser() }}
            onBack={() => setView('list')}
          />
        )}

        {view === 'join' && selected && (
          <JoinScreen
            company={selected}
            host={host}
            place={place}
            check={check}
            choice={choice}
            error={error}
            busy={busy}
            onChangeDepartments={() => setView('departments')}
            onChangePlace={how => void changePlace(how)}
            onStart={() => void startJoin()}
            onBack={backToList}
          />
        )}

        {view === 'departments' && selected && check?.kind === 'firstSetup' && (
          <DepartmentPicker
            departments={check.departments}
            initial={choice}
            onBack={() => setView('join')}
            onChoose={folders => { setChoice(folders); setView('join') }}
          />
        )}

        {view === 'setup' && (
          <SetupProgress
            kind={setup.kind}
            step={setup.step}
            error={setup.error}
            receivedBytes={setup.receivedBytes}
            // Back to the same join screen; the place is checked again (the failed setup may have left it different).
            onBack={() => {
              setup.clearError()
              setView('join')
              if (selected) void checkPlace(selected, place, choice)
            }}
          />
        )}
      </div>
    </div>
  )
}
