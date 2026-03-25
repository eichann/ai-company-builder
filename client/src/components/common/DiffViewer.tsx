import { useState, useEffect, useRef, useCallback } from 'react'
import { SpinnerGap, X } from '@phosphor-icons/react'

// --- Types ---

interface DiffViewerBaseProps {
  rootPath: string
  filePath: string
}

interface StagedDiffProps extends DiffViewerBaseProps {
  mode: 'staged'
  fileStatus: 'added' | 'modified' | 'deleted'
}

interface CommitDiffProps extends DiffViewerBaseProps {
  mode: 'commit'
  commitHash: string
}

type DiffViewerProps = StagedDiffProps | CommitDiffProps

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header'
  content: string
  oldLineNo?: number
  newLineNo?: number
}

interface SplitRow {
  left: { lineNo?: number; content: string; type: 'remove' | 'context' | 'empty' }
  right: { lineNo?: number; content: string; type: 'add' | 'context' | 'empty' }
}

// --- Diff Modal (exported for use in SyncPreviewDialog / CommitHistoryPanel) ---

interface DiffModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  diffProps: DiffViewerProps
}

export function DiffModal({ isOpen, onClose, title, diffProps }: DiffModalProps) {
  useEffect(() => {
    if (!isOpen) return
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[95vw] max-w-[1400px] h-[85vh] flex flex-col bg-sidebar-bg border border-border rounded-xl shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-activitybar-bg/50">
          <h3 className="text-sm font-medium text-text-primary truncate">{title}</h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-activitybar-bg text-text-secondary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Split Diff Content */}
        <div className="flex-1 overflow-hidden">
          <DiffViewer {...diffProps} />
        </div>
      </div>
    </div>
  )
}

// --- Parsing ---

function parseDiff(diff: string, isNewFile?: boolean, isDeletedFile?: boolean): DiffLine[] {
  if (isNewFile || isDeletedFile) {
    const type = isNewFile ? 'add' : 'remove'
    return diff.split('\n').map((line, i) => ({
      type: type as 'add' | 'remove',
      content: line,
      oldLineNo: isDeletedFile ? i + 1 : undefined,
      newLineNo: isNewFile ? i + 1 : undefined,
    }))
  }

  const lines = diff.split('\n')
  const result: DiffLine[] = []
  let oldLine = 0
  let newLine = 0

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) {
        oldLine = parseInt(match[1]) - 1
        newLine = parseInt(match[2]) - 1
      }
      result.push({ type: 'header', content: line })
    } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      continue
    } else if (line.startsWith('+')) {
      newLine++
      result.push({ type: 'add', content: line.slice(1), newLineNo: newLine })
    } else if (line.startsWith('-')) {
      oldLine++
      result.push({ type: 'remove', content: line.slice(1), oldLineNo: oldLine })
    } else if (line.startsWith(' ')) {
      oldLine++
      newLine++
      result.push({ type: 'context', content: line.slice(1), oldLineNo: oldLine, newLineNo: newLine })
    }
  }

  return result
}

function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.type === 'header') {
      i++
      continue
    }

    if (line.type === 'context') {
      rows.push({
        left: { lineNo: line.oldLineNo, content: line.content, type: 'context' },
        right: { lineNo: line.newLineNo, content: line.content, type: 'context' },
      })
      i++
      continue
    }

    // Collect consecutive removes and adds to pair them
    const removes: DiffLine[] = []
    const adds: DiffLine[] = []

    while (i < lines.length && lines[i].type === 'remove') {
      removes.push(lines[i])
      i++
    }
    while (i < lines.length && lines[i].type === 'add') {
      adds.push(lines[i])
      i++
    }

    const maxLen = Math.max(removes.length, adds.length)
    for (let j = 0; j < maxLen; j++) {
      const rm = removes[j]
      const ad = adds[j]
      rows.push({
        left: rm
          ? { lineNo: rm.oldLineNo, content: rm.content, type: 'remove' }
          : { content: '', type: 'empty' },
        right: ad
          ? { lineNo: ad.newLineNo, content: ad.content, type: 'add' }
          : { content: '', type: 'empty' },
      })
    }
  }

  return rows
}

// --- Component ---

