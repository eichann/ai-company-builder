import { useState, useCallback, useRef, useMemo } from 'react'
import { MagnifyingGlass, X, CircleNotch } from '@phosphor-icons/react'
import { getFileIcon } from '../../../shared/ui/fileIcon'
import { ThingIcon } from '../../../shared/ui/ThingIcon'
import type { RecordListResult } from '../../../../shared/record-views'
import { CALM } from '../../../../shared/thing-words'
import { searchFileContents, searchRecords } from '../api'
import { chipOf, findChips } from '../model'
import { RecordHits } from './RecordHits'

interface GrepMatch {
  file: string
  line: number
  text: string
  column?: number
}

interface GroupedResult {
  file: string
  displayPath: string
  matches: { line: number; text: string; column?: number }[]
}

interface SearchPanelProps {
  rootPath: string
  /** Records are searched company-wide (what the member may read); none without a company. */
  companyId?: string
  /** '' = the whole company (全社 tab). */
  departmentFolder: string
  inputRef?: React.RefObject<HTMLInputElement>
  /** A file's hit opens it in a tab in the middle, at that line (records open through `record.open`). */
  onOpenFile: (filePath: string, line: number) => void
}

/** The line with the matched text emphasised (the search is case-insensitive for A–Z, so the length is the query's). */
function MatchText({ text, column, length }: { text: string; column?: number; length: number }) {
  if (column === undefined || column < 0 || column >= text.length || length <= 0) return <>{text}</>
  return (
    <>
      {text.slice(0, column)}
      <mark className="bg-amber-200/70 dark:bg-amber-400/25 text-inherit rounded-sm">{text.slice(column, column + length)}</mark>
      {text.slice(column + length)}
    </>
  )
}

const empty = { results: [] as GrepMatch[], truncated: false, error: null as string | null, records: null as RecordListResult | null }

/**
 * 探す (the left tab, never 「検索」, 言葉の決まり 5.): records and files that hold the words, in the
 * narrow column; what is found opens in a tab in the middle. Kind chips narrow the results, one for
 * each kind that has something.
 */
