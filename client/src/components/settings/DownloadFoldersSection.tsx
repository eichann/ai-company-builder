// Settings → ダウンロードするフォルダ: choose, folder by folder, what this
// computer downloads. A draft edited as a tree of tri-state checkboxes
// (department → sub-folders, lazily loaded, with sizes from the server), applied
// in one go from a sticky footer. Model: shared/sparse-paths.ts (everything is
// downloaded except the folders left out; no re-including inside a folder that
// is left out). Applying: electron/sync/sparse.ts via useSparseCheckout.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { CaretRight, FolderSimple, FolderSimpleDashed, Lock, MagnifyingGlass, SpinnerGap, X, CheckCircle, WifiSlash, WarningCircle } from '@phosphor-icons/react'
import { useSparseCheckout } from '../../hooks/useSparseCheckout'
import type { DepartmentConfig } from '../../types'
import { diffSelection, downloadedBytes, folderCheckState, formatBytes, sameSelection, toggleFolder } from '../../lib/download-selection'
import { normalizeExclusions, pathKey } from '../../../shared/sparse-paths'
import { Button, Callout, Card, IndeterminateBar, SectionHeader, TriCheckbox, UsageBar } from './ui'

interface FolderNode {
  name: string
  path: string
  size: number | null
  files: number | null
  hasChildren: boolean
  /** A private folder the member can read (its own repository; downloaded or not as a whole). */
  private?: boolean
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'confirm'; files: string[] }
  | { kind: 'applying'; receivedBytes: number }
  | { kind: 'done' }
  | { kind: 'failed'; offline: boolean; message: string }

const ROOT = ''

interface Props {
  rootPath: string
  companyId: string
  departments: DepartmentConfig[]
}

