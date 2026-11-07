import { useRef, useState, useEffect } from 'react'
import { useAppStore } from './stores/appStore'
import { useAuthStore } from './stores/authStore'
import { AppShell } from './app/AppShell'
import { LoginScreen } from './features/auth/components/LoginScreen'
import { CompanySelector } from './features/company/components/CompanySelector'
import { ServerSetupScreen } from './features/auth/components/ServerSetupScreen'
import { SpinnerGap } from '@phosphor-icons/react'
import type { CompanyView } from './types'
import { LAST_COMPANY_KEY_PREFIX, parseRememberedCompany, rememberCompanyFolder } from './features/company/restore-company'
import { reopenRememberedCompany } from './features/company/reopen'
import { getServerUrl } from './features/auth/api'


function safeReadLastCompany(userId: string): CompanyView | null {
  try {
    return parseRememberedCompany<CompanyView>(localStorage.getItem(`${LAST_COMPANY_KEY_PREFIX}${userId}`))
  } catch {
    return null
  }
}

function safeWriteLastCompany(userId: string, company: CompanyView | null): void {
  try {
    const key = `${LAST_COMPANY_KEY_PREFIX}${userId}`
    if (company) localStorage.setItem(key, JSON.stringify(company))
    else localStorage.removeItem(key)
  } catch {
    // Storage may be unavailable (private mode, quota); fail silently.
  }
}

function App() {
  // Use individual selectors to prevent unnecessary re-renders
  const currentCompany = useAppStore((s) => s.currentCompany)
  const setCurrentCompany = useAppStore((s) => s.setCurrentCompany)
  const theme = useAppStore((s) => s.theme)
  const { user, isLoading, isInitialized, checkSession } = useAuthStore()

  // Server URL state: undefined = loading, null = not set, string = set
  const [serverUrl, setServerUrl] = useState<string | null | undefined>(undefined)

  // Check server URL on mount
  useEffect(() => {
    getServerUrl().then((url) => {
      setServerUrl(url)
    })
  }, [])

  // Apply theme directly during render (DOM side effect but idempotent)
  if (theme === 'dark') {
    document.documentElement.classList.add('dark')
  } else {
    document.documentElement.classList.remove('dark')
  }

  // Check session on first render (only after serverUrl is confirmed)
  const sessionCheckedRef = useRef(false)
  if (!sessionCheckedRef.current && serverUrl) {
    sessionCheckedRef.current = true
    checkSession()
  }

  // Persist the current company so it can be restored on the next login.
  // Stored per-user to avoid bleeding selections across accounts on a shared machine.
  // Skip when currentCompany is null: this effect runs on the same render as
  // the restore effect below, and writing null here would clobber the stored
  // entry before restore can read it. The only legitimate clear path — losing
  // server-side access — is handled explicitly inside the restore effect.
  useEffect(() => {
    if (!user || !currentCompany) return
    safeWriteLastCompany(user.id, currentCompany)
    // Every company opened here, so switching from the title bar can reopen it where it is.
    rememberCompanyFolder(user.id, currentCompany.id, currentCompany)
  }, [user, currentCompany])

  // Restore the previously selected company after login. Runs once per
  // authenticated session. Falls through to <CompanySelector /> on any failure:
  // no persisted entry, server-side access revoked, or any IPC/parse error.
  // The server-scoped /api/companies response is used to confirm the user still
  // has access before trusting the locally-persisted rootPath/departments.
  const restorationStateRef = useRef<{ userId: string | null; attempted: boolean }>({
    userId: null,
    attempted: false,
  })
  useEffect(() => {
    if (!user) {
      restorationStateRef.current = { userId: null, attempted: false }
      return
    }
    if (restorationStateRef.current.userId !== user.id) {
      restorationStateRef.current = { userId: user.id, attempted: false }
    }
    if (currentCompany || restorationStateRef.current.attempted) return
    restorationStateRef.current.attempted = true

    const last = safeReadLastCompany(user.id)
    if (!last) return

    const userId = user.id
    void (async () => {
      // features/company/reopen.ts: the remembered folder's checks and the kind the server answers.
      const { outcome, company } = await reopenRememberedCompany(last)
      // Not cancelled by this effect re-running (restore is attempted once per
      // session, so a cancelled attempt would never be retried): only a
      // company picked meanwhile or another account wins.
      if (useAppStore.getState().currentCompany || useAuthStore.getState().user?.id !== userId) return
      if (outcome === 'open') setCurrentCompany(company)
      else if (outcome === 'forget') safeWriteLastCompany(userId, null)
    })()
  }, [user, currentCompany, setCurrentCompany])

  // Show loading spinner while checking server URL
  if (serverUrl === undefined) {
    return (
      <div className="h-full bg-editor-bg flex items-center justify-center">
        <SpinnerGap size={48} className="animate-spin text-accent" />
      </div>
    )
  }

  // Show server setup screen if no URL configured
  if (!serverUrl) {
    return (
      <ServerSetupScreen
        onComplete={() => {
          getServerUrl().then(setServerUrl)
        }}
      />
    )
  }

  // Show loading spinner while checking session
  if (!isInitialized || isLoading) {
    return (
      <div className="h-full bg-editor-bg flex items-center justify-center">
        <SpinnerGap size={48} className="animate-spin text-accent" />
      </div>
    )
  }

  // Show login screen if not authenticated
  if (!user) {
    return <LoginScreen />
  }

  // Show company selector if no company selected
  if (!currentCompany) {
    return <CompanySelector />
  }

  // A fresh screen per company: nothing of the last company's screen stays mounted.
  return <AppShell key={currentCompany.id} />
}

export default App
