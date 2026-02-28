import { create } from 'zustand'

export interface AuthUser {
  id: string
  email: string
  name: string | null
  image: string | null
  emailVerified: boolean
}

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
  signOut: () => Promise<void>
  checkSession: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: false,
  isInitialized: false,

  setUser: (user) => set({ user }),
  setLoading: (isLoading) => set({ isLoading }),
  setInitialized: (isInitialized) => set({ isInitialized }),

  signIn: async (email, password) => {
    set({ isLoading: true })
    try {
      const result = await window.electronAPI.signIn(email, password)
      if (result.success) {
        // Fetch user info after sign in
        const session = await window.electronAPI.getSession()
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
      const result = await window.electronAPI.signUp(email, password, name)
      if (result.success) {
        // Fetch user info after sign up
        const session = await window.electronAPI.getSession()
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
      await window.electronAPI.signOut()
      set({ user: null })
    } finally {
      set({ isLoading: false })
    }
  },

  checkSession: async () => {
    set({ isLoading: true })
    try {
      const session = await window.electronAPI.getSession()
      if (session.success && session.user) {
        set({ user: session.user })
      } else {
        set({ user: null })
      }
    } finally {
      set({ isLoading: false, isInitialized: true })
    }
  },
}))
