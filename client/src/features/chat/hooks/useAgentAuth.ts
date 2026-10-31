import { useRef, useState } from 'react'
import type { AuthMode, CodexStatus } from '../../../../shared/agent'
import { getAuthMode, getClaudeCodeStatus, getCodexStatus, isApiKeySaved } from '../api'

/**
 * Which agent the member chose and whether the chat can start with it
 * (checked once on mount, again in the background after the settings close).
 * The sign-in check is per agent on purpose — each brings its own (CLI login,
 * ChatGPT login + live catalog, API key). Codex keeps the chat mounted even
 * when signed out, so drafts survive; the panel explains what is missing.
 */
export function useAgentAuth() {
  const [isReady, setIsReady] = useState(false)
  const [authMode, setAuthMode] = useState<AuthMode>('claude-code')
  const [codexStatus, setCodexStatus] = useState<CodexStatus>({ available: false, authenticated: false, models: [] })
  const [claudeCodeAvailable, setClaudeCodeAvailable] = useState(false)
  const [claudeCodeError, setClaudeCodeError] = useState<string | null>(null)
  const [isChecking, setIsChecking] = useState(true)

  async function checkAuth(background = false) {
    if (!background) setIsChecking(true)
    try {
      const [ccStatus, savedAuthMode, hasApiKey] = await Promise.all([
        getClaudeCodeStatus(),
        getAuthMode(),
        isApiKeySaved(),
      ])

      const ccAvailable = ccStatus.available && ccStatus.authenticated
      setClaudeCodeAvailable(ccAvailable)
      setClaudeCodeError(ccStatus.error)
      setAuthMode(savedAuthMode)

      if (savedAuthMode === 'codex') {
        const status = await getCodexStatus()
        setCodexStatus(status)
        // Keep the chat mounted, including drafts; show actionable auth errors in settings.
        setIsReady(true)
      } else if (savedAuthMode === 'claude-code' && ccAvailable) {
        setIsReady(true)
      } else if (savedAuthMode === 'api-key' && hasApiKey) {
        setIsReady(true)
      } else if (!background) setIsReady(false)
    } finally {
      if (!background) setIsChecking(false)
    }
  }

  // Auth check on mount (during the first render, as before: no extra frame).
  const initializedRef = useRef(false)
  if (!initializedRef.current) {
    initializedRef.current = true
    checkAuth()
  }

  return { isReady, isChecking, authMode, codexStatus, claudeCodeAvailable, claudeCodeError, recheck: () => checkAuth(true) }
}