export function DiffViewer(props: DiffViewerProps) {
  const { rootPath, filePath } = props
  const [diffLines, setDiffLines] = useState<DiffLine[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const effectKey = props.mode === 'staged'
    ? `staged:${filePath}:${props.fileStatus}`
    : `commit:${filePath}:${props.commitHash}`

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setError(null)

    const fetchDiff = props.mode === 'staged'
      ? window.electronAPI.gitFileDiff(rootPath, filePath, props.fileStatus)
      : window.electronAPI.gitCommitFileDiff(rootPath, props.commitHash, filePath)

    fetchDiff
      .then(result => {
        if (cancelled) return
        if (result.success) {
          const isNew = 'isNewFile' in result ? !!(result as { isNewFile?: boolean }).isNewFile : undefined
          const isDel = 'isDeletedFile' in result ? !!(result as { isDeletedFile?: boolean }).isDeletedFile : undefined
          setDiffLines(parseDiff(result.diff, isNew || undefined, isDel || undefined))
        } else {
          setError(result.error || 'Failed to load diff')
        }
      })
      .catch(err => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => { cancelled = true }
  }, [effectKey, rootPath])

  // Synchronized scrolling for both panes
  const leftRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)
  const scrollingRef = useRef(false)

  const handleScroll = useCallback((source: 'left' | 'right') => {
    if (scrollingRef.current) return
    scrollingRef.current = true
    const from = source === 'left' ? leftRef.current : rightRef.current
    const to = source === 'left' ? rightRef.current : leftRef.current
    if (from && to) {
      to.scrollTop = from.scrollTop
      to.scrollLeft = from.scrollLeft
    }
    requestAnimationFrame(() => { scrollingRef.current = false })
  }, [])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-text-secondary">
        <SpinnerGap size={16} className="animate-spin" />
        差分を読み込み中...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-red-400">
        差分の読み込みに失敗しました
      </div>
    )
  }

  if (diffLines.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-text-secondary">
        差分なし
      </div>
    )
  }

  const splitRows = toSplitRows(diffLines)

  return (
    <div className="flex h-full">
      {/* Left pane (old / removed) */}
      <div className="w-1/2 border-r border-border flex flex-col">
        <div className="px-3 py-1.5 text-[11px] text-text-secondary bg-red-500/5 border-b border-border font-medium">
          変更前
        </div>
        <div
          ref={leftRef}
          className="flex-1 overflow-auto text-[11px] font-mono leading-[1.7]"
          onScroll={() => handleScroll('left')}
        >
          {splitRows.map((row, i) => (
            <SplitLine key={i} lineNo={row.left.lineNo} content={row.left.content} type={row.left.type} />
          ))}
        </div>
      </div>

      {/* Right pane (new / added) */}
      <div className="w-1/2 flex flex-col">
        <div className="px-3 py-1.5 text-[11px] text-text-secondary bg-green-500/5 border-b border-border font-medium">
          変更後
        </div>
        <div
          ref={rightRef}
          className="flex-1 overflow-auto text-[11px] font-mono leading-[1.7]"
          onScroll={() => handleScroll('right')}
        >
          {splitRows.map((row, i) => (
            <SplitLine key={i} lineNo={row.right.lineNo} content={row.right.content} type={row.right.type} />
          ))}
        </div>
      </div>
    </div>
  )
}

// --- Split line row ---

function SplitLine({ lineNo, content, type }: {
  lineNo?: number
  content: string
  type: 'add' | 'remove' | 'context' | 'empty'
}) {
  const bgClass =
    type === 'remove' ? 'bg-red-500/10' :
    type === 'add' ? 'bg-green-500/10' :
    type === 'empty' ? 'bg-activitybar-bg/30' :
    ''

  const textClass =
    type === 'remove' ? 'text-red-400' :
    type === 'add' ? 'text-green-400' :
    type === 'empty' ? '' :
    'text-text-secondary'

  const prefix =
    type === 'remove' ? '−' :
    type === 'add' ? '+' :
    type === 'empty' ? '' :
    ' '

  return (
    <div className={`flex ${bgClass} min-h-[1.7em]`}>
      <span className="w-[45px] text-right pr-2 text-text-secondary/25 select-none flex-shrink-0">
        {lineNo ?? ''}
      </span>
      {type !== 'empty' && (
        <>
          <span className={`w-[16px] text-center select-none flex-shrink-0 ${textClass}`}>
            {prefix}
          </span>
          <span className={`flex-1 whitespace-pre pr-3 ${textClass}`}>
            {content || '\u00A0'}
          </span>
        </>
      )}
    </div>
  )
}
