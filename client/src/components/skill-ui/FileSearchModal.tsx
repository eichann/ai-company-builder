import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { MagnifyingGlass, X } from '@phosphor-icons/react'
import { getFileIcon } from './FileIcons'

interface FileSearchModalProps {
  isOpen: boolean
  onClose: () => void
  rootPath: string
  departmentFolder: string
  onSelectFile: (filePath: string) => void
}

export function FileSearchModal({ isOpen, onClose, rootPath, departmentFolder, onSelectFile }: FileSearchModalProps) {
  const [query, setQuery] = useState('')
  const [allFiles, setAllFiles] = useState<string[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const prefix = departmentFolder + '/'

  // Load file list when modal opens
  useEffect(() => {
    if (!isOpen || !rootPath || !departmentFolder) return
    window.electronAPI.gitListFiles(rootPath, `${departmentFolder}/`).then(result => {
      if (result.success) setAllFiles(result.files)
    }).catch(() => {})
  }, [isOpen, rootPath, departmentFolder])

  // Focus input when modal opens
  useEffect(() => {
    if (isOpen) {
      setQuery('')
      setSelectedIndex(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [isOpen])

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [isOpen, onClose])

  // Filter files by query
  const filtered = useMemo(() => {
    if (!query.trim()) return allFiles.slice(0, 100)
    const q = query.toLowerCase()
    const results: string[] = []
    for (const f of allFiles) {
      if (f.toLowerCase().includes(q)) {
        results.push(f)
        if (results.length >= 100) break
      }
    }
    return results
  }, [query, allFiles])

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0)
  }, [filtered])

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const item = list.children[selectedIndex] as HTMLElement | undefined
    if (item) item.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleSelect = useCallback((filePath: string) => {
    const fullPath = `${rootPath}/${filePath}`
    onSelectFile(fullPath)
    onClose()
  }, [rootPath, onSelectFile, onClose])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(i => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered[selectedIndex]) handleSelect(filtered[selectedIndex])
    }
  }, [filtered, selectedIndex, handleSelect])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div
        className="w-full max-w-xl bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 rounded-lg shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-zinc-800">
          <MagnifyingGlass size={16} className="text-gray-400 dark:text-zinc-500 flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="ファイル名で検索..."
            className="flex-1 text-sm bg-transparent text-gray-800 dark:text-zinc-200 placeholder:text-gray-400 dark:placeholder:text-zinc-500 focus:outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-400 dark:text-zinc-500"
            >
              <X size={12} />
            </button>
          )}
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[50vh] overflow-auto">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-gray-400 dark:text-zinc-500">
              {query ? '一致するファイルがありません' : 'ファイルがありません'}
            </div>
          ) : (
            filtered.map((file, i) => {
              const displayPath = file.startsWith(prefix) ? file.slice(prefix.length) : file
              const fileName = file.split('/').pop() || ''
              const IC = getFileIcon(fileName, false)
              const isSelected = i === selectedIndex
              return (
                <div
                  key={file}
                  onClick={() => handleSelect(file)}
                  onMouseEnter={() => setSelectedIndex(i)}
                  className={`flex items-center gap-2 px-4 py-1.5 cursor-pointer text-sm ${
                    isSelected
                      ? 'bg-accent/10 dark:bg-accent/15 text-gray-900 dark:text-zinc-100'
                      : 'text-gray-700 dark:text-zinc-300 hover:bg-gray-50 dark:hover:bg-zinc-800/50'
                  }`}
                >
                  <IC size={15} className="flex-shrink-0" />
                  <span className="truncate">{displayPath}</span>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
