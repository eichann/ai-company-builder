import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { MagnifyingGlass, X, CircleNotch } from '@phosphor-icons/react'
import { getFileIcon } from './FileIcons'
import { CodeEditor } from './CodeEditor'

interface GrepMatch {
  file: string
  line: number
  text: string
}

interface GroupedResult {
  file: string
  displayPath: string
  matches: { line: number; text: string }[]
}

interface SearchPanelProps {
  rootPath: string
  departmentFolder: string
  inputRef?: React.RefObject<HTMLInputElement>
}

interface SelectedResult {
  filePath: string
  displayPath: string
  line: number
}

/** Loaded file content, tagged with the path it belongs to */
interface LoadedFile {
  path: string
  content: string
}

export function SearchPanel({ rootPath, departmentFolder, inputRef }: SearchPanelProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<GrepMatch[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [selected, setSelected] = useState<SelectedResult | null>(null)
  const [selectCounter, setSelectCounter] = useState(0)
  const [loadedFile, setLoadedFile] = useState<LoadedFile | null>(null)
  const [isLoadingFile, setIsLoadingFile] = useState(false)
  const localInputRef = useRef<HTMLInputElement>(null)
  const effectiveRef = inputRef || localInputRef

  const departmentPath = `${rootPath}/${departmentFolder}`
  const prefix = departmentFolder + '/'

  const handleSearch = useCallback(async () => {
    const trimmed = query.trim()
    if (!trimmed || !rootPath || !departmentFolder) return

    setIsSearching(true)
    setHasSearched(true)
    try {
      const result = await window.electronAPI.gitGrep(rootPath, trimmed, `${departmentFolder}/`)
      if (result.success) {
        setResults(result.results)
      } else {
        setResults([])
      }
    } catch {
      setResults([])
    } finally {
      setIsSearching(false)
    }
  }, [query, rootPath, departmentFolder])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSearch()
    }
    if (e.key === 'Escape') {
      setQuery('')
      setResults([])
      setHasSearched(false)
      setSelected(null)
      setLoadedFile(null)
    }
  }, [handleSearch])

  // Group results by file
  const grouped = useMemo<GroupedResult[]>(() => {
    const map = new Map<string, { line: number; text: string }[]>()
    for (const r of results) {
      const existing = map.get(r.file)
      if (existing) {
        existing.push({ line: r.line, text: r.text })
      } else {
        map.set(r.file, [{ line: r.line, text: r.text }])
      }
    }
    return Array.from(map.entries()).map(([file, matches]) => ({
      file,
      displayPath: file.startsWith(prefix) ? file.slice(prefix.length) : file,
      matches,
    }))
  }, [results, prefix])

  // Load file content when selected file changes
  useEffect(() => {
    if (!selected) return
    // Skip if already loaded for this file
    if (loadedFile?.path === selected.filePath) return

    let cancelled = false
    setIsLoadingFile(true)
    window.electronAPI.readFile(selected.filePath).then(result => {
      if (cancelled) return
      if (result !== null) {
        setLoadedFile({ path: selected.filePath, content: result })
      }
    }).catch(() => {}).finally(() => {
      if (!cancelled) setIsLoadingFile(false)
    })
    return () => { cancelled = true }
  }, [selected?.filePath, loadedFile?.path])

  const handleSelectMatch = useCallback((displayPath: string, line: number) => {
    const filePath = `${departmentPath}/${displayPath}`
    setSelected({ filePath, displayPath, line })
    setSelectCounter(c => c + 1)
  }, [departmentPath])

  // Only render editor when loaded content matches the selected file
  const isContentReady = selected !== null && loadedFile !== null && loadedFile.path === selected.filePath

  return (
    <div className="h-full flex">
      {/* Left: Search input + results */}
      <div className="w-[280px] flex-shrink-0 flex flex-col border-r border-gray-200 dark:border-zinc-800">
        {/* Search input */}
        <div className="flex-shrink-0 px-3 py-3 border-b border-gray-200 dark:border-zinc-800/50">
          <div className="relative">
            <MagnifyingGlass size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-zinc-500" />
            <input
              ref={effectiveRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="文言を検索... (Enter)"
              className="w-full pl-8 pr-8 py-1.5 text-xs rounded-md border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-gray-800 dark:text-zinc-200 placeholder:text-gray-400 dark:placeholder:text-zinc-500 focus:outline-none focus:border-accent"
            />
            {query && (
              <button
                onClick={() => { setQuery(''); setResults([]); setHasSearched(false); setSelected(null); setLoadedFile(null) }}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-400 dark:text-zinc-500"
              >
                <X size={11} />
              </button>
            )}
          </div>
          {hasSearched && !isSearching && (
            <p className="mt-1.5 text-[10px] text-gray-400 dark:text-zinc-500">
              {results.length === 0
                ? '一致する結果がありません'
                : `${grouped.length}ファイル / ${results.length}件`
              }
              {results.length >= 200 && ' (上限200件)'}
            </p>
          )}
        </div>

        {/* Results list */}
        <div className="flex-1 overflow-auto">
          {isSearching ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-gray-400 dark:text-zinc-500">
              <CircleNotch size={14} className="animate-spin" />
              検索中...
            </div>
          ) : !hasSearched ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-400 dark:text-zinc-600 px-4">
              <MagnifyingGlass size={36} className="mb-3 opacity-40" />
              <p className="text-xs text-center">検索ワードを入力して Enter</p>
            </div>
          ) : grouped.length === 0 ? null : (
            <div className="py-1">
              {grouped.map(({ file, displayPath, matches }) => {
                const IC = getFileIcon(file.split('/').pop() || '', false)
                return (
                  <div key={file} className="mb-1">
                    {/* File header */}
                    <div className="flex items-center gap-1.5 px-3 py-1 text-[11px] font-medium text-gray-700 dark:text-zinc-300">
                      <IC size={13} className="flex-shrink-0" />
                      <span className="truncate" title={displayPath}>{displayPath}</span>
                      <span className="text-gray-400 dark:text-zinc-500 flex-shrink-0">({matches.length})</span>
                    </div>
                    {/* Match lines */}
                    {matches.map((m, i) => {
                      const isActive = selected?.filePath === `${departmentPath}/${displayPath}` && selected?.line === m.line
                      return (
                        <button
                          key={i}
                          onClick={() => handleSelectMatch(displayPath, m.line)}
                          className={`w-full text-left flex items-start gap-2 px-3 py-0.5 transition-colors group ${
                            isActive
                              ? 'bg-accent/10 dark:bg-accent/15'
                              : 'hover:bg-gray-100 dark:hover:bg-white/[0.04]'
                          }`}
                        >
                          <span className="text-[10px] text-gray-400 dark:text-zinc-600 font-mono w-8 text-right flex-shrink-0 pt-px">
                            {m.line}
                          </span>
                          <span className={`text-[11px] truncate ${
                            isActive
                              ? 'text-accent dark:text-accent'
                              : 'text-gray-600 dark:text-zinc-400 group-hover:text-gray-800 dark:group-hover:text-zinc-200'
                          }`}>
                            {m.text}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Right: File viewer */}
      <div className="flex-1 min-w-0 flex flex-col">
        {isContentReady ? (
          <>
            <div className="flex-shrink-0 px-3 py-1.5 border-b border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900/50">
              <span className="text-[11px] text-gray-500 dark:text-zinc-400 truncate" title={selected.filePath}>{selected.displayPath}</span>
            </div>
            <div className="flex-1 overflow-hidden">
              <CodeEditor
                key={`search:${selectCounter}`}
                value={loadedFile.content}
                onChange={() => {}}
                fileName={selected.displayPath.split('/').pop() || ''}
                readOnly
                initialLine={selected.line}
              />
            </div>
          </>
        ) : isLoadingFile ? (
          <div className="flex items-center justify-center h-full gap-2 text-xs text-gray-400 dark:text-zinc-500">
            <CircleNotch size={14} className="animate-spin" />
            読み込み中...
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-400 dark:text-zinc-600">
            <p className="text-xs">検索結果をクリックしてプレビュー</p>
          </div>
        )}
      </div>
    </div>
  )
}