export function DownloadFoldersSection({ rootPath, companyId, departments }: Props) {
  const sparse = useSparseCheckout({ rootPath })
  const applied = sparse.excludedPaths
  // null = not edited: the draft is what is applied.
  const [edited, setEdited] = useState<string[] | null>(null)
  const draft = edited ?? applied
  const setDraft = useCallback((update: (d: string[]) => string[]) => setEdited(prev => update(prev ?? applied)), [applied])
  const [nodes, setNodes] = useState<Map<string, FolderNode>>(new Map())
  const [children, setChildren] = useState<Map<string, string[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())
  const [total, setTotal] = useState<number | null>(null)
  const [measured, setMeasured] = useState<Record<string, number | null>>({})
  const [offline, setOffline] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [initialLoading, setInitialLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const treeRef = useRef<HTMLDivElement>(null)

  const dirty = !sameSelection(applied, draft)

  const deptNames = useMemo(() => new Map(departments.map(d => [pathKey(d.folder), d.name])), [departments])

  const loadLevel = useCallback(async (folder: string, measure: string[] = []) => {
    const res = await window.electronAPI.folderSizes(rootPath, companyId, folder, measure)
    if (!res.success) throw new Error(res.error)
    setOffline(res.offline)
    const visible = res.folders.filter(f => !(folder === ROOT && f.name.startsWith('.')))
    setNodes(prev => {
      const next = new Map(prev)
      for (const f of visible) next.set(f.path, f)
      return next
    })
    setChildren(prev => new Map(prev).set(folder, visible.map(f => f.path)))
    if (Object.keys(res.measured).length > 0) setMeasured(prev => ({ ...prev, ...res.measured }))
    return res
  }, [rootPath, companyId])

  // First level, with the size of the whole company and of every folder left out.
  const loadRoot = useCallback(async () => {
    setInitialLoading(true)
    setLoadError(null)
    try {
      const res = await loadLevel(ROOT, normalizeExclusions([...applied, ...draft]))
      if (res.success) setTotal(res.size)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setInitialLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadLevel, applied])

  useEffect(() => { if (!sparse.isLoading) void loadRoot() }, [sparse.isLoading, loadRoot])

  const toggleExpanded = useCallback(async (path: string) => {
    if (expanded.has(path)) {
      setExpanded(prev => { const n = new Set(prev); n.delete(path); return n })
      return
    }
    setExpanded(prev => new Set(prev).add(path))
    if (!children.has(path)) {
      setLoadingDirs(prev => new Set(prev).add(path))
      try { await loadLevel(path) } catch { /* the row shows no children */ } finally {
        setLoadingDirs(prev => { const n = new Set(prev); n.delete(path); return n })
      }
    }
  }, [expanded, children, loadLevel])

  const sizeOf = useCallback((p: string): number | null => {
    const n = nodes.get(p)
    if (n && n.size !== null) return n.size
    const m = measured[p]
    return m === undefined ? null : m
  }, [nodes, measured])

  const sizes = useMemo(() => {
    const out: Record<string, number | null> = {}
    for (const p of normalizeExclusions([...applied, ...draft])) out[p] = sizeOf(p)
    return out
  }, [applied, draft, sizeOf])

  const downloadedNow = downloadedBytes(total, applied, sizes)
  const downloadedAfter = downloadedBytes(total, draft, sizes)
  const diff = diffSelection(applied, draft)
  // What applying downloads (the folders checked again), when all their sizes are known.
  const expectedDownload = diff.included.length > 0 && diff.included.every(p => sizeOf(p) !== null)
    ? diff.included.reduce((n, p) => n + (sizeOf(p) ?? 0), 0)
    : null

  // --- search: matches among the folders loaded so far, with their parents
  const q = query.trim().normalize('NFC').toLowerCase()
  const visibleSet = useMemo(() => {
    if (!q) return null
    const set = new Set<string>()
    for (const n of nodes.values()) {
      const label = `${n.name} ${deptNames.get(pathKey(n.path)) ?? ''}`.normalize('NFC').toLowerCase()
      if (!label.includes(q)) continue
      const parts = n.path.split('/')
      for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'))
    }
    return set
  }, [q, nodes, deptNames])

  // --- apply
  useEffect(() => window.electronAPI.onSparseProgress(({ repoPath, receivedBytes }) => {
    if (repoPath !== rootPath) return
    setPhase(p => (p.kind === 'applying' ? { kind: 'applying', receivedBytes } : p))
  }), [rootPath])

  const runApply = useCallback(async () => {
    setPhase({ kind: 'applying', receivedBytes: 0 })
    const result = await sparse.apply(draft)
    if (result.success) {
      setEdited(null)
      setPhase({ kind: 'done' })
      window.setTimeout(() => setPhase(p => (p.kind === 'done' ? { kind: 'idle' } : p)), 2600)
    } else {
      setPhase({ kind: 'failed', offline: !!result.offline, message: result.error ?? '変更できませんでした' })
    }
  }, [sparse, draft])

  const startApply = useCallback(async () => {
    if (diff.excluded.length > 0) {
      setPhase({ kind: 'checking' })
      const res = await window.electronAPI.sparseUncommittedChanges(rootPath, diff.excluded)
      if (res.success && res.files.length > 0) {
        setPhase({ kind: 'confirm', files: res.files })
        return
      }
    }
    await runApply()
  }, [diff.excluded, rootPath, runApply])

  const busy = phase.kind === 'applying' || phase.kind === 'checking'

  // --- keyboard: ↑↓ move, → expand, ← collapse / go to parent, Space toggles
  const onTreeKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = Array.from(treeRef.current?.querySelectorAll<HTMLElement>('[data-row]') ?? [])
    const i = rows.findIndex(r => r === document.activeElement)
    if (i === -1) return
    const row = rows[i]
    const path = row.dataset.path ?? ''
    if (e.key === 'ArrowDown') { e.preventDefault(); rows[Math.min(rows.length - 1, i + 1)]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); rows[Math.max(0, i - 1)]?.focus() }
    else if (e.key === 'Home') { e.preventDefault(); rows[0]?.focus() }
    else if (e.key === 'End') { e.preventDefault(); rows[rows.length - 1]?.focus() }
    else if (e.key === 'ArrowRight') {
      e.preventDefault()
      if (row.dataset.expandable === 'true' && !expanded.has(path)) void toggleExpanded(path)
      else rows[i + 1]?.focus()
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      if (expanded.has(path)) void toggleExpanded(path)
      else {
        const parent = path.split('/').slice(0, -1).join('/')
        rows.find(r => r.dataset.path === parent)?.focus()
      }
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      if (row.dataset.disabled !== 'true') setDraft(d => toggleFolder(d, path))
    }
  }

  const renderRow = (path: string, depth: number) => {
    const node = nodes.get(path)
    if (!node) return null
    if (visibleSet && !visibleSet.has(path)) return null
    const state = folderCheckState(draft, path)
    const before = folderCheckState(applied, path)
    const isOpen = expanded.has(path) || (!!visibleSet && (children.get(path) ?? []).some(c => visibleSet.has(c)))
    const loading = loadingDirs.has(path)
    const deptName = depth === 0 ? deptNames.get(pathKey(path)) : undefined
    const inherited = state === 'inherited'
    const out = state === 'unchecked' || inherited
    const changed = (before === 'unchecked') !== (state === 'unchecked') && !inherited && before !== 'inherited'
    const labelId = `dl-row-${path}`
    return (
      <div key={path} role="none">
        <div
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={node.hasChildren ? isOpen : undefined}
          aria-selected={false}
          aria-labelledby={labelId}
          tabIndex={0}
          data-row
          data-path={path}
          data-expandable={node.hasChildren ? 'true' : 'false'}
          data-disabled={inherited ? 'true' : 'false'}
          onClick={() => { if (node.hasChildren) void toggleExpanded(path); else if (!inherited) setDraft(d => toggleFolder(d, path)) }}
          title={inherited ? '上のフォルダごとダウンロードしない設定です。このフォルダだけをダウンロードすることはできません' : undefined}
          className={`group flex h-9 cursor-pointer select-none items-center gap-2 rounded-md pr-3 text-[13px] outline-none transition-colors hover:bg-zinc-50 focus-visible:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500/50 dark:hover:bg-white/[0.04] dark:focus-visible:bg-white/[0.04] ${inherited ? 'cursor-default' : ''}`}
          style={{ paddingLeft: 8 + depth * 20 }}
        >
          <button
            type="button"
            tabIndex={-1}
            aria-label={isOpen ? '閉じる' : '開く'}
            onClick={e => { e.stopPropagation(); if (node.hasChildren) void toggleExpanded(path) }}
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-200/60 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-white/10 dark:hover:text-zinc-200 ${node.hasChildren ? '' : 'invisible'}`}
          >
            {loading ? <SpinnerGap size={12} className="animate-spin" /> : <CaretRight size={12} weight="bold" className={`transition-transform ${isOpen ? 'rotate-90' : ''}`} />}
          </button>
          <TriCheckbox
            state={state === 'partial' ? 'mixed' : state === 'checked' ? 'checked' : 'unchecked'}
            disabled={inherited}
            onToggle={() => setDraft(d => toggleFolder(d, path))}
            label={`${deptName ?? node.name}をダウンロードする`}
          />
          {out
            ? <FolderSimpleDashed size={16} className="shrink-0 text-zinc-400 dark:text-zinc-500" />
            : <FolderSimple size={16} weight="fill" className="shrink-0 text-zinc-400 dark:text-zinc-500" />}
          <span id={labelId} className={`min-w-0 flex-1 truncate ${out ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-800 dark:text-zinc-100'}`}>
            {deptName ?? node.name.normalize('NFC')}
            {deptName && deptName !== node.name && <span className="ml-2 font-mono text-[11px] text-zinc-400 dark:text-zinc-500">{node.name}/</span>}
          </span>
          {node.private && (
            <span className="flex shrink-0 items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400" title="非公開フォルダ（見られる人だけに届きます）">
              <Lock size={12} weight="bold" aria-hidden="true" />
              非公開
            </span>
          )}
          {changed && (
            <span className={`shrink-0 rounded-full px-1.5 py-px text-[10.5px] font-medium ${state === 'unchecked'
              ? 'bg-zinc-100 text-zinc-600 dark:bg-white/[0.08] dark:text-zinc-300'
              : 'bg-indigo-50 text-indigo-700 dark:bg-indigo-400/10 dark:text-indigo-300'}`}>
              {state === 'unchecked' ? 'ダウンロードしない' : 'ダウンロードする'}
            </span>
          )}
          <span className={`w-20 shrink-0 text-right text-xs tabular-nums ${out ? 'text-zinc-400 dark:text-zinc-600' : 'text-zinc-500 dark:text-zinc-400'}`}>
            {formatBytes(node.size)}
          </span>
        </div>
        {isOpen && (
          <div role="group">
            {(children.get(path) ?? []).map(c => renderRow(c, depth + 1))}
            {!loading && children.has(path) && (children.get(path) ?? []).length === 0 && (
              <div className="h-8 text-xs leading-8 text-zinc-400 dark:text-zinc-500" style={{ paddingLeft: 8 + (depth + 1) * 20 + 48 }}>サブフォルダはありません</div>
            )}
          </div>
        )}
      </div>
    )
  }

  // Departments first (in their order), then the other folders.
  const deptOrder = new Map(departments.map((d, i) => [pathKey(d.folder), i]))
  const rootRows = [...(children.get(ROOT) ?? [])].sort((a, b) =>
    (deptOrder.get(pathKey(a)) ?? Infinity) - (deptOrder.get(pathKey(b)) ?? Infinity))

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1 space-y-5 px-8 pb-6 pt-7">
        <SectionHeader
          title="ダウンロードするフォルダ"
          description="チェックを外したフォルダはこのPCにダウンロードされません。サーバーには残っていて、いつでもダウンロードし直せます。チームの誰かが新しく作ったフォルダは自動でダウンロードされます。"
        />

        {/* Summary */}
        <Card className="px-5 py-4">
          <div className="flex items-baseline justify-between gap-4">
            <p className="text-[13px] text-zinc-600 dark:text-zinc-300">
              {total === null || downloadedNow === null
                ? <span>このPCのダウンロード状況{offline && <span className="text-zinc-400 dark:text-zinc-500">（大きさはサーバーに接続すると表示されます）</span>}</span>
                : <><span className="text-[15px] font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{formatBytes(downloadedNow)}</span><span className="text-zinc-500 dark:text-zinc-400"> をダウンロード済み（全体 {formatBytes(total)}）</span></>}
            </p>
            {dirty && downloadedAfter !== null && downloadedNow !== null && (
              <p className="shrink-0 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                適用後 <span className="font-medium text-zinc-800 dark:text-zinc-100">{formatBytes(downloadedAfter)}</span>
                <span className={downloadedAfter >= downloadedNow ? 'text-indigo-600 dark:text-indigo-300' : ''}>（{downloadedAfter >= downloadedNow ? '+' : '−'}{formatBytes(Math.abs(downloadedAfter - downloadedNow))}）</span>
              </p>
            )}
          </div>
          <div className="mt-3">
            <UsageBar value={dirty ? downloadedAfter : downloadedNow} max={total} pendingFrom={dirty ? downloadedNow : undefined} />
          </div>
          <div className="mt-2 flex items-center gap-4 text-[11px] text-zinc-500 dark:text-zinc-400">
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-indigo-500 dark:bg-indigo-400" />ダウンロード済み</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-zinc-200 dark:bg-white/15" />ダウンロードしていない</span>
            {applied.length > 0 && <span className="ml-auto">{applied.length} 個のフォルダをダウンロードしていません</span>}
          </div>
        </Card>

        {offline && !loadError && (
          <Callout tone="offline" title="サーバーに接続できません" role="status">
            フォルダの大きさは表示できません。フォルダをダウンロードするには、インターネットにつながっている必要があります（ダウンロードしない設定はオフラインでもできます）。
          </Callout>
        )}

        {/* Tree */}
        <Card className="overflow-hidden">
          <div className="flex items-center gap-3 border-b border-zinc-100 px-3 py-2 dark:border-white/[0.06]">
            <label className="relative flex flex-1 items-center">
              <MagnifyingGlass size={14} className="pointer-events-none absolute left-2.5 text-zinc-400" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="フォルダを検索（開いたフォルダの中から）"
                aria-label="フォルダを検索"
                className="h-8 w-full rounded-md border border-transparent bg-zinc-50 pl-8 pr-7 text-[13px] text-zinc-800 placeholder:text-zinc-400 focus:border-zinc-300 focus:bg-white focus:outline-none dark:bg-white/[0.04] dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-white/15 dark:focus:bg-transparent"
              />
              {query && (
                <button type="button" aria-label="検索をクリア" onClick={() => setQuery('')} className="absolute right-2 rounded p-0.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
                  <X size={12} />
                </button>
              )}
            </label>
            <div className="flex shrink-0 items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
              <span className="w-20 text-right">大きさ</span>
            </div>
          </div>

          <div ref={treeRef} role="tree" aria-label="ダウンロードするフォルダ" aria-busy={initialLoading} onKeyDown={onTreeKeyDown} className="p-1.5">
            {initialLoading && rootRows.length === 0 ? (
              <div className="space-y-1 p-1" aria-label="読み込み中">
                {[64, 48, 56, 40, 52].map((w, i) => (
                  <div key={i} className="flex h-9 items-center gap-3 px-2">
                    <div className="h-4 w-4 rounded bg-zinc-100 dark:bg-white/[0.06]" />
                    <div className="h-3 animate-pulse rounded bg-zinc-100 dark:bg-white/[0.06]" style={{ width: `${w}%` }} />
                    <div className="ml-auto h-3 w-12 animate-pulse rounded bg-zinc-100 dark:bg-white/[0.06]" />
                  </div>
                ))}
              </div>
            ) : loadError ? (
              <div className="p-3">
                <Callout tone="error" title="フォルダの一覧を読み込めませんでした" action={<Button size="sm" onClick={() => void loadRoot()}>再読み込み</Button>}>
                  {loadError}
                </Callout>
              </div>
            ) : rootRows.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                <FolderSimpleDashed size={28} className="text-zinc-300 dark:text-zinc-600" />
                <p className="text-[13px] text-zinc-500 dark:text-zinc-400">まだフォルダがありません</p>
              </div>
            ) : visibleSet && visibleSet.size === 0 ? (
              <p className="py-10 text-center text-[13px] text-zinc-500 dark:text-zinc-400">「{query}」に一致するフォルダはありません</p>
            ) : (
              rootRows.map(p => renderRow(p, 0))
            )}
          </div>
        </Card>

        <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          フォルダのチェックを外すと、そのフォルダの中のフォルダもすべてダウンロードしなくなります（中の一部だけをダウンロードすることはできません）。
          ダウンロードしていないフォルダには、このPCからファイルを保存できません。
        </p>
      </div>

      {/* Sticky footer: the draft */}
      {(dirty || phase.kind !== 'idle') && (
        <div className="sticky bottom-0 border-t border-zinc-200 bg-white/95 px-8 py-3 backdrop-blur dark:border-white/[0.08] dark:bg-zinc-900/95">
          {phase.kind === 'applying' ? (
            <div className="space-y-2" role="status" aria-live="polite">
              <div className="flex items-center justify-between text-[13px]">
                <span className="text-zinc-700 dark:text-zinc-200">
                  {diff.included.length > 0 ? 'ダウンロードしています…' : '適用しています…'}
                </span>
                {phase.receivedBytes > 0 && (
                  <span className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                    {formatBytes(phase.receivedBytes)}{expectedDownload ? ` / 約 ${formatBytes(expectedDownload)}` : ' 受信'}
                  </span>
                )}
              </div>
              {expectedDownload && phase.receivedBytes > 0
                // Received pack bytes vs. the folders' file sizes: compression makes it approximate, so it never shows 100%.
                ? <UsageBar value={Math.min(phase.receivedBytes, expectedDownload * 0.97)} max={expectedDownload} />
                : <IndeterminateBar />}
            </div>
          ) : phase.kind === 'done' ? (
            <div className="flex h-8 items-center gap-2 text-[13px] text-zinc-700 dark:text-zinc-200" role="status">
              <CheckCircle size={16} weight="fill" className="text-emerald-500" />適用しました
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1 text-[13px]">
                {phase.kind === 'failed' ? (
                  <span role="alert" className={`inline-flex items-center gap-2 ${phase.offline ? 'text-zinc-700 dark:text-zinc-200' : 'text-red-600 dark:text-red-300'}`}>
                    {phase.offline ? <WifiSlash size={16} className="shrink-0 text-zinc-500" /> : <WarningCircle size={16} weight="fill" className="shrink-0" />}
                    {phase.offline ? 'インターネットにつながっているときにダウンロードできます。何も変更していません。' : `適用できませんでした：${phase.message}`}
                  </span>
                ) : (
                  <span className="text-zinc-600 dark:text-zinc-300">
                    未適用の変更：
                    {diff.included.length > 0 && <span className="ml-1">{diff.included.length} 個をダウンロード</span>}
                    {diff.included.length > 0 && diff.excluded.length > 0 && <span className="text-zinc-400">・</span>}
                    {diff.excluded.length > 0 && <span>{diff.excluded.length} 個をダウンロードしない</span>}
                  </span>
                )}
              </div>
              <Button variant="ghost" onClick={() => { setEdited(null); setPhase({ kind: 'idle' }) }} disabled={busy}>取り消す</Button>
              <Button variant="primary" onClick={() => void startApply()} disabled={busy || !dirty}>
                {phase.kind === 'checking' && <SpinnerGap size={14} className="animate-spin" />}
                適用
              </Button>
            </div>
          )}
        </div>
      )}

      {phase.kind === 'confirm' && (
        <ConfirmUnsynced
          files={phase.files}
          onCancel={() => setPhase({ kind: 'idle' })}
          onConfirm={() => void runApply()}
        />
      )}
    </div>
  )
}