export function SearchPanel({ rootPath, companyId, departmentFolder, inputRef, onOpenFile }: SearchPanelProps) {
  const [query, setQuery] = useState('')
  const [found, setFound] = useState(empty)
  const [searchedQuery, setSearchedQuery] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [chip, setChip] = useState<string | null>(null)
  const [scope, setScope] = useState({ rootPath, departmentFolder })
  const localInputRef = useRef<HTMLInputElement>(null)
  const effectiveRef = inputRef || localInputRef
  const searchSeq = useRef(0)

  const clear = useCallback(() => {
    searchSeq.current++
    setFound(empty)
    setIsSearching(false)
    setHasSearched(false)
    setChip(null)
  }, [])
  // A different department (or company) makes the old results meaningless.
  if (scope.rootPath !== rootPath || scope.departmentFolder !== departmentFolder) {
    setScope({ rootPath, departmentFolder })
    clear()
  }

  // Results are company-relative; shown relative to the department ('' = whole company).
  const prefix = departmentFolder ? departmentFolder + '/' : ''

  const handleSearch = useCallback(async () => {
    const trimmed = query.trim()
    if (!trimmed || !rootPath) return
    const seq = ++searchSeq.current
    setIsSearching(true)
    setHasSearched(true)
    setChip(null)
    setFound(empty)
    if (companyId) {
      searchRecords(companyId, trimmed)
        .then(r => { if (seq === searchSeq.current) setFound(f => ({ ...f, records: r })) })
        .catch(() => {})
    }
    try {
      // Main caps it (20 per file, 500 in all) and stops the previous search.
      const result = await searchFileContents(rootPath, trimmed, departmentFolder)
      if (seq !== searchSeq.current || result.cancelled) return
      setSearchedQuery(trimmed)
      setFound(f => result.success
        ? { ...f, results: result.results, truncated: !!result.truncated, error: null }
        : { ...f, results: [], truncated: false, error: CALM.failed })
    } catch {
      if (seq === searchSeq.current) setFound(f => ({ ...f, results: [], truncated: false, error: CALM.failed }))
    } finally {
      if (seq === searchSeq.current) setIsSearching(false)
    }
  }, [query, rootPath, companyId, departmentFolder])

  const grouped = useMemo<GroupedResult[]>(() => {
    const map = new Map<string, GroupedResult['matches']>()
    for (const r of found.results) map.set(r.file, [...(map.get(r.file) ?? []), { line: r.line, text: r.text, column: r.column }])
    return [...map].map(([file, matches]) => ({ file, displayPath: file.startsWith(prefix) ? file.slice(prefix.length) : file, matches }))
  }, [found.results, prefix])

  const records = found.records?.success && found.records.available ? found.records.records : []
  const chips = useMemo(() => findChips(records, grouped.length), [records, grouped.length])
  const shownChip = chip && chips.some(c => c.id === chip) ? chip : null
  const shownRecords = shownChip === null ? records : records.filter(r => chipOf(r) === shownChip)
  const showFiles = shownChip === null || shownChip === 'file'
  const count = shownRecords.length + (showFiles ? grouped.length : 0)

  return (
    <div className="h-full flex flex-col min-w-0">
      <div className="flex-shrink-0 space-y-2 px-3 py-3 border-b border-gray-200 dark:border-zinc-800/50">
        <div className="relative">
          <MagnifyingGlass size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-zinc-500" />
          <input
            ref={effectiveRef}
            type="text"
            aria-label="探す"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void handleSearch() }
              if (e.key === 'Escape') { setQuery(''); clear() }
            }}
            placeholder="探す（言葉を入れて Enter）"
            className="w-full pl-8 pr-8 py-1.5 text-xs rounded-md border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-gray-800 dark:text-zinc-200 placeholder:text-gray-400 dark:placeholder:text-zinc-500 focus:outline-none focus:border-accent"
          />
          {query && (
            <button type="button" aria-label="消す" onClick={() => { setQuery(''); clear() }}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-400 dark:text-zinc-500">
              <X size={11} />
            </button>
          )}
        </div>
        {chips.length > 0 && (
          <div role="group" aria-label="種類で絞る" className="flex flex-wrap gap-1">
            {chips.map(c => {
              const on = shownChip === c.id
              return (
                <button key={c.id} type="button" data-find-chip={c.id} aria-pressed={on} onClick={() => setChip(on ? null : c.id)}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${on ? 'border-accent bg-accent/10 text-accent' : 'border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-zinc-300 hover:border-accent'}`}>
                  <ThingIcon kind={c.kind} typeLabel={c.typeLabel} size={11} />{c.label}<span className="text-gray-400">{c.count}</span>
                </button>
              )
            })}
          </div>
        )}
        {hasSearched && !isSearching && (
          <p className="text-[10px] text-gray-400 dark:text-zinc-500">{found.error ?? (count === 0 ? CALM.notFound : `見つかったもの（${count}）`)}</p>
        )}
        {hasSearched && !isSearching && found.truncated && showFiles && (
          <p className="text-[10px] text-amber-600 dark:text-amber-400/80">
            結果が多いため最初の{found.results.length}件を表示しています。言葉を増やして絞り込んでください。
          </p>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {isSearching ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-gray-400 dark:text-zinc-500">
            <CircleNotch size={14} className="animate-spin" />{CALM.loading}
          </div>
        ) : !hasSearched ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 dark:text-zinc-600 px-4">
            <MagnifyingGlass size={36} className="mb-3 opacity-40" />
            <p className="text-xs text-center">やること・会議の記録・ファイルなどを、言葉で探します</p>
          </div>
        ) : (
          <>
            <RecordHits result={found.records} records={shownRecords} />
            {showFiles && grouped.length > 0 && <div className="py-1" aria-label="見つかったファイル">
              {grouped.map(({ file, displayPath, matches }) => {
                const IC = getFileIcon(file.split('/').pop() || '', false)
                return (
                  // content-visibility: the browser skips layout/paint of off-screen groups (≤500 matches).
                  <div key={file} className="mb-1" style={{ contentVisibility: 'auto', containIntrinsicSize: `auto ${24 + matches.length * 20}px` }}>
                    <div className="flex items-center gap-1.5 px-3 py-1 text-[11px] font-medium text-gray-700 dark:text-zinc-300">
                      <IC size={13} className="flex-shrink-0" />
                      <span className="truncate" title={displayPath}>{displayPath}</span>
                      <span className="text-gray-400 dark:text-zinc-500 flex-shrink-0">({matches.length})</span>
                    </div>
                    {matches.map((m, i) => (
                      <button key={i} type="button" onClick={() => onOpenFile(`${rootPath}/${file}`, m.line)}
                        className="w-full text-left flex items-start gap-2 px-3 py-0.5 hover:bg-gray-100 dark:hover:bg-white/[0.04] group">
                        <span className="text-[10px] text-gray-400 dark:text-zinc-600 font-mono w-8 text-right flex-shrink-0 pt-px">{m.line}</span>
                        <span className="text-[11px] truncate text-gray-600 dark:text-zinc-400 group-hover:text-gray-800 dark:group-hover:text-zinc-200">
                          <MatchText text={m.text} column={m.column} length={searchedQuery.length} />
                        </span>
                      </button>
                    ))}
                  </div>
                )
              })}
            </div>}
          </>
        )}
      </div>
    </div>
  )
}
