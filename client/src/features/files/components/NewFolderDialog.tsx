// Over 300 lines on purpose: one dialog's form, its server answers and their wording.
// 「新しいフォルダ…」 with 公開 / 非公開 (permission plan stage 3c, §1.3 A).
//
// 公開 creates the folder on disk as before. 非公開 asks the server, which
// checks the permission, creates the folder's own repository and its rules,
// and refuses a taken name with one sentence that never says why. The folder
// then reaches this computer at the next sync (the caller starts one).
//
// Only people create private folders, here: the chat has no tool for it.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Globe, LockSimple, MagnifyingGlass, Plus, SpinnerGap, X } from '@phosphor-icons/react'
import { Button, Callout } from '../../../components/settings/ui'
import {
  NOT_ALLOWED_REASON,
  OFFLINE_REASON,
  canCreatePrivateAt,
  defaultViewerIds,
  isFullAccessRole,
  lastSegment,
  reachCount,
  type CreatePrivateFolderResult,
  type MyPrivateFolder,
  type PrivateFolderCreateContext,
  type PrivateFolderMemberOption,
} from '../../../../shared/private-folder-ui'
import { MANAGERS_MAY_CHANGE_VIEWERS } from '../../../../shared/private-folder-help'
import { PrivateFolderHelpLink, PrivateFolderHelpPanel } from './PrivateFolderHelp'
// The server's department folder-name rule (private folder names follow it too).
import { isValidFolderName } from '../../../../../shared/core/names'
import { createPrivateFolder, getPrivateFolderCreateContext } from '../api'

export interface NewFolderDialogProps {
  isOpen: boolean
  companyId: string | undefined
  meId: string | null | undefined
  /** Company-relative parent ('' = the company root). */
  parentRel: string
  /** How the place is shown (e.g. 「人事部 / 評価」). */
  placeLabel: string
  /** The private folder the parent is inside: plain folders there are private already. */
  insidePrivate: MyPrivateFolder | null
  onCancel: () => void
  /** 公開 (or inside a private folder): create on disk as before. Answers why it was refused (the dialog stays open). */
  onCreatePlain: (name: string) => Promise<string | null | void> | void
  /** 非公開 was created on the server. */
  onCreatedPrivate: (result: Extract<CreatePrivateFolderResult, { success: true }>, name: string) => void
}

type ContextState =
  | { status: 'loading' }
  | { status: 'ready'; context: PrivateFolderCreateContext }
  | { status: 'offline' }
  | { status: 'error'; message: string }

export function NewFolderDialog(props: NewFolderDialogProps) {
  if (!props.isOpen) return null
  return <NewFolderForm {...props} />
}

