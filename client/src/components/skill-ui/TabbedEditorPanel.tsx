import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  X,
  FileText,
  Warning,
  Code,
  Eye,
  PencilSimple,
  ChatCircleDots,
  MagnifyingGlass,
  CaretUp,
  CaretDown,
} from '@phosphor-icons/react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { EditorView } from '@codemirror/view'
import { CodeEditor } from './CodeEditor'
import { getFileIcon } from './FileIcons'
import {
  useMarkdownReview,
  useTextSelection,
  ReviewBanner,
  CompletedReviewBanner,
  ReviewHistoryDropdown,
  ReviewSidePanel,
  CommentPopover,
  MarkdownDiffView,
  markReviewSeen,
  type MarkdownDiffViewHandle,
} from './MarkdownReview'
import { useAuthStore } from '../../stores/authStore'

interface OpenFile {
  path: string
  content: string
  originalContent: string
  isLoading: boolean
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'])

function isImageFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  return IMAGE_EXTENSIONS.has(ext)
}

function isPdfFile(filePath: string): boolean {
  return filePath.split('.').pop()?.toLowerCase() === 'pdf'
}

function isBinaryFile(filePath: string): boolean {
  return isImageFile(filePath) || isPdfFile(filePath)
}

function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  return ext === 'md' || ext === 'mdx'
}

function PdfPreview({ filePath }: { filePath: string }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let blobUrl: string | null = null

    window.electronAPI.readFileBinary(filePath).then(buffer => {
      if (buffer) {
        const blob = new Blob([buffer], { type: 'application/pdf' })
        blobUrl = URL.createObjectURL(blob)
        setUrl(blobUrl)
      }
    })

    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [filePath])

  if (!url) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400 dark:text-zinc-500 text-sm">
        読み込み中...
      </div>
    )
  }

  return (
    <iframe
      src={`${url}#toolbar=1`}
      className="w-full h-full border-0"
    />
  )
}

interface HighlightRange {
  text: string
  resolved: boolean
  commentId: string
}

