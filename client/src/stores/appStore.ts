import { create } from 'zustand'
import i18n from '../i18n'
import type { FileEntry, Company, Skill } from '../types'

// Theme type
export type Theme = 'light' | 'dark'

// Language type
export type Language = 'en' | 'ja'

// Active skill with loaded content
interface ActiveSkill {
  skill: Skill
  skillMdContent: string
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
  currentCompany: Company | null
  companies: Company[]

  // File explorer state
  fileTree: FileEntry[]
  selectedFile: FileEntry | null
  expandedPaths: Set<string>
  showDotFiles: boolean
  fileTreeRefreshTrigger: number

  // Editor state
  openFiles: FileEntry[]
  activeFile: FileEntry | null
  fileContents: Map<string, string>

  // UI state
  showWizard: boolean
  sidebarWidth: number
  chatPanelWidth: number

  // Skill execution state
  activeSkill: ActiveSkill | null

  // Actions
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  setLanguage: (language: Language) => void
  setCurrentCompany: (company: Company | null) => void
  addCompany: (company: Company) => void
  setFileTree: (tree: FileEntry[]) => void
  setSelectedFile: (file: FileEntry | null) => void
  toggleExpanded: (path: string) => void
  openFile: (file: FileEntry) => void
  closeFile: (path: string) => void
  setActiveFile: (file: FileEntry | null) => void
  setFileContent: (path: string, content: string) => void
  setShowWizard: (show: boolean) => void
  setSidebarWidth: (width: number) => void
  setChatPanelWidth: (width: number) => void

  // File explorer actions
  setShowDotFiles: (show: boolean) => void
  triggerFileTreeRefresh: () => void
  removeFileTreeEntry: (path: string) => void
  addFileTreeEntry: (parentPath: string, entry: FileEntry) => void
  updateFileTreeEntry: (path: string, updates: Partial<FileEntry>) => void

  // Skill execution actions
  setActiveSkill: (skill: Skill, skillMdContent: string) => void
  clearActiveSkill: () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  theme: getInitialTheme(),
  language: getInitialLanguage(),
  currentCompany: null,
  companies: [],
  fileTree: [],
  selectedFile: null,
  expandedPaths: new Set(),
  showDotFiles: false,
  fileTreeRefreshTrigger: 0,
  openFiles: [],
  activeFile: null,
  fileContents: new Map(),
  showWizard: true,
  sidebarWidth: 260,
  chatPanelWidth: 360,
  activeSkill: null,

  setTheme: (theme) => {
    localStorage.setItem('theme', theme)
    // Apply to document root for Tailwind dark mode
    if (theme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
    set({ theme })
  },

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

  setCurrentCompany: (company) => {
    if (company?.rootPath && window.electronAPI?.registerAllowedRoot) {
      window.electronAPI.registerAllowedRoot(company.rootPath)
    }
    set({ currentCompany: company })
  },

  addCompany: (company) => {
    if (company.rootPath && window.electronAPI?.registerAllowedRoot) {
      window.electronAPI.registerAllowedRoot(company.rootPath)
    }
    set((state) => ({
      companies: [...state.companies, company],
      currentCompany: company,
      showWizard: false,
    }))
  },

  setFileTree: (tree) => set({ fileTree: tree }),

  setSelectedFile: (file) => set({ selectedFile: file }),

  toggleExpanded: (path) => set((state) => {
    const newExpanded = new Set(state.expandedPaths)
    if (newExpanded.has(path)) {
      newExpanded.delete(path)
    } else {
      newExpanded.add(path)
    }
    return { expandedPaths: newExpanded }
  }),

  openFile: (file) => set((state) => {
    if (file.isDirectory) return state
    const exists = state.openFiles.some(f => f.path === file.path)
    if (exists) {
      return { activeFile: file }
    }
    return {
      openFiles: [...state.openFiles, file],
      activeFile: file,
    }
  }),

  closeFile: (path) => set((state) => {
    const newOpenFiles = state.openFiles.filter(f => f.path !== path)
    const newActive = state.activeFile?.path === path
      ? newOpenFiles[newOpenFiles.length - 1] || null
      : state.activeFile
    return {
      openFiles: newOpenFiles,
      activeFile: newActive,
    }
  }),

  setActiveFile: (file) => set({ activeFile: file }),

  setFileContent: (path, content) => set((state) => {
    const newContents = new Map(state.fileContents)
    newContents.set(path, content)
    return { fileContents: newContents }
  }),

  setShowWizard: (show) => set({ showWizard: show }),

  setSidebarWidth: (width) => set({ sidebarWidth: width }),

  setChatPanelWidth: (width) => set({ chatPanelWidth: width }),

  setShowDotFiles: (show) => set({ showDotFiles: show }),

  triggerFileTreeRefresh: () => set((state) => ({
    fileTreeRefreshTrigger: state.fileTreeRefreshTrigger + 1,
  })),

  removeFileTreeEntry: (path) => set((state) => {
    const removeEntry = (entries: FileEntry[]): FileEntry[] => {
      return entries
        .filter((entry) => entry.path !== path)
        .map((entry) => {
          if (entry.children) {
            return { ...entry, children: removeEntry(entry.children) }
          }
          return entry
        })
    }
    // Also close the file if it's open
    const newOpenFiles = state.openFiles.filter((f) => f.path !== path)
    const newActive =
      state.activeFile?.path === path
        ? newOpenFiles[newOpenFiles.length - 1] || null
        : state.activeFile

    return {
      fileTree: removeEntry(state.fileTree),
      openFiles: newOpenFiles,
      activeFile: newActive,
    }
  }),

  addFileTreeEntry: (parentPath, entry) => set((state) => {
    // If parentPath is empty or matches root, add to top level
    if (!parentPath || parentPath === state.currentCompany?.rootPath) {
      return { fileTree: [...state.fileTree, entry] }
    }

    const addEntry = (entries: FileEntry[]): FileEntry[] => {
      return entries.map((e) => {
        if (e.path === parentPath && e.isDirectory) {
          const children = e.children || []
          return { ...e, children: [...children, entry] }
        }
        if (e.children) {
          return { ...e, children: addEntry(e.children) }
        }
        return e
      })
    }
    return { fileTree: addEntry(state.fileTree) }
  }),

  updateFileTreeEntry: (path, updates) => set((state) => {
    const updateEntry = (entries: FileEntry[]): FileEntry[] => {
      return entries.map((entry) => {
        if (entry.path === path) {
          return { ...entry, ...updates }
        }
        if (entry.children) {
          return { ...entry, children: updateEntry(entry.children) }
        }
        return entry
      })
    }
    return { fileTree: updateEntry(state.fileTree) }
  }),

  setActiveSkill: (skill, skillMdContent) => set({
    activeSkill: { skill, skillMdContent },
  }),

  clearActiveSkill: () => set({ activeSkill: null }),
}))
