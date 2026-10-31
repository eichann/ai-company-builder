import { create } from 'zustand'
import i18n from '../i18n'
import type { CompanyView } from '../types'
import { canRegisterCompanyFolder, registerCompanyFolder } from '../shared/ipc/allowed-folders'
import { MODEL_EFFORT_OPTIONS as EFFORTS_OF_MODEL, resolveSavedEffort, resolveSavedModel, type AIEffort, type AIModel } from '../lib/aiModels'

// Theme type
export type Theme = 'light' | 'dark'

// Language type
export type Language = 'en' | 'ja'

// Models, effort levels and the defaults for members who have not chosen: lib/aiModels.ts.
export type { AIModel, AIEffort } from '../lib/aiModels'
export { MODEL_EFFORT_OPTIONS, MODEL_LABELS, CLAUDE_MODELS } from '../lib/aiModels'

const readSaved = (key: string): string | null => {
  try { return typeof window !== 'undefined' ? localStorage.getItem(key) : null } catch { return null }
}
const getInitialModel = (): AIModel => resolveSavedModel(readSaved('aiModel'))
/**
 * An effort the model does not support (e.g. xhigh on Opus 4.6) becomes 'high', a level every
 * model supports, instead of relying on the CLI's silent fallback.
 */
const effortFor = (model: AIModel, effort: AIEffort): AIEffort => EFFORTS_OF_MODEL[model].includes(effort) ? effort : 'high'
const getInitialEffort = (): AIEffort => effortFor(getInitialModel(), resolveSavedEffort(readSaved('aiEffort')))

// Get initial chat markdown render setting from localStorage (default ON)
const getInitialChatMarkdownRender = (): boolean => {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('chatMarkdownRender')
    if (saved === 'false') return false
    if (saved === 'true') return true
  }
  return true
}

// Get initial language from localStorage or browser settings
const getInitialLanguage = (): Language => {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('language') as Language | null
    if (saved === 'en' || saved === 'ja') {
      return saved
    }
    // Check browser language
    const browserLang = navigator.language.split('-')[0]
    if (browserLang === 'ja') {
      return 'ja'
    }
  }
  return 'ja' // Default to Japanese
}

// Get initial theme from localStorage or system preference
const getInitialTheme = (): Theme => {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('theme') as Theme | null
    if (saved === 'light' || saved === 'dark') {
      return saved
    }
    // Check system preference
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark'
    }
  }
  return 'light'
}

interface AppState {
  // Theme state
  theme: Theme

  // Language state
  language: Language

  // Company state
  currentCompany: CompanyView | null

  // AI model state
  aiModel: AIModel
  aiEffort: AIEffort

  // Chat: render assistant messages as decorated markdown (vs raw text)
  chatMarkdownRender: boolean

  // Actions
  toggleTheme: () => void
  setLanguage: (language: Language) => void
  setAIModel: (model: AIModel) => void
  setAIEffort: (effort: AIEffort) => void
  setCurrentCompany: (company: CompanyView | null) => void
  addCompany: (company: CompanyView) => void

  // Chat markdown rendering toggle
  setChatMarkdownRender: (enabled: boolean) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  theme: getInitialTheme(),
  language: getInitialLanguage(),
  aiModel: getInitialModel(),
  aiEffort: getInitialEffort(),
  currentCompany: null,
  chatMarkdownRender: getInitialChatMarkdownRender(),

  toggleTheme: () => {
    const newTheme = get().theme === 'dark' ? 'light' : 'dark'
    localStorage.setItem('theme', newTheme)
    if (newTheme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
    set({ theme: newTheme })
  },

  setLanguage: (language) => {
    localStorage.setItem('language', language)
    i18n.changeLanguage(language)
    set({ language })
  },

  setAIModel: (model) => {
    localStorage.setItem('aiModel', model)
    const effort = effortFor(model, get().aiEffort)
    if (effort !== get().aiEffort) localStorage.setItem('aiEffort', effort)
    set({ aiModel: model, aiEffort: effort })
  },

  setAIEffort: (effort) => {
    localStorage.setItem('aiEffort', effort)
    set({ aiEffort: effort })
  },

  setCurrentCompany: (company) => {
    if (company?.rootPath && canRegisterCompanyFolder()) {
      registerCompanyFolder(company.rootPath)
    }
    set({ currentCompany: company })
  },

  addCompany: (company) => {
    if (company.rootPath && canRegisterCompanyFolder()) {
      registerCompanyFolder(company.rootPath)
    }
    set({ currentCompany: company })
  },

  setChatMarkdownRender: (enabled) => {
    localStorage.setItem('chatMarkdownRender', String(enabled))
    set({ chatMarkdownRender: enabled })
  },
}))