const MarkdownPreview = React.forwardRef<HTMLDivElement, {
  content: string
  basePath: string
  initialScrollRatio?: number
  highlightRanges?: HighlightRange[]
}>(
  function MarkdownPreview({ content, basePath, initialScrollRatio, highlightRanges }, ref) {
    const innerRef = useRef<HTMLDivElement | null>(null)
    const bodyRef = useRef<HTMLDivElement | null>(null)
    const components = useMemo(() => ({
      img: ({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => {
        let resolvedSrc = src || ''
        if (resolvedSrc && !resolvedSrc.startsWith('http') && !resolvedSrc.startsWith('data:')) {
          resolvedSrc = `local-file://${basePath}/${resolvedSrc.replace(/^\.\//, '')}`
        }
        return <img src={resolvedSrc} alt={alt} {...props} className="max-w-full rounded" />
      },
      a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <a href={href} {...props} target="_blank" rel="noopener noreferrer">{children}</a>
      ),
    }), [basePath])

    // --- Search state ---
    const [searchOpen, setSearchOpen] = useState(false)
    const [searchText, setSearchText] = useState('')
    const [matchCount, setMatchCount] = useState(0)
    const [currentMatch, setCurrentMatch] = useState(0)
    const searchInputRef = useRef<HTMLInputElement>(null)

    // Open search with Cmd+F
    useEffect(() => {
      const handler = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
          // Only handle if this preview is visible (check if innerRef is in viewport)
          if (!innerRef.current || !innerRef.current.offsetParent) return
          e.preventDefault()
          e.stopPropagation()
          setSearchOpen(true)
          requestAnimationFrame(() => searchInputRef.current?.focus())
        }
      }
      document.addEventListener('keydown', handler, true)
      return () => document.removeEventListener('keydown', handler, true)
    }, [])

    // Apply search highlights
    useEffect(() => {
      if (!bodyRef.current) return

      // Clear existing search highlights
      bodyRef.current.querySelectorAll('mark[data-search-highlight]').forEach(el => {
        const parent = el.parentNode
        if (parent) {
          parent.replaceChild(document.createTextNode(el.textContent || ''), el)
          parent.normalize()
        }
      })

      if (!searchText.trim()) {
        setMatchCount(0)
        setCurrentMatch(0)
        return
      }

      const query = searchText.trim().toLowerCase()
      let count = 0
      const walker = document.createTreeWalker(bodyRef.current, NodeFilter.SHOW_TEXT)
      const matches: { node: Text; idx: number }[] = []

      // Collect all matches first (avoid modifying DOM during walk)
      let node: Text | null
      while ((node = walker.nextNode() as Text | null)) {
        // Skip nodes inside review highlights to avoid conflicts
        if (node.parentElement?.hasAttribute('data-review-highlight')) continue
        const text = node.textContent || ''
        const lower = text.toLowerCase()
        let searchFrom = 0
        let idx: number
        while ((idx = lower.indexOf(query, searchFrom)) !== -1) {
          matches.push({ node, idx })
          searchFrom = idx + query.length
        }
      }

      // Apply highlights from last to first (to preserve indices)
      for (let i = matches.length - 1; i >= 0; i--) {
        const m = matches[i]
        const textNode = m.node
        // Re-check since DOM may have been modified by previous iterations on same node
        if (!textNode.parentNode) continue
        const text = textNode.textContent || ''
        const actualIdx = text.toLowerCase().indexOf(query, m.idx)
        if (actualIdx === -1) continue

        const before = textNode.splitText(actualIdx)
        const after = before.splitText(query.length)
        void after
        const mark = document.createElement('mark')
        mark.setAttribute('data-search-highlight', 'true')
        mark.setAttribute('data-search-index', String(i))
        mark.className = 'bg-yellow-200 dark:bg-yellow-500/40 rounded-sm'
        mark.textContent = before.textContent
        before.parentNode?.replaceChild(mark, before)
        count++
      }

      setMatchCount(matches.length)
      setCurrentMatch(prev => matches.length > 0 ? Math.min(prev, matches.length - 1) : 0)
    }, [searchText, content])

    // Scroll to current match and highlight it
    useEffect(() => {
      if (!bodyRef.current || matchCount === 0) return
      // Reset all to default style
      bodyRef.current.querySelectorAll('mark[data-search-highlight]').forEach(el => {
        (el as HTMLElement).className = 'bg-yellow-200 dark:bg-yellow-500/40 rounded-sm'
      })
      // Highlight current match
      const current = bodyRef.current.querySelector(`mark[data-search-index="${currentMatch}"]`)
      if (current) {
        (current as HTMLElement).className = 'bg-orange-300 dark:bg-orange-500/60 rounded-sm ring-2 ring-orange-400'
        current.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }, [currentMatch, matchCount])

    const closeSearch = useCallback(() => {
      setSearchOpen(false)
      setSearchText('')
    }, [])

    const goNextMatch = useCallback(() => {
      if (matchCount === 0) return
      setCurrentMatch(prev => (prev + 1) % matchCount)
    }, [matchCount])

    const goPrevMatch = useCallback(() => {
      if (matchCount === 0) return
      setCurrentMatch(prev => (prev - 1 + matchCount) % matchCount)
    }, [matchCount])

    // Restore scroll position by ratio after mount
    useEffect(() => {
      if (!innerRef.current || initialScrollRatio == null || initialScrollRatio <= 0) return
      const el = innerRef.current
      requestAnimationFrame(() => {
        const maxScroll = el.scrollHeight - el.clientHeight
        el.scrollTop = maxScroll * initialScrollRatio
      })
    }, []) // Only on mount

    // Apply text highlights for review comments
    useEffect(() => {
      if (!bodyRef.current) return

      // Remove existing highlights first (always clean up)
      bodyRef.current.querySelectorAll('mark[data-review-highlight]').forEach(el => {
        const parent = el.parentNode
        if (parent) {
          parent.replaceChild(document.createTextNode(el.textContent || ''), el)
          parent.normalize()
        }
      })

      if (!highlightRanges || highlightRanges.length === 0) return

      // Apply new highlights using TreeWalker (skip nodes inside search highlights)
      for (const range of highlightRanges) {
        const walker = document.createTreeWalker(bodyRef.current, NodeFilter.SHOW_TEXT)
        let node: Text | null
        while ((node = walker.nextNode() as Text | null)) {
          if (node.parentElement?.hasAttribute('data-search-highlight')) continue
          const idx = node.textContent?.indexOf(range.text) ?? -1
          if (idx === -1) continue

          const before = node.splitText(idx)
          const highlighted = before.splitText(range.text.length)
          const mark = document.createElement('mark')
          mark.setAttribute('data-review-highlight', 'true')
          mark.setAttribute('data-comment-id', range.commentId)
          mark.className = range.resolved
            ? 'bg-green-500/20 rounded px-0.5 transition-all'
            : 'bg-amber-500/30 rounded px-0.5 transition-all'
          mark.textContent = before.textContent
          before.parentNode?.replaceChild(mark, before)
          // walker continues with `highlighted` node
          void highlighted
          break // Only highlight first occurrence per range
        }
      }
    }, [highlightRanges, content])

    const setRefs = useCallback((el: HTMLDivElement | null) => {
      innerRef.current = el
      if (typeof ref === 'function') ref(el)
      else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = el
    }, [ref])

    return (
      <div ref={setRefs} className="h-full overflow-auto px-8 py-6 relative">
        {/* Search bar */}
        {searchOpen && (
          <div className="sticky top-0 z-10 mb-4 flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-md max-w-md mx-auto">
            <MagnifyingGlass size={14} className="text-gray-400 dark:text-zinc-500 flex-shrink-0" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchText}
              onChange={(e) => { setSearchText(e.target.value); setCurrentMatch(0) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); goPrevMatch() }
                else if (e.key === 'Enter') { e.preventDefault(); goNextMatch() }
                else if (e.key === 'Escape') { e.preventDefault(); closeSearch() }
              }}
              placeholder="検索..."
              className="flex-1 min-w-0 bg-transparent text-sm text-gray-800 dark:text-zinc-200 placeholder-gray-400 dark:placeholder-zinc-500 outline-none"
              autoFocus
            />
            {searchText && (
              <span className="text-[11px] text-gray-400 dark:text-zinc-500 tabular-nums flex-shrink-0">
                {matchCount > 0 ? `${currentMatch + 1}/${matchCount}` : '0件'}
              </span>
            )}
            <button onClick={goPrevMatch} className="p-0.5 text-gray-400 dark:text-zinc-500 hover:text-gray-600 dark:hover:text-zinc-300 disabled:opacity-30" disabled={matchCount === 0}>
              <CaretUp size={14} />
            </button>
            <button onClick={goNextMatch} className="p-0.5 text-gray-400 dark:text-zinc-500 hover:text-gray-600 dark:hover:text-zinc-300 disabled:opacity-30" disabled={matchCount === 0}>
              <CaretDown size={14} />
            </button>
            <button onClick={closeSearch} className="p-0.5 text-gray-400 dark:text-zinc-500 hover:text-gray-600 dark:hover:text-zinc-300">
              <X size={14} />
            </button>
          </div>
        )}
        <div ref={bodyRef} className="max-w-3xl mx-auto markdown-body">
          <Markdown remarkPlugins={[remarkGfm]} components={components}>
            {content}
          </Markdown>
        </div>
      </div>
    )
  }
)

