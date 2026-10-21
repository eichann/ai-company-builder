'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { authApi, meApi, type User } from './api'

interface AuthContextType {
  user: User | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<void>
  /** Signs up (first user, or with an invitation token) and loads the session. */
  signUp: (email: string, password: string, name: string, invitationToken?: string) => Promise<void>
  signOut: () => Promise<void>
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
    } finally {
      setUser(null)
    }
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
