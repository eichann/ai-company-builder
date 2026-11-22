import { useState, useEffect, useRef, useCallback, useId } from 'react'
import { SpinnerGap } from '@phosphor-icons/react'
import { getCommitFileDiff, getWorkingFileDiff } from '../ipc/diffs'
import { Dialog, DialogCloseButton, DialogTitle } from './Dialog'

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

interface UnifiedDiffLine {
  type: 'add' | 'remove' | 'context' | 'header'
  content: string
  oldLineNo?: number
  newLineNo?: number
}

interface SplitRow {
  left: { lineNo?: number; content: string; type: 'remove' | 'context' | 'empty' }
  right: { lineNo?: number; content: string; type: 'add' | 'context' | 'empty' }
}

// --- Diff Modal (exported for use in SyncPreviewDialog / FileVersions) ---

interface DiffModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  diffProps: DiffViewerProps
}

export function DiffModal({ isOpen, onClose, title, diffProps }: DiffModalProps) {
  if (!isOpen) return null
  return <DiffDialog onClose={onClose} title={title} diffProps={diffProps} />
}

/** The shared frame (design-system.md, P2d), wide and tall: a list-like header, no padding. */
function DiffDialog({ onClose, title, diffProps }: Omit<DiffModalProps, 'isOpen'>) {
  const titleId = useId()
  return (
    <Dialog onClose={onClose} labelledBy={titleId} size="custom" padded={false}
      className="max-w-[1400px] h-[85vh] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-[color:var(--color-border)] bg-bg">
        <DialogTitle id={titleId} className="truncate">{title}</DialogTitle>
        <DialogCloseButton onClick={onClose} />
      </div>

      {/* Split Diff Content */}
      <div className="flex-1 overflow-hidden">
        <DiffViewer {...diffProps} />
      </div>
    </Dialog>
  )
}

// --- Parsing ---

function parseDiff(diff: string, isNewFile?: boolean, isDeletedFile?: boolean): UnifiedDiffLine[] {
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
  const result: UnifiedDiffLine[] = []
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

function toSplitRows(lines: UnifiedDiffLine[]): SplitRow[] {
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
    const removes: UnifiedDiffLine[] = []
    const adds: UnifiedDiffLine[] = []

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

// Before / after by meaning (design-system.md, P2d): a removed line is the danger set, an added
// one the success set (text on its own fill: AA in both themes, build.mjs PAIRS), so they stay
// apart in light and dark; a padding row is the page's grey. Also each side's header.
const LINE_LOOK = {
  remove: 'bg-danger-bg text-danger-text border-danger-border',
  add: 'bg-success-bg text-success-text border-success-border',
  empty: 'bg-bg',
  context: 'text-text-muted',
} as const

export function DiffViewer(props: DiffViewerProps) {
  const { rootPath, filePath } = props
  const [diffLines, setDiffLines] = useState<UnifiedDiffLine[]>([])
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
      ? getWorkingFileDiff(rootPath, filePath, props.fileStatus)
      : getCommitFileDiff(rootPath, props.commitHash, filePath)

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
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-text-muted">
        <SpinnerGap size={16} className="animate-spin" />
        差分を読み込み中...
      </div>
    )
  }

  if (error) {
    return (
      <div role="alert" className="flex items-center justify-center py-8 text-sm text-danger-text">
        差分の読み込みに失敗しました
      </div>
    )
  }

  if (diffLines.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-text-muted">
        差分なし
      </div>
    )
  }

  const splitRows = toSplitRows(diffLines)

  return (
    <div className="flex h-full">
      {/* Left pane (old / removed) */}
      <div className="w-1/2 border-r border-[color:var(--color-border)] flex flex-col">
        <div data-diff-side="before" className={`px-3 py-1.5 text-caption font-medium border-b ${LINE_LOOK.remove}`}>
          変更前
        </div>
        <div
          ref={leftRef}
          className="flex-1 overflow-auto text-caption font-normal font-mono leading-[1.7]"
          onScroll={() => handleScroll('left')}
        >
          {splitRows.map((row, i) => (
            <SplitLine key={i} lineNo={row.left.lineNo} content={row.left.content} type={row.left.type} />
          ))}
        </div>
      </div>

      {/* Right pane (new / added) */}
      <div className="w-1/2 flex flex-col">
        <div data-diff-side="after" className={`px-3 py-1.5 text-caption font-medium border-b ${LINE_LOOK.add}`}>
          変更後
        </div>
        <div
          ref={rightRef}
          className="flex-1 overflow-auto text-caption font-normal font-mono leading-[1.7]"
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
  const prefix =
    type === 'remove' ? '−' :
    type === 'add' ? '+' :
    type === 'empty' ? '' :
    ' '

  return (
    <div data-diff-line={type} className={`flex ${LINE_LOOK[type]} min-h-[1.7em]`}>
      <span className="w-[45px] text-right pr-2 text-text-subtle select-none flex-shrink-0">
        {lineNo ?? ''}
      </span>
      {type !== 'empty' && (
        <>
          <span className="w-[16px] text-center select-none flex-shrink-0">
            {prefix}
          </span>
          <span className="flex-1 whitespace-pre pr-3">
            {content || '\u00A0'}
          </span>
        </>
      )}
    </div>
  )
}