interface TabbedEditorPanelProps {
  openFiles: string[]
  activeFilePath: string | null
  previewFilePath?: string | null
  onSelectFile: (path: string) => void
  onCloseFile: (path: string) => void
  onPinFile?: (path: string) => void
  gotoLine?: number | null
}

export function TabbedEditorPanel({
  openFiles,
  activeFilePath,
  previewFilePath,
  onSelectFile,
  onCloseFile,
  onPinFile,
  gotoLine,
}: TabbedEditorPanelProps) {
  const [fileContents, setFileContents] = useState<Map<string, OpenFile>>(new Map())
  const [, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadingRef = useRef<Set<string>>(new Set())

  // Scroll ratio per file (0-1). Shared between editor and preview modes.
  const scrollRatioRef = useRef<Map<string, number>>(new Map())
  const editorViewRef = useRef<EditorView | null>(null)
  const mdPreviewRef = useRef<HTMLDivElement | null>(null)
  const diffViewRef = useRef<MarkdownDiffViewHandle | null>(null)
  const activeFile = activeFilePath ? fileContents.get(activeFilePath) : null
  const hasChanges = activeFile ? activeFile.content !== activeFile.originalContent : false

  // Markdown view mode: persisted across files and app restarts
  const [mdViewMode, setMdViewMode] = useState<'preview' | 'editor'>(() => {
    const saved = localStorage.getItem('mdViewMode')
    return saved === 'preview' || saved === 'editor' ? saved : 'editor'
  })

  const isActivePreviewTab = activeFilePath === previewFilePath
  const [showDiff, setShowDiff] = useState(false)

  // Markdown review
  const authUser = useAuthStore(state => state.user)
  const review = useMarkdownReview(activeFilePath, authUser?.name || 'Anonymous', authUser?.email || '')
  const mdPreviewContainerRef = useRef<HTMLDivElement>(null)
  const textSelection = useTextSelection(
    review.isReviewing,
    activeFile?.content || '',
    review.addComment,
  )

  // Mark reviews as seen when user opens a file with reviews
  useEffect(() => {
    if (!activeFilePath || !isMarkdownFile(activeFilePath)) return
    if (review.reviews.length === 0 && !review.loading) return
    if (review.loading) return
    // Reconstruct review file names from review IDs
    const docName = activeFilePath.split('/').pop() || ''
    const reviewFileNames = review.reviews.map(r => `${docName}.review.${r.id}.json`)
    if (reviewFileNames.length > 0) {
      markReviewSeen(activeFilePath, reviewFileNames)
    }
  }, [activeFilePath, review.reviews, review.loading])

  const setMdViewModePersisted = (mode: 'preview' | 'editor') => {
    setMdViewMode(mode)
    localStorage.setItem('mdViewMode', mode)
  }

  // Save current scroll ratio (call BEFORE switching away)
  const saveCurrentScrollPosition = useCallback(() => {
    if (!activeFilePath) return
    const isMdPreview = isMarkdownFile(activeFilePath) && mdViewMode === 'preview'
    if (isMdPreview && mdPreviewRef.current) {
      const el = mdPreviewRef.current
      const maxScroll = el.scrollHeight - el.clientHeight
      scrollRatioRef.current.set(activeFilePath, maxScroll > 0 ? el.scrollTop / maxScroll : 0)
    } else if (editorViewRef.current) {
      const dom = editorViewRef.current.scrollDOM
      const maxScroll = dom.scrollHeight - dom.clientHeight
      scrollRatioRef.current.set(activeFilePath, maxScroll > 0 ? dom.scrollTop / maxScroll : 0)
    }
  }, [activeFilePath, mdViewMode])

  // Wrap onSelectFile to save scroll before switching
  const handleSelectFile = useCallback((path: string) => {
    saveCurrentScrollPosition()
    onSelectFile(path)
  }, [saveCurrentScrollPosition, onSelectFile])

  // Wrap mdViewMode toggle to save scroll before switching
  const handleSetMdViewMode = useCallback((mode: 'preview' | 'editor') => {
    // Warn when switching to editor while other users have in-progress reviews
    if (mode === 'editor' && review.otherInProgressReviews.length > 0) {
      const names = review.otherInProgressReviews.map(r => r.reviewerName).join('、')
      const ok = window.confirm(`${names} がレビュー中です。編集するとレビューコメントが無効になる可能性がありますが、続けますか？`)
      if (!ok) return
    }
    saveCurrentScrollPosition()
    setMdViewModePersisted(mode)
  }, [saveCurrentScrollPosition, review.otherInProgressReviews])

  // Cmd+Shift+M → toggle markdown preview / editor
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'm') {
        if (!activeFilePath || !isMarkdownFile(activeFilePath)) return
        e.preventDefault()
        handleSetMdViewMode(mdViewMode === 'preview' ? 'editor' : 'preview')
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [activeFilePath, mdViewMode, handleSetMdViewMode])

  // Clean up scroll ratios when files are closed
  useEffect(() => {
    const openFilesSet = new Set(openFiles)
    for (const key of scrollRatioRef.current.keys()) {
      if (!openFilesSet.has(key)) {
        scrollRatioRef.current.delete(key)
      }
    }
  }, [openFiles])

  // Ref to access latest fileContents inside onFileChange callback
  const fileContentsRef = useRef<Map<string, OpenFile>>(fileContents)
  fileContentsRef.current = fileContents

  // Ref for review reload (used inside file watcher)
  const reviewReloadRef = useRef(review.reload)
  reviewReloadRef.current = review.reload
  const activeFilePathRef = useRef(activeFilePath)
  activeFilePathRef.current = activeFilePath

  // Reload open files when modified externally (e.g., by AI agent)
  useEffect(() => {
    const unsubscribe = window.electronAPI.onFileChange(async (data) => {
      if (data.type !== 'change') return
      const changedPath = data.path

      // Reload review data when a review or reply sidecar file changes
      const reviewMatch = changedPath.match(/^(.+)\.review\.[^/]+\.json$/) || changedPath.match(/^(.+)\.reply\.[^/]+\.json$/)
      if (reviewMatch) {
        const docPath = reviewMatch[1]
        if (docPath === activeFilePathRef.current) {
          reviewReloadRef.current()
        }
        return
      }

      const file = fileContentsRef.current.get(changedPath)

      // Only reload if the file is open, not loading, and not an image
      if (!file || file.isLoading || isBinaryFile(changedPath)) return
      // Don't overwrite unsaved local edits
      if (file.content !== file.originalContent) return

      try {
        const newContent = await window.electronAPI.readFile(changedPath)
        if (newContent !== null && newContent !== file.originalContent) {
          setFileContents(prev => {
            const newMap = new Map(prev)
            newMap.set(changedPath, {
              path: changedPath,
              content: newContent,
              originalContent: newContent,
              isLoading: false,
            })
            return newMap
          })
        }
      } catch {
        // Silently ignore read errors during external change detection
      }
    })

    return () => unsubscribe()
  }, [])

  // Load file content when a new file is opened
  useEffect(() => {
    for (const filePath of openFiles) {
      if (!fileContents.has(filePath) && !loadingRef.current.has(filePath)) {
        // Skip loading for binary files (displayed via local-file:// URL)
        if (isBinaryFile(filePath)) {
          setFileContents(prev => {
            const newMap = new Map(prev)
            newMap.set(filePath, { path: filePath, content: '', originalContent: '', isLoading: false })
            return newMap
          })
          continue
        }
        loadingRef.current.add(filePath)
        loadFile(filePath)
      }
    }

    // Clean up closed files from state
    const openFilesSet = new Set(openFiles)
    setFileContents(prev => {
      const newMap = new Map(prev)
      for (const path of newMap.keys()) {
        if (!openFilesSet.has(path)) {
          newMap.delete(path)
        }
      }
      return newMap
    })
  }, [openFiles])

  const loadFile = async (filePath: string) => {
    setFileContents(prev => {
      const newMap = new Map(prev)
      newMap.set(filePath, {
        path: filePath,
        content: '',
        originalContent: '',
        isLoading: true,
      })
      return newMap
    })

    try {
      const fileContent = await window.electronAPI.readFile(filePath)
      setFileContents(prev => {
        const newMap = new Map(prev)
        newMap.set(filePath, {
          path: filePath,
          content: fileContent || '',
          originalContent: fileContent || '',
          isLoading: false,
        })
        return newMap
      })
    } catch {
      setError('ファイルの読み込み中にエラーが発生しました')
    } finally {
      loadingRef.current.delete(filePath)
    }
  }

  const handleContentChange = useCallback((newContent: string) => {
    if (!activeFilePath) return
    // Pin the file on first edit
    if (activeFilePath === previewFilePath && onPinFile) {
      onPinFile(activeFilePath)
    }
    setFileContents(prev => {
      const newMap = new Map(prev)
      const file = newMap.get(activeFilePath)
      if (file) {
        newMap.set(activeFilePath, {
          ...file,
          content: newContent,
        })
      }
      return newMap
    })
  }, [activeFilePath, previewFilePath, onPinFile])

  const saveFile = useCallback(async (filePath: string, content: string) => {
    setIsSaving(true)
    setError(null)
    try {
      const success = await window.electronAPI.writeFile(filePath, content)
      if (success) {
        setFileContents(prev => {
          const newMap = new Map(prev)
          const f = newMap.get(filePath)
          if (f) {
            newMap.set(filePath, {
              ...f,
              originalContent: content,
            })
          }
          return newMap
        })
      } else {
        setError('保存に失敗しました')
      }
    } catch {
      setError('保存中にエラーが発生しました')
    } finally {
      setIsSaving(false)
    }
  }, [])

  // Auto save with debounce (1 second after last keystroke)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!activeFilePath) return
    const file = fileContents.get(activeFilePath)
    if (!file || file.content === file.originalContent) return

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
    }
    autoSaveTimerRef.current = setTimeout(() => {
      saveFile(activeFilePath, file.content)
    }, 1000)

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
      }
    }
  }, [activeFilePath, fileContents, saveFile])

  const handleSave = useCallback(async () => {
    if (!activeFilePath || !hasChanges) return
    // Cancel pending auto save and save immediately
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
    }
    const file = fileContents.get(activeFilePath)
    if (!file) return
    await saveFile(activeFilePath, file.content)
  }, [activeFilePath, hasChanges, fileContents, saveFile])

  // Keyboard shortcut for save
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleSave])

  const handleCloseTab = async (e: React.MouseEvent, path: string) => {
    e.stopPropagation()
    const file = fileContents.get(path)
    if (file && file.content !== file.originalContent) {
      // Auto save before closing
      await saveFile(path, file.content)
    }
    onCloseFile(path)
  }

  const getFileName = (path: string) => path.split('/').pop() || ''

  if (openFiles.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-gray-50 dark:bg-zinc-900/30 text-gray-400 dark:text-zinc-600">
        <FileText size={48} className="mb-4 opacity-50" />
        <p className="text-sm">ファイルを選択してください</p>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-zinc-900/30">
      {/* Tab Bar */}
      <div className="flex-shrink-0 flex items-center border-b border-gray-200 dark:border-zinc-800/50 bg-gray-100 dark:bg-zinc-900/50 overflow-x-auto">
        <div className="flex">
          {openFiles.map((filePath) => {
            const fileName = getFileName(filePath)
            const file = fileContents.get(filePath)
            const isActive = filePath === activeFilePath
            const isModified = file && file.content !== file.originalContent
            const isPreview = filePath === previewFilePath
            const FileIcon = getFileIcon(fileName, false)

            return (
              <div
                key={filePath}
                onClick={() => handleSelectFile(filePath)}
                onDoubleClick={() => { if (isPreview && onPinFile) onPinFile(filePath) }}
                className={`
                  group flex items-center gap-2 px-3 py-2 cursor-pointer
                  border-r border-gray-200 dark:border-zinc-800/50 min-w-0 max-w-[200px]
                  ${isActive
                    ? 'bg-white dark:bg-zinc-900/80 text-gray-800 dark:text-zinc-200'
                    : 'bg-gray-50 dark:bg-zinc-900/30 text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-900/50'
                  }
                `}
              >
                <FileIcon size={14} className="flex-shrink-0" />
                <span className={`text-xs truncate ${isPreview ? 'italic' : ''}`} title={filePath}>{fileName}</span>
                {isModified && (
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />
                )}
                <button
                  onClick={(e) => handleCloseTab(e, filePath)}
                  className={`
                    p-0.5 rounded hover:bg-white/10 flex-shrink-0
                    ${isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
                  `}
                >
                  <X size={12} />
                </button>
              </div>
            )
          })}
        </div>

      </div>

      {/* Error message */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-2 bg-red-500/10 border-b border-red-500/20 text-red-400 text-xs">
          <Warning size={14} />
          {error}
          <button
            onClick={() => setError(null)}
            className="ml-auto hover:text-red-300"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Editor / Image Preview */}
      <div className="flex-1 overflow-hidden min-w-0">
        {activeFile?.isLoading ? (
          <div className="h-full flex items-center justify-center text-gray-400 dark:text-zinc-500">
            読み込み中...
          </div>
        ) : activeFile && activeFilePath && isImageFile(activeFilePath) ? (
          <div className="h-full flex items-center justify-center overflow-auto p-4 bg-[repeating-conic-gradient(#e5e5e5_0%_25%,#fff_0%_50%)] dark:bg-[repeating-conic-gradient(#333_0%_25%,#222_0%_50%)] bg-[length:16px_16px]">
            <img
              src={`local-file://${activeFilePath}`}
              alt={getFileName(activeFilePath)}
              className="max-w-full max-h-full object-contain"
            />
          </div>
        ) : activeFile && activeFilePath && isPdfFile(activeFilePath) ? (
          <PdfPreview filePath={activeFilePath} />
        ) : activeFile && activeFilePath && isMarkdownFile(activeFilePath) && mdViewMode === 'preview' ? (
          <div className="h-full flex flex-col">
            {/* Review banner */}
            {review.isReviewing && review.activeReview && (
              <ReviewBanner
                activeReview={review.activeReview}
                onComplete={review.completeReview}
                onCancel={review.cancelReview}
              />
            )}
            {review.isViewingCompleted && review.activeReview && (
              <CompletedReviewBanner
                activeReview={review.activeReview}
                onClose={() => { review.closeViewingReview(); setShowDiff(false) }}
                showDiff={showDiff}
                onToggleDiff={() => setShowDiff(prev => !prev)}
              />
            )}
            <div className="flex-1 flex overflow-hidden">
              {/* Markdown content or diff view */}
              <div
                ref={mdPreviewContainerRef}
                className="flex-1 relative"
                onMouseUp={textSelection.handleMouseUp}
              >
                {showDiff && review.activeReview?.snapshot ? (
                  <MarkdownDiffView
                    ref={diffViewRef}
                    snapshot={review.activeReview.snapshot}
                    current={activeFile.content}
                  />
                ) : (
                <MarkdownPreview
                  ref={mdPreviewRef}
                  content={activeFile.content}
                  basePath={activeFilePath.substring(0, activeFilePath.lastIndexOf('/'))}
                  initialScrollRatio={scrollRatioRef.current.get(activeFilePath)}
                  highlightRanges={(review.isReviewing || review.isViewingCompleted)
                    ? review.activeReview?.comments
                        .filter(c => !c.orphaned)
                        .map(c => ({
                          text: c.selectedText,
                          resolved: c.resolved,
                          commentId: c.id,
                        }))
                    : undefined}
                />
                )}
                {/* Floating view mode toggle + review button */}
                <div className="absolute top-3 right-3 flex items-center gap-2 opacity-60 hover:opacity-100 transition-opacity">
                  {!review.isReviewing && !review.isViewingCompleted && (
                    <>
                      <ReviewHistoryDropdown
                        reviews={review.completedReviews}
                        onSelectReview={review.viewReview}
                      />
                      {/* 依頼ボタンはUI非表示。review-request の仕組み自体は
                          Slack通知連携で再利用予定のため残してある。 */}
                      <button
                        onClick={review.startReview}
                        className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-md border border-gray-200 dark:border-zinc-700 bg-white/90 dark:bg-zinc-800/90 backdrop-blur-sm shadow-sm text-amber-500 hover:text-amber-400 transition-colors"
                        title="新しいレビューを開始する"
                      >
                        <ChatCircleDots size={12} />
                        レビューする
                      </button>
                    </>
                  )}
                  <div className="flex rounded-md border border-gray-200 dark:border-zinc-700 bg-white/90 dark:bg-zinc-800/90 backdrop-blur-sm shadow-sm overflow-hidden">
                    <button
                      onClick={() => handleSetMdViewMode('editor')}
                      className="flex items-center gap-1 px-2 py-1 text-[11px] transition-colors text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300"
                      title="エディタ"
                    >
                      <Code size={12} />
                    </button>
                    <button
                      className="flex items-center gap-1 px-2 py-1 text-[11px] transition-colors bg-gray-200 dark:bg-zinc-700 text-gray-800 dark:text-zinc-200"
                      title="プレビュー"
                    >
                      <Eye size={12} />
                    </button>
                  </div>
                </div>
                {/* Floating edit button (hide during review) */}
                {!review.isReviewing && (
                  <button
                    onClick={() => {
                      handleSetMdViewMode('editor')
                      if (isActivePreviewTab && onPinFile && activeFilePath) {
                        onPinFile(activeFilePath)
                      }
                    }}
                    className="absolute bottom-4 right-4 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent text-white shadow-lg hover:bg-accent/90 transition-colors"
                  >
                    <PencilSimple size={12} />
                    編集
                  </button>
                )}
                {/* Comment popover */}
                {textSelection.popover && (
                  <CommentPopover
                    position={{ x: textSelection.popover.x, y: textSelection.popover.y }}
                    selectedText={textSelection.popover.text}
                    onSubmit={textSelection.handleSubmitComment}
                    onClose={textSelection.closePopover}
                  />
                )}
              </div>
              {/* Review side panel */}
              {(review.isReviewing || review.isViewingCompleted) && review.activeReview && (
                <ReviewSidePanel
                  review={review.activeReview}
                  onDeleteComment={review.isReviewing ? review.deleteComment : undefined}
                  onToggleResolved={review.toggleResolved}
                  onClickComment={(comment) => {
                    if (showDiff && diffViewRef.current) {
                      // Scroll to the text in the diff view
                      diffViewRef.current.scrollToText(comment.selectedText)
                    } else {
                      // Scroll to the highlighted text in the markdown preview
                      const mark = mdPreviewRef.current?.querySelector(`mark[data-comment-id="${comment.id}"]`)
                      if (mark) {
                        mark.scrollIntoView({ behavior: 'smooth', block: 'center' })
                        mark.classList.add('ring-2', 'ring-amber-400')
                        setTimeout(() => mark.classList.remove('ring-2', 'ring-amber-400'), 1500)
                      }
                    }
                  }}
                  onAddReply={review.addReply}
                  readOnly={review.isViewingCompleted}
                />
              )}
            </div>
          </div>
        ) : activeFile ? (
          <div className="h-full relative">
            <CodeEditor
              key={`${activeFilePath}:${gotoLine || 0}`}
              value={activeFile.content}
              onChange={handleContentChange}
              fileName={getFileName(activeFilePath || '')}
              initialLine={gotoLine || undefined}
              initialScrollRatio={activeFilePath ? scrollRatioRef.current.get(activeFilePath) : undefined}
              onViewReady={(view) => { editorViewRef.current = view }}
            />
            {/* Floating view mode toggle for markdown files in editor mode */}
            {activeFilePath && isMarkdownFile(activeFilePath) && (
              <div className="absolute top-3 right-3 flex rounded-md border border-gray-200 dark:border-zinc-700 bg-white/90 dark:bg-zinc-800/90 backdrop-blur-sm shadow-sm overflow-hidden opacity-60 hover:opacity-100 transition-opacity">
                <button
                  className="flex items-center gap-1 px-2 py-1 text-[11px] transition-colors bg-gray-200 dark:bg-zinc-700 text-gray-800 dark:text-zinc-200"
                  title="エディタ"
                >
                  <Code size={12} />
                </button>
                <button
                  onClick={() => handleSetMdViewMode('preview')}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] transition-colors text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300"
                  title="プレビュー"
                >
                  <Eye size={12} />
                </button>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {/* Footer hint */}
      <div className="flex-shrink-0 px-4 py-1.5 border-t border-gray-200 dark:border-zinc-800/50 bg-gray-100 dark:bg-zinc-900/50">
        <span className="text-[10px] text-gray-400 dark:text-zinc-600">
          自動保存 {hasChanges ? '(未保存の変更あり)' : ''}
        </span>
      </div>
    </div>
  )
}
