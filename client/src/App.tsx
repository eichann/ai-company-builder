import { useRef, useState, useEffect } from 'react'
import { useAppStore } from './stores/appStore'
import { useAuthStore } from './stores/authStore'
import { SkillCentricLayout } from './components/skill-ui'
import { LoginScreen } from './components/auth/LoginScreen'
import { CompanySelector } from './components/auth/CompanySelector'
import { ServerSetupScreen } from './components/auth/ServerSetupScreen'
import { SpinnerGap } from '@phosphor-icons/react'
import type { Company } from './types'

const LAST_COMPANY_KEY_PREFIX = 'lastCompany:'

function safeReadLastCompany(userId: string): Company | null {
  try {
    const raw = localStorage.getItem(`${LAST_COMPANY_KEY_PREFIX}${userId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.id || !parsed?.rootPath) return null
    return { ...parsed, createdAt: new Date(parsed.createdAt) }
  } catch {
    return null
  }
}

function safeWriteLastCompany(userId: string, company: Company | null): void {
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
    window.electronAPI.getServerUrl().then((url) => {
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
  useEffect(() => {
    if (!user) return
    safeWriteLastCompany(user.id, currentCompany ?? null)
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

    let cancelled = false
    void (async () => {
      try {
        const result = await window.electronAPI.getCompanies()
        if (cancelled || !result?.success || !Array.isArray(result.data)) return
        const stillAccessible = (result.data as Array<{ id: string }>).some((c) => c.id === last.id)
        if (stillAccessible) setCurrentCompany(last)
        else safeWriteLastCompany(user.id, null)
      } catch {
        // Network/IPC failure: keep the persisted entry and let the user pick this time.
      }
    })()
    return () => { cancelled = true }
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
          window.electronAPI.getServerUrl().then(setServerUrl)
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

  return <SkillCentricLayout />
}

export default App