function ConfirmUnsynced({ files, onCancel, onConfirm }: { files: string[]; onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { cancelRef.current?.focus() }, [])
  const shown = files.slice(0, 6)
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-zinc-900/30 p-6 backdrop-blur-[1px] dark:bg-black/50"
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }}
    >
      <div role="alertdialog" aria-modal="true" aria-labelledby="dl-confirm-title" aria-describedby="dl-confirm-body" className="w-full max-w-[460px] rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-white/10 dark:bg-zinc-900">
        <h3 id="dl-confirm-title" className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-50">まだ同期していない変更があります</h3>
        <div id="dl-confirm-body" className="mt-2 space-y-3 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-300">
          <p>
            ダウンロードしないようにするフォルダに、同期していない変更が {files.length} 件あります。
            このまま進めると、これらの変更は共有されず、次の同期で <code className="rounded bg-zinc-100 px-1 py-px text-[12px] dark:bg-white/10">.backups</code> フォルダに保存されます（消えることはありません）。
          </p>
          <ul className="max-h-36 overflow-y-auto rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2 font-mono text-[12px] text-zinc-700 dark:border-white/[0.06] dark:bg-white/[0.03] dark:text-zinc-300">
            {shown.map(f => <li key={f} className="truncate">{f.normalize('NFC')}</li>)}
            {files.length > shown.length && <li className="font-sans text-zinc-500">ほか {files.length - shown.length} 件</li>}
          </ul>
          <p className="text-zinc-500 dark:text-zinc-400">共有したい場合は、先に同期してからダウンロードしない設定にしてください。</p>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelRef} onClick={onCancel}>キャンセル</Button>
          <Button variant="danger" onClick={onConfirm}>.backups に保存して進める</Button>
        </div>
      </div>
    </div>
  )
}