function NewFolderForm({ companyId, meId, parentRel, placeLabel, insidePrivate, onCancel, onCreatePlain, onCreatedPrivate }: NewFolderDialogProps) {
  const titleId = useId()
  const nameId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState<'public' | 'private'>('public')
  const [ctx, setCtx] = useState<ContextState>({ status: 'loading' })
  const [viewers, setViewers] = useState<string[] | null>(null)
  const [editorsMode, setEditorsMode] = useState<'all' | 'specific'>('all')
  const [editors, setEditors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [outdated, setOutdated] = useState<{ members: string[]; canForce: boolean } | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 30) }, [])

  // Who may create where, the members and the department's managers — only
  // needed for 非公開, so not inside a private folder.
  useEffect(() => {
    if (insidePrivate || !companyId) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { setCtx({ status: 'offline' }); return }
    let active = true
    getPrivateFolderCreateContext(companyId, parentRel)
      .then(res => {
        if (!active) return
        if (res.success) setCtx({ status: 'ready', context: res.context })
        else setCtx(res.offline ? { status: 'offline' } : { status: 'error', message: res.error })
      })
      .catch(() => { if (active) setCtx({ status: 'offline' }) })
    return () => { active = false }
  }, [companyId, parentRel, insidePrivate])

  const context = ctx.status === 'ready' ? ctx.context : null
  const allowed = !!context && canCreatePrivateAt(parentRel, context)
  const privateDisabledReason =
    ctx.status === 'loading' ? '確認しています…'
      : ctx.status === 'offline' ? OFFLINE_REASON
        : ctx.status === 'error' ? OFFLINE_REASON
          : !allowed ? NOT_ALLOWED_REASON
            : null
  const isPrivate = visibility === 'private' && !privateDisabledReason && !insidePrivate

  const viewerIds = useMemo(
    () => viewers ?? (context ? defaultViewerIds(meId, context) : []),
    [viewers, context, meId],
  )
  const members = context?.members ?? []
  const admins = members.filter(m => isFullAccessRole(m.role))
  const reach = reachCount(viewerIds, members)
  const editorReach = editorsMode === 'all' ? reach : admins.length + editors.filter(id => viewerIds.includes(id)).length

  const trimmed = name.trim()
  const invalid = isPrivate && trimmed !== '' && !isValidFolderName(trimmed)
  const canSubmit = trimmed !== '' && !invalid && !busy

  const submit = async (force = false) => {
    if (!canSubmit && !force) return
    setError(null)
    setNameError(null)
    if (!isPrivate) {
      setBusy(true)
      try {
        const refused = await onCreatePlain(trimmed)
        if (refused) setNameError(refused)
      } finally { setBusy(false) }
      return
    }
    if (!companyId) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { setError(OFFLINE_REASON); return }
    setBusy(true)
    try {
      const res = await createPrivateFolder(companyId, {
        parentPath: parentRel,
        name: trimmed,
        viewers: viewerIds,
        ...(editorsMode === 'specific' ? { editors: editors.filter(id => viewerIds.includes(id)) } : {}),
        ...(force ? { force: true } : {}),
      })
      if (res.success) { onCreatedPrivate(res, trimmed); return }
      if (res.offline) setError(OFFLINE_REASON)
      else if (res.code === 'FOLDER_NAME_UNAVAILABLE') setNameError(res.error)
      else if (res.code === 'OUTDATED_CLIENTS') setOutdated({ members: res.outdatedMembers ?? [], canForce: !!res.canForce })
      else setError(describeCreateError(res))
    } finally {
      setBusy(false)
    }
  }

  const toggleViewer = (id: string) => {
    const next = viewerIds.includes(id) ? viewerIds.filter(v => v !== id) : [...viewerIds, id]
    setViewers(next)
    setEditors(e => e.filter(x => next.includes(x)))
  }

  const nameOf = (id: string) => {
    const m = members.find(x => x.userId === id)
    const n = m?.name || m?.email || '名前未設定'
    return id === meId ? `${n}（自分）` : n
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/30 p-6 backdrop-blur-[1px] dark:bg-black/50"
      onMouseDown={e => { if (e.target === e.currentTarget && !busy) onCancel() }}
      onKeyDown={e => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onCancel() } }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={e => { e.preventDefault(); void submit() }}
        className="flex max-h-[calc(100vh-3rem)] w-full max-w-[480px] flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-white/10 dark:bg-zinc-900"
      >
        <div className="flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-5">
          <div>
            <h3 id={titleId} className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-50">新しいフォルダ</h3>
            <p className="mt-1 text-[12px] text-zinc-500 dark:text-zinc-400">
              場所：<span className="text-zinc-700 dark:text-zinc-300">{placeLabel}</span>
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor={nameId} className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">名前</label>
            <input
              id={nameId}
              ref={inputRef}
              value={name}
              onChange={e => { setName(e.target.value); setNameError(null) }}
              placeholder="フォルダ名"
              autoComplete="off"
              aria-invalid={invalid || !!nameError || undefined}
              className="h-9 w-full rounded-lg border border-zinc-200 bg-white px-3 text-[13px] text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-white/10 dark:bg-zinc-950 dark:text-zinc-100"
            />
            {(nameError || invalid) && (
              <p className="text-[12px] text-red-600 dark:text-red-400">
                {nameError ?? 'フォルダ名に使えない文字が含まれています。日本語・英数字・「.」「_」「-」が使えます。'}
              </p>
            )}
          </div>

          {insidePrivate ? (
            <div className="flex gap-2.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3.5 py-3 text-[13px] text-indigo-900 dark:border-indigo-400/20 dark:bg-indigo-400/[0.08] dark:text-indigo-100">
              <LockSimple size={16} weight="fill" className="mt-0.5 shrink-0 text-indigo-500" />
              <p>
                非公開フォルダ「{lastSegment(insidePrivate.path)}」の中なので、このフォルダも非公開になります（{insidePrivate.viewerCount}人だけが見られます）。
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <span className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">公開範囲</span>
              <div role="radiogroup" aria-label="公開範囲" className="grid grid-cols-2 gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-white/[0.06]">
                <Segment checked={visibility === 'public'} onSelect={() => setVisibility('public')} icon={<Globe size={14} />} label="公開" />
                <Segment
                  checked={isPrivate}
                  disabled={!!privateDisabledReason}
                  onSelect={() => setVisibility('private')}
                  icon={ctx.status === 'loading' ? <SpinnerGap size={14} className="animate-spin" /> : <LockSimple size={14} weight={isPrivate ? 'fill' : 'regular'} />}
                  label="非公開"
                  title={privateDisabledReason ?? undefined}
                />
              </div>
              <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
                {privateDisabledReason && ctx.status !== 'loading'
                  ? privateDisabledReason
                  : isPrivate
                    ? '選んだ人だけに届きます。ほかの人には、フォルダの名前も表示されません。'
                    : '会社の全員に共有されます。'}
              </p>
            </div>
          )}

          {isPrivate && context && (
            <>
              <div className="relative space-y-1.5">
                <span className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">見られる人</span>
                <ul aria-label="見られる人" className="flex flex-wrap items-center gap-1.5">
                  {viewerIds.map(id => (
                    <li key={id} className="inline-flex h-7 items-center gap-1 rounded-full border border-zinc-200 bg-white pl-2.5 pr-1 text-[12px] text-zinc-800 dark:border-white/10 dark:bg-zinc-950 dark:text-zinc-200">
                      <span className="max-w-40 truncate">{nameOf(id)}</span>
                      {context.managerIds.includes(id) && <span className="rounded bg-zinc-100 px-1 text-[10px] text-zinc-500 dark:bg-white/10 dark:text-zinc-400">責任者</span>}
                      {id === meId ? <span className="w-1" /> : (
                        <button type="button" aria-label={`${nameOf(id)}を外す`} onClick={() => toggleViewer(id)} className="flex h-5 w-5 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-white/10 dark:hover:text-zinc-200">
                          <X size={11} weight="bold" />
                        </button>
                      )}
                    </li>
                  ))}
                  <li><MemberPicker members={members} chosen={viewerIds} managerIds={context.managerIds} meId={meId} onToggle={toggleViewer} /></li>
                </ul>
                <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
                  オーナー・管理者{admins.length > 0 ? `（${admins.length}人）` : ''}は常に見られます。
                  {context.department && MANAGERS_MAY_CHANGE_VIEWERS}
                </p>
              </div>

              <div className="space-y-1.5">
                <span className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">編集できる人</span>
                <div role="radiogroup" aria-label="編集できる人" className="space-y-1">
                  <Radio checked={editorsMode === 'all'} onSelect={() => setEditorsMode('all')} label="見られる人全員" />
                  <Radio checked={editorsMode === 'specific'} onSelect={() => { setEditorsMode('specific'); if (editors.length === 0) setEditors(viewerIds) }} label="指定した人だけ" />
                </div>
                {editorsMode === 'specific' && (
                  <ul aria-label="編集できる人" className="ml-6 grid grid-cols-2 gap-x-3 gap-y-1">
                    {viewerIds.map(id => (
                      <li key={id}>
                        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-zinc-700 dark:text-zinc-300">
                          <input type="checkbox" checked={editors.includes(id)} onChange={() => setEditors(e => (e.includes(id) ? e.filter(x => x !== id) : [...e, id]))} className="h-3.5 w-3.5 accent-indigo-600" />
                          <span className="truncate">{nameOf(id)}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div role="status" className="flex gap-2.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3.5 py-3 dark:border-indigo-400/20 dark:bg-indigo-400/[0.08]">
                <LockSimple size={16} weight="fill" className="mt-0.5 shrink-0 text-indigo-500" />
                <div className="text-[13px] text-indigo-950 dark:text-indigo-100">
                  <p className="font-medium">このフォルダとその中身は {reach} 人にだけ届きます</p>
                  <p className="mt-0.5 text-[12px] text-indigo-900/70 dark:text-indigo-200/70">
                    {editorReach === reach ? '全員が編集できます。' : `編集できるのは ${editorReach} 人です。`}
                    作成すると同期が始まり、あなたの手元に空のフォルダが現れます。
                  </p>
                  <div className="mt-1.5"><PrivateFolderHelpLink onOpen={() => setHelpOpen(true)} /></div>
                </div>
              </div>
            </>
          )}

          {outdated && (
            <Callout
              tone="warning"
              title="アプリの更新が必要なメンバーがいます"
              action={outdated.canForce ? <Button size="sm" variant="danger" onClick={() => { setOutdated(null); void submit(true) }} disabled={busy}>それでも作成する</Button> : undefined}
            >
              次のメンバーは古いアプリを使っているため、非公開フォルダを扱えません：{outdated.members.join('、') || '不明'}。
              {outdated.canForce ? '' : '先にアプリを更新してもらうか、管理者に作成を依頼してください。'}
            </Callout>
          )}
          {error && <Callout tone={error === OFFLINE_REASON ? 'offline' : 'error'}>{error}</Callout>}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-3 dark:border-white/[0.06]">
          <Button onClick={onCancel} disabled={busy}>キャンセル</Button>
          <Button type="submit" variant="primary" disabled={!canSubmit}>
            {busy ? <SpinnerGap size={14} className="animate-spin" /> : isPrivate ? <LockSimple size={14} weight="fill" /> : null}
            {isPrivate ? '非公開フォルダを作成' : '作成'}
          </Button>
        </div>
      </form>
      {helpOpen && <PrivateFolderHelpPanel onClose={() => setHelpOpen(false)} />}
    </div>
  )
}

function describeCreateError(res: Extract<CreatePrivateFolderResult, { success: false }>): string {
  switch (res.code) {
    case 'PARENT_NOT_FOUND': return 'この場所はまだサーバーにありません。先に同期してから作成してください。'
    case 'ALREADY_PRIVATE': return '非公開フォルダの中に作るフォルダは、自動的に非公開になります。'
    case 'INVALID_MEMBERS': return '見られる人の選び方に問題があります。画面を開き直してから選び直してください。'
    case 'FORCE_NOT_ALLOWED': return '古いアプリのメンバーがいるときに作成できるのは、オーナーと管理者だけです。'
  }
  if (res.status === 403) return NOT_ALLOWED_REASON
  if (res.status === 400 && /invalid folder name/i.test(res.error)) return 'フォルダ名に使えない文字が含まれています。日本語・英数字・「.」「_」「-」が使えます。'
  return `作成できませんでした（${res.error}）`
}

function Segment({ checked, disabled, onSelect, icon, label, title }: { checked: boolean; disabled?: boolean; onSelect: () => void; icon: ReactNode; label: string; title?: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      title={title}
      onClick={() => { if (!disabled) onSelect() }}
      className={`flex h-8 items-center justify-center gap-1.5 rounded-md text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 ${
        checked
          ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-50'
          : disabled
            ? 'cursor-not-allowed text-zinc-400 dark:text-zinc-600'
            : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

function Radio({ checked, onSelect, label }: { checked: boolean; onSelect: () => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[13px] text-zinc-800 dark:text-zinc-200">
      <input type="radio" checked={checked} onChange={onSelect} className="h-3.5 w-3.5 accent-indigo-600" />
      {label}
    </label>
  )
}

function MemberPicker({ members, chosen, managerIds, meId, onToggle }: {
  members: PrivateFolderMemberOption[]
  chosen: string[]
  managerIds: string[]
  meId: string | null | undefined
  onToggle: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const candidates = members
    .filter(m => !isFullAccessRole(m.role) && m.userId !== meId)
    .filter(m => !q || `${m.name ?? ''} ${m.email ?? ''}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => Number(managerIds.includes(b.userId)) - Number(managerIds.includes(a.userId)) || (a.name ?? '').localeCompare(b.name ?? '', 'ja'))
  return (
    <div>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-zinc-300 px-2.5 text-[12px] text-zinc-600 hover:border-zinc-400 hover:text-zinc-900 dark:border-white/20 dark:text-zinc-400 dark:hover:text-zinc-100">
        <Plus size={12} />追加
      </button>
      {open && (
        <div className="absolute inset-x-0 z-10 mt-1 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-white/10 dark:bg-zinc-900">
          <div className="flex items-center gap-1.5 border-b border-zinc-100 px-2.5 dark:border-white/[0.06]">
            <MagnifyingGlass size={13} className="text-zinc-400" />
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="名前・メールで検索" aria-label="見られる人を検索" className="h-8 w-full bg-transparent text-[12px] text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100" />
          </div>
          <ul className="max-h-52 overflow-y-auto py-1" aria-label="見られる人の候補">
            {candidates.length === 0 && <li className="px-3 py-2 text-[12px] text-zinc-500">該当する人がいません</li>}
            {candidates.map(m => {
              const on = chosen.includes(m.userId)
              return (
                <li key={m.userId}>
                  <button type="button" role="menuitemcheckbox" aria-checked={on} onClick={() => onToggle(m.userId)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-zinc-800 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-white/[0.04]">
                    <span className="min-w-0 flex-1 truncate">{m.name || m.email || '名前未設定'}</span>
                    {managerIds.includes(m.userId) && <span className="rounded bg-zinc-100 px-1 text-[10px] text-zinc-500 dark:bg-white/10 dark:text-zinc-400">責任者</span>}
                    <Check size={13} weight="bold" className={on ? 'text-indigo-600 dark:text-indigo-400' : 'opacity-0'} />
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
