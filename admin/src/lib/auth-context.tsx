'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { toast } from 'sonner'

import { ApiError, authApi, meApi, type User } from './api'

export const SIGN_OUT_FAILED = 'ログアウトできませんでした。通信を確かめて、もう一度押してください。'

interface AuthContextType {
  user: User | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<void>
  /** Signs up (first user, or with an invitation token) and loads the session. */
  signUp: (email: string, password: string, name: string, invitationToken?: string) => Promise<void>
  /**
   * Ends the session. Resolves true when it ended (callers then leave the page); on a failure the
   * session may still be alive on the server, so the user stays signed in here, a message says so,
   * and it resolves false.
   */
  signOut: () => Promise<boolean>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  const loadUser = useCallback(async () => {
    try {
      setUser(await meApi.getMe())
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    meApi.getMe().then(
      (u) => {
        if (active) {
          setUser(u)
          setLoading(false)
        }
      },
      () => {
        if (active) {
          setUser(null)
          setLoading(false)
        }
      }
    )
    return () => {
      active = false
    }
  }, [])

  const signIn = useCallback(
    async (email: string, password: string) => {
      await authApi.signIn(email, password)
      await loadUser()
    },
    [loadUser]
  )

  const signUp = useCallback(
    async (email: string, password: string, name: string, invitationToken?: string) => {
      await authApi.signUp(email, password, name, invitationToken)
      await loadUser()
    },
    [loadUser]
  )

  const signOut = useCallback(async () => {
    try {
      await authApi.signOut()
    } catch (err) {
      // 401 (Better Auth itself answers 200 without a session; a 401 comes from something in front of
      // it): no session for this browser, so it is signed out. Anything
      // else (offline, timeout, 5xx) may have left the session alive for days: showing the console
      // as signed out would let the next person on a shared PC reload straight back in.
      if (!(err instanceof ApiError && err.status === 401)) {
        toast.error(SIGN_OUT_FAILED)
        return false
      }
    }
    setUser(null)
    return true
  }, [])

  const value = useMemo(
    () => ({ user, loading, signIn, signUp, signOut, refresh: loadUser }),
    [user, loading, signIn, signUp, signOut, loadUser]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}
