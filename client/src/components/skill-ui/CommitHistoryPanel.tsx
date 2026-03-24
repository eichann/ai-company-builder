import { useState, useEffect, useCallback } from 'react'
import {
  ClockCounterClockwise,
  CaretRight,
  CaretDown,
  User,
  FilePlus,
  PencilSimple,
  Trash,
  CircleNotch,
} from '@phosphor-icons/react'

interface Commit {
  hash: string
  hashShort: string
  message: string
  author: string
  date: string
}

interface CommitFile {
  status: string // A, M, D
  path: string
}

interface CommitHistoryPanelProps {
  rootPath: string
  departmentFolder: string
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) {
    return `今日 ${date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`
  }
  if (diffDays === 1) {
    return `昨日 ${date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`
  }
  if (diffDays < 7) {
    return `${diffDays}日前`
  }
  return date.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' })
}

function FileStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'A':
      return <FilePlus size={12} className="text-green-500 flex-shrink-0" />
    case 'M':
      return <PencilSimple size={12} className="text-amber-500 flex-shrink-0" />
    case 'D':
      return <Trash size={12} className="text-red-400 flex-shrink-0" />
    default:
      return <PencilSimple size={12} className="text-gray-400 flex-shrink-0" />
  }
}

export function CommitHistoryPanel({ rootPath, departmentFolder }: CommitHistoryPanelProps) {
  const [commits, setCommits] = useState<Commit[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null)
  const [commitFiles, setCommitFiles] = useState<Map<string, CommitFile[]>>(new Map())
  const [loadingFiles, setLoadingFiles] = useState<string | null>(null)

  const loadCommits = useCallback(async () => {
    if (!rootPath || !departmentFolder) return
    setIsLoading(true)
    try {
      const result = await window.electronAPI.gitLog(rootPath, `${departmentFolder}/`, 50)
      if (result.success) {
        setCommits(result.commits)
      }
    } catch (err) {
      console.error('Failed to load commits:', err)
    } finally {
      setIsLoading(false)
    }
  }, [rootPath, departmentFolder])

  useEffect(() => {
    loadCommits()
  }, [loadCommits])

  const toggleCommit = useCallback(async (hash: string) => {
    if (expandedCommit === hash) {
      setExpandedCommit(null)
      return
    }
    setExpandedCommit(hash)

    // Load files if not cached
    if (!commitFiles.has(hash)) {
      setLoadingFiles(hash)
      try {
        const result = await window.electronAPI.gitShowCommit(rootPath, hash, `${departmentFolder}/`)
        if (result.success) {
          setCommitFiles(prev => new Map(prev).set(hash, result.files))
        }
      } catch (err) {
        console.error('Failed to load commit files:', err)
      } finally {
        setLoadingFiles(null)
      }
    }
  }, [expandedCommit, commitFiles, rootPath, departmentFolder])

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400 dark:text-zinc-500">
        <CircleNotch size={20} className="animate-spin mr-2" />
        <span className="text-sm">読み込み中...</span>
      </div>
    )
  }

  if (commits.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-gray-400 dark:text-zinc-600">
        <ClockCounterClockwise size={48} className="mb-4 opacity-50" />
        <p className="text-sm">コミット履歴はありません</p>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto">
      <div className="divide-y divide-gray-100 dark:divide-zinc-800/50">
        {commits.map((commit) => {
          const isExpanded = expandedCommit === commit.hash
          const files = commitFiles.get(commit.hash)
          const isLoadingThis = loadingFiles === commit.hash

          return (
            <div key={commit.hash}>
              <button
                onClick={() => toggleCommit(commit.hash)}
                className="w-full text-left px-4 py-3 hover:bg-gray-50 dark:hover:bg-zinc-800/30 transition-colors"
              >
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 flex-shrink-0 text-gray-400 dark:text-zinc-500">
                    {isExpanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] text-gray-800 dark:text-zinc-200 leading-snug truncate">
                      {commit.message}
                    </p>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="flex items-center gap-1 text-[11px] text-gray-400 dark:text-zinc-500">
                        <User size={10} />
                        {commit.author}
                      </span>
                      <span className="text-[11px] text-gray-400 dark:text-zinc-500">
                        {formatDate(commit.date)}
                      </span>
                      <span className="text-[10px] font-mono text-gray-300 dark:text-zinc-600">
                        {commit.hashShort}
                      </span>
                    </div>
                  </div>
                </div>
              </button>

              {/* Expanded file list */}
              {isExpanded && (
                <div className="px-4 pb-3 pl-9">
                  {isLoadingThis ? (
                    <div className="flex items-center gap-1.5 text-[11px] text-gray-400 dark:text-zinc-500 py-1">
                      <CircleNotch size={10} className="animate-spin" />
                      読み込み中...
                    </div>
                  ) : files && files.length > 0 ? (
                    <div className="space-y-0.5">
                      {files.map((file, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-1.5 text-[11px] py-0.5"
                        >
                          <FileStatusIcon status={file.status} />
                          <span className="text-gray-600 dark:text-zinc-400 truncate">
                            {file.path}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] text-gray-400 dark:text-zinc-500 py-1">
                      変更ファイルなし
                    </p>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
