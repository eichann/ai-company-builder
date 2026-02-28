import { useRef, useState, useEffect } from 'react'
import { useAppStore } from './stores/appStore'
import { useAuthStore } from './stores/authStore'
import { SkillCentricLayout } from './components/skill-ui'
import { LoginScreen } from './components/auth/LoginScreen'
import { CompanySelector } from './components/auth/CompanySelector'
import { ServerSetupScreen } from './components/auth/ServerSetupScreen'
import { SpinnerGap } from '@phosphor-icons/react'

function App() {
  // Use individual selectors to prevent unnecessary re-renders
  const currentCompany = useAppStore((s) => s.currentCompany)
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
