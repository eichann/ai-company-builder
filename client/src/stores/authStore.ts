import { create } from 'zustand'
import * as authApi from '../features/auth/api'
import { useAppStore } from './appStore'
import type { AuthUser } from '../../shared/ipc-contract'

interface AuthState {
  user: AuthUser | null
  isLoading: boolean
  isInitialized: boolean

  // Actions
  setUser: (user: AuthUser | null) => void
  setLoading: (loading: boolean) => void
  setInitialized: (initialized: boolean) => void

  // Auth methods
  signIn: (email: string, password: string) => Promise<{ success: boolean; error?: string }>
  signUp: (email: string, password: string, name?: string) => Promise<{ success: boolean; error?: string }>
  /** The one sign-out: the company screen closes and the login screen shows (unsaved tabs are the caller's: useSaveBeforeLeaving). */
  signOut: () => Promise<void>
  checkSession: () => Promise<void>
  /** Re-read the signed-in account without a loading screen (what it may do can change). */
  refreshUser: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isLoading: false,
  isInitialized: false,

  setUser: (user) => set({ user }),
  setLoading: (isLoading) => set({ isLoading }),
  setInitialized: (isInitialized) => set({ isInitialized }),

  signIn: async (email, password) => {
    set({ isLoading: true })
    try {
      const result = await authApi.signIn(email, password)
      if (result.success) {
        // Fetch user info after sign in
        const session = await authApi.getSession()
        if (session.success && session.user) {
          set({ user: session.user })
        }
        return { success: true }
      }
      return { success: false, error: result.error }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      set({ isLoading: false })
    }
  },

  signUp: async (email, password, name) => {
    set({ isLoading: true })
    try {
      const result = await authApi.signUp(email, password, name)
      if (result.success) {
        // Fetch user info after sign up
        const session = await authApi.getSession()
        if (session.success && session.user) {
          set({ user: session.user })
        }
        return { success: true }
      }
      return { success: false, error: result.error }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      set({ isLoading: false })
    }
  },

  signOut: async () => {
    set({ isLoading: true })
    try {
      await authApi.signOut()
      // Close the company first: the next sign-in (maybe another account) starts from its own remembered company.
      useAppStore.getState().setCurrentCompany(null)
      set({ user: null })
    } finally {
      set({ isLoading: false })
    }
  },

  checkSession: async () => {
    set({ isLoading: true })
    try {
      const session = await authApi.getSession()
      if (session.success && session.user) {
        set({ user: session.user })
      } else {
        set({ user: null })
      }
    } finally {
      set({ isLoading: false, isInitialized: true })
    }
  },

  refreshUser: async () => {
    const before = get().user
    const session = await authApi.getSession().catch(() => null)
    // Only the same account, still signed in (a sign-out or another sign-in meanwhile wins).
    if (before && get().user === before && session?.success && session.user?.id === before.id) set({ user: session.user })
  },
}))
