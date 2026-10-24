// Signing in to the ACB server and the server calls the renderer makes
// directly. The session (cookies) stays in the main process (services/session.ts).
//   auth:signUp, auth:signIn, auth:signOut, auth:getSession,
//   api:getCompanies, api:createCompany, api:getDepartments

import type { IpcRegistrar } from '../../ipc/registrar'
import type { Session } from '../../services/session'

export interface AuthDeps {
  session: Session
  /** The server's base URL ('' when not configured). */
  serverUrl: () => string
  /** After sign-out (also offline): drop everything cached for the old session. */
  onSignedOut: () => void
}

function extractResponseMessageFromJson(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>
  const message = record.message
  const error = record.error
  if (typeof message === 'string' && message) return message
  if (typeof error === 'string' && error) return error
  return undefined
}

export function registerAuthIpc(ipc: IpcRegistrar, { session, serverUrl, onSignedOut }: AuthDeps): void {
  async function parseJsonResponseSafe(response: Response): Promise<{
    json: unknown | null
    nonJsonError?: string
  }> {
    const text = await response.text()
    if (!text) {
      return { json: null }
    }

    try {
      return { json: JSON.parse(text) }
    } catch {
      const preview = text.replace(/\s+/g, ' ').slice(0, 120)
      return {
        json: null,
        nonJsonError: `API returned non-JSON response (status ${response.status}) from ${serverUrl()}. Preview: ${preview}`,
      }
    }
  }

  // Auth API handlers
  ipc.handle('auth:signUp', async (_, email: string, password: string, name?: string) => {
    try {
      const response = await fetch(`${serverUrl()}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'app://',
        },
        body: JSON.stringify({ email, password, name: name || email.split('@')[0] }),
      })

      // Store cookies from response
      session.update(response.headers.getSetCookie())

      const { json, nonJsonError } = await parseJsonResponseSafe(response)
      if (nonJsonError) {
        return { success: false, error: nonJsonError }
      }

      const data = json as Record<string, unknown> | null
      if (!response.ok) {
        return { success: false, error: extractResponseMessageFromJson(data) || 'Sign up failed' }
      }
      return { success: true, data }
    } catch (error) {
      console.error('Sign up error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  ipc.handle('auth:signIn', async (_, email: string, password: string) => {
    try {
      const response = await fetch(`${serverUrl()}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'app://',
        },
        body: JSON.stringify({ email, password }),
      })

      // Store cookies from response
      session.update(response.headers.getSetCookie())

      const { json, nonJsonError } = await parseJsonResponseSafe(response)
      if (nonJsonError) {
        return { success: false, error: nonJsonError }
      }

      const data = json as Record<string, unknown> | null
      if (!response.ok) {
        return { success: false, error: extractResponseMessageFromJson(data) || 'Sign in failed' }
      }
      return { success: true, data }
    } catch (error) {
      console.error('Sign in error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  ipc.handle('auth:signOut', async () => {
    try {
      await fetch(`${serverUrl()}/api/auth/sign-out`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'app://',
          'Cookie': session.cookies().join('; '),
        },
      })
      return { success: true }
    } catch (error) {
      console.error('Sign out error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      // Signed out on this computer even when the server cannot be told
      // (offline): nothing here may keep using the old session.
      session.clear()
      onSignedOut()
    }
  })

  ipc.handle('auth:getSession', async () => {
    try {
      if (session.cookies().length === 0) {
        return { success: false, user: null }
      }

      const response = await fetch(`${serverUrl()}/api/me`, {
        headers: {
          'Cookie': session.cookies().join('; '),
        },
      })

      if (!response.ok) {
        return { success: false, user: null }
      }

      const data = await response.json()
      if (data.success && data.data) {
        return { success: true, user: data.data }
      }
      return { success: false, user: null }
    } catch (error) {
      console.error('Get session error:', error)
      return { success: false, user: null }
    }
  })

  // Companies API handlers
  ipc.handle('api:getCompanies', async () => {
    try {
      const response = await fetch(`${serverUrl()}/api/companies`, {
        headers: {
          'Cookie': session.cookies().join('; '),
        },
      })

      const data = await response.json()
      if (!response.ok) {
        return { success: false, error: data.error || 'Failed to fetch companies' }
      }
      return data
    } catch (error) {
      console.error('Get companies error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  ipc.handle('api:createCompany', async (_, name: string) => {
    try {
      const response = await fetch(`${serverUrl()}/api/companies`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': session.cookies().join('; '),
        },
        body: JSON.stringify({ name }),
      })

      const data = await response.json()
      if (!response.ok) {
        return { success: false, error: data.error || 'Failed to create company' }
      }
      return data
    } catch (error) {
      console.error('Create company error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  ipc.handle('api:getDepartments', async (_, companyId: string) => {
    try {
      const response = await fetch(`${serverUrl()}/api/companies/${encodeURIComponent(companyId)}/departments`, {
        headers: {
          'Cookie': session.cookies().join('; '),
        },
      })

      const data = await response.json()
      if (!response.ok) {
        return { success: false, error: data.error || 'Failed to fetch departments' }
      }
      return data
    } catch (error) {
      console.error('Get departments error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })
}
