'use client'

import { useId, useMemo, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Eye, Info, LockSimple, User, UserCircle, X } from '@phosphor-icons/react'

import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { EditorPicker } from '@/components/permissions/editor-picker'
import { EffectivePreview } from '@/components/permissions/effective-preview'
import { OutdatedClientsDialog, useOutdatedClients } from '@/components/permissions/outdated-clients-dialog'
import { SubfolderPicker } from '@/components/permissions/subfolder-picker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  departmentsApi,
  permissionsApi,
  type Department,
  type InheritedRules,
  type Member,
  type PermissionScope,
  type RuleInput,
} from '@/lib/api'
import {
  describeRules,
  draftFromRules,
  editorKey,
  losingEdit,
  previewAccess,
  rulesAsInputs,
  rulesFromDraft,
  sameDraft,
  subjectName,
  type AccessDraft,
  type EditMode,
  type Editor,
} from '@/lib/edit-access'
import { describeError } from '@/lib/errors'
import { isSameOrAncestorPath } from '@/lib/scope-paths'
import { useQuery } from '@/lib/use-query'
import { cn } from '@/lib/utils'

export interface EditorNode {
  path: string
  /** Absent for a sub-folder picked in the editor that has no scope yet. */
  scope: PermissionScope | undefined
  name: string
  kind: PermissionScope['kind']
}

interface PendingConfirm {
  title: string
  description: ReactNode
  confirmLabel: string
  run: () => Promise<void>
}

/**
 * What `path` follows when it has no rules of its own: the server's
 * `inheritedFrom`, or — for a folder without a scope, or an older server —
 * the nearest place above it that has rules (or what that place inherits).
 */
export function inheritedFor(path: string, scope: PermissionScope | undefined, scopes: PermissionScope[]): InheritedRules | null {
  if (path === '') return null
  if (scope && scope.inheritedFrom !== undefined) return scope.inheritedFrom
  const above = scopes
    .filter((s) => s.path !== path && isSameOrAncestorPath(s.path, path))
    .sort((a, b) => b.path.length - a.path.length)
  for (const a of above) {
    if (!a.inherited) return { scopeId: a.id, path: a.path, rules: a.rules, summary: a.effectiveSummary }
    if (a.inheritedFrom !== undefined) return a.inheritedFrom
  }
  return null
}

/** The department whose folder contains `path` (for its managers). */
function departmentOf(path: string, departments: Department[]): Department | undefined {
  return departments.find((d) => path !== '' && isSameOrAncestorPath(d.folder.normalize('NFC'), path))
}

function draftLabel(draft: AccessDraft, members: Member[]): string {
  if (draft.mode === 'inherit') return '上の階層と同じ'
  if (draft.mode === 'everyone') return '全員'
  return describeRules(rulesFromDraft(draft).map((r, i) => ({ ...r, id: String(i), subjectLabel: '', canRead: true })), members)
}

/**
 * Who may edit one place (company / department / folder), chosen like sharing
 * settings: 上の階層と同じ / 全員 / 指定した人だけ. The choice is a draft until
 * 保存, which replaces the place's whole rule set in one request; the preview
 * follows the draft. Saving asks first when someone would lose edit access,
 * and the toast offers 元に戻す (the previous rule set is sent back).
 */
export function ScopeEditor({
  companyId,
  node,
  scopes,
  members,
  departments,
  editable,
  nameOf,
  onChanged,
  onPickSubfolder,
}: {
  companyId: string
  node: EditorNode
  scopes: PermissionScope[]
  members: Member[]
  departments: Department[]
  editable: boolean
  nameOf: (path: string) => string
  onChanged: () => void
  onPickSubfolder: (path: string) => void
}) {
  const effective = useQuery(`effective:${companyId}:${node.path}`, () => permissionsApi.effective(companyId, node.path))
  const department = departmentOf(node.path, departments)
  const managers = useQuery(department ? `managers:${companyId}:${department.id}` : null, () =>
    departmentsApi.getManagers(companyId, department!.id)
  )
  const managerIds = (managers.data?.managers ?? []).map((m) => m.userId)

  const isRoot = node.path === ''
  const ownRules = useMemo(() => (node.scope && !node.scope.inherited ? node.scope.rules : []), [node.scope])
  const inherited = useMemo(() => inheritedFor(node.path, node.scope, scopes), [node.path, node.scope, scopes])
  const saved = useMemo(() => draftFromRules(ownRules), [ownRules])

  const [draft, setDraft] = useState<AccessDraft>(() => {
    if (saved.draft.mode === 'specific') return saved.draft
    // Offer the parent's chosen people as a starting point for 指定した人だけ.
    const parent = inherited ? draftFromRules(inherited.rules).draft : null
    return { ...saved.draft, editors: parent?.mode === 'specific' ? parent.editors : [] }
  })
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  const groupName = useId()

  const dirty = saved.custom ? touched : !sameDraft(draft, saved.draft)

  // Who can edit as saved, and under the draft — computed the same way.
  const access = (d: AccessDraft) =>
    d.mode === 'inherit'
      ? previewAccess(members, inherited?.rules ?? [], inherited?.path ?? '')
      : previewAccess(members, rulesFromDraft(d), node.path)
  const draftPreview = dirty ? access(draft) : null

  const overriddenBelow = scopes.filter((s) => s.path !== node.path && isSameOrAncestorPath(node.path, s.path) && !s.inherited).length
  const inheritedText = inherited ? describeRules(inherited.rules, members) : '全員'
  const inheritedFromName = inherited ? nameOf(inherited.path) : ''

  const update = (next: AccessDraft) => {
    setDraft(next)
    setTouched(true)
  }
  const setMode = (mode: EditMode) => update({ ...draft, mode })
  const toggleEditor = (e: Editor) => {
    const k = editorKey(e)
    const editors = draft.editors.some((x) => editorKey(x) === k) ? draft.editors.filter((x) => editorKey(x) !== k) : [...draft.editors, e]
    update({ mode: 'specific', editors })
  }
  const discard = () => {
    setDraft({ ...saved.draft, editors: saved.draft.mode === 'specific' ? saved.draft.editors : draft.editors })
    setTouched(false)
  }

  const send = async (rules: RuleInput[], force = false) => {
    await permissionsApi.replaceScope(companyId, node.path, rules, { force })
    onChanged()
  }

  // 409 OUTDATED_CLIENTS: someone who would lose edit access is on an app
  // that cannot recover from it. Explain, and let owners/admins force.
  const { catchOutdated, dialogProps: outdatedDialog } = useOutdatedClients()

  const undo = (previous: RuleInput[]) => {
    const failed = (err: unknown) => toast.error('元に戻せませんでした', { description: describeError(err) })
    send(previous).then(
      () => toast.success('元に戻しました'),
      (err: unknown) => {
        const forced = async () => {
          try {
            await send(previous, true)
            toast.success('元に戻しました')
          } catch (e) {
            failed(e)
            throw e
          }
        }
        if (!catchOutdated(err, forced)) failed(err)
      }
    )
  }

  const save = () => {
    const before = ownRules.length > 0 || isRoot ? previewAccess(members, ownRules, node.path) : access({ mode: 'inherit', editors: [] })
    const after = access(draft)
    const lost = losingEdit(before, after)
    const previous = rulesAsInputs(ownRules)
    const label = draftLabel(draft, members)
    const rules = rulesFromDraft(draft)
    const run = async (force = false) => {
      setBusy(true)
      try {
        await send(rules, force)
        setTouched(false)
        toast.success(`${node.name}：編集できる人を「${label}」にしました`, {
          action: { label: '元に戻す', onClick: () => undo(previous) },
        })
      } catch (err) {
        // Not an error toast: the dialog explains (and resolves) it.
        if (!force && catchOutdated(err, () => run(true))) return
        toast.error('権限を保存できませんでした', { description: describeError(err) })
        throw err
      } finally {
        setBusy(false)
      }
    }
    if (lost.length === 0) {
      void run().catch(() => {})
      return
    }
    const names = lost.map((m) => m.name || m.email || '名前未設定')
    setConfirm({
      title: `${lost.length}人が編集できなくなります`,
      description: (
        <>
          <p>
            「{node.name}」とその中のフォルダで、次の人はファイルを変更して同期できなくなります（閲覧と手元での編集はできます）。
          </p>
          <ul className="list-disc pl-5 text-foreground">
            {names.slice(0, 6).map((n, i) => (
              <li key={i}>{n}</li>
            ))}
            {names.length > 6 && <li>ほか{names.length - 6}人</li>}
          </ul>
          <p>保存したあとでも、お知らせの「元に戻す」で戻せます。</p>
        </>
      ),
      confirmLabel: '保存する',
      run: () => run(),
    })
  }

  const chosenLabel = (e: Editor) => (e.subjectType === 'role' ? '役割: メンバー' : subjectName(e, members))

  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold">{node.name} の設定</h2>
            {saved.draft.mode === 'inherit' ? <Badge variant="outline">継承</Badge> : <Badge variant="brand">個別の設定</Badge>}
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{isRoot ? '会社のフォルダ全体' : node.path}</p>
        </div>
        {editable ? (
          <SubfolderPicker companyId={companyId} path={node.path} onPick={onPickSubfolder} />
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <LockSimple size={14} />
            確認のみ
          </span>
        )}
      </div>

      <section className="space-y-3 px-5 py-4">
        <fieldset disabled={!editable || busy} className="space-y-2">
          <legend className="mb-2 text-sm font-medium">編集できる人</legend>

          {saved.custom && (
            <p className="flex gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs">
              <Info size={16} className="mt-px shrink-0 text-warning" />
              <span>
                ここには以前の画面で作った細かい設定（{ownRules.map((r) => `${subjectName(r, members)}: ${r.canWrite ? '編集できる' : '閲覧のみ'}`).join('、')}）があります。下の選択で保存すると置き換わります。
              </span>
            </p>
          )}

          {!isRoot && (
            <ModeOption
              name={groupName}
              value="inherit"
              checked={draft.mode === 'inherit'}
              onSelect={setMode}
              title="上の階層と同じ"
              detail={`「${inheritedFromName}」と同じ：${inheritedText}`}
            />
          )}
          <ModeOption
            name={groupName}
            value="everyone"
            checked={draft.mode === 'everyone'}
            onSelect={setMode}
            title="全員"
            detail="この会社の全員が編集できます"
          />
          <div
            className={cn(
              'rounded-lg border transition-colors',
              draft.mode === 'specific' && 'border-brand/50 bg-brand/5'
            )}
          >
            <ModeOption
              name={groupName}
              value="specific"
              checked={draft.mode === 'specific'}
              onSelect={setMode}
              title="指定した人だけ"
              detail="選んだ人と役割だけが編集できます"
              bare
            />
            {draft.mode === 'specific' && (
              <div className="space-y-2 px-3 pb-3 pl-10">
                <ul className="flex flex-wrap items-center gap-1.5" aria-label="編集できる人">
                  {draft.editors.map((e) => {
                    const label = chosenLabel(e)
                    const Icon = e.subjectType === 'role' ? UserCircle : User
                    return (
                      <li
                        key={editorKey(e)}
                        className="inline-flex h-7 items-center gap-1 rounded-full border bg-background pr-1 pl-2.5 text-sm"
                      >
                        <Icon size={14} className="text-muted-foreground" aria-hidden="true" />
                        <span className="max-w-48 truncate">{label}</span>
                        {e.subjectType === 'user' && managerIds.includes(e.subjectId) && (
                          <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">責任者</span>
                        )}
                        <button
                          type="button"
                          onClick={() => toggleEditor(e)}
                          aria-label={`${label}を外す`}
                          className="flex size-5 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        >
                          <X size={12} weight="bold" />
                        </button>
                      </li>
                    )
                  })}
                  <li>
                    <EditorPicker
                      members={members}
                      chosen={draft.editors}
                      managerIds={managerIds}
                      disabled={!editable || busy}
                      onToggle={toggleEditor}
                    />
                  </li>
                </ul>
                <p className="text-xs text-muted-foreground">
                  {draft.editors.length === 0
                    ? 'まだ誰も選ばれていません。このままだと、オーナーと管理者だけが編集できます。'
                    : 'それ以外の人は「閲覧のみ」になります。'}
                  オーナーと管理者は常に編集できます。
                </p>
              </div>
            )}
          </div>
        </fieldset>

        {overriddenBelow > 0 && (
          <p className="text-xs text-muted-foreground">
            中のフォルダのうち{overriddenBelow}か所は個別に設定されていて、そちらの設定が優先されます。
          </p>
        )}

        <div className="flex items-start gap-3 rounded-lg bg-muted/40 px-3 py-2.5">
          <Eye size={18} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="text-sm">
            <div>
              <span className="font-medium">閲覧できる人：</span>全員
            </div>
            <p className="text-xs text-muted-foreground">見せない設定は今後のアップデートで対応予定です。</p>
          </div>
        </div>
      </section>

      {editable && (dirty || busy) && (
        <div
          className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-2 border-t bg-card/95 px-5 py-3 backdrop-blur supports-[backdrop-filter]:bg-card/80"
          role="region"
          aria-label="未保存の変更"
        >
          <span className="text-sm">
            未保存の変更：<span className="font-medium">{draftLabel(draft, members)}</span>
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={discard} disabled={busy}>
              取り消す
            </Button>
            <Button size="sm" onClick={save} disabled={busy}>
              {busy ? '保存しています…' : '保存'}
            </Button>
          </div>
        </div>
      )}

      <section aria-labelledby="preview-heading" className="space-y-3 border-t px-5 py-4">
        <div>
          <h3 id="preview-heading" className="text-sm font-medium">
            プレビュー：この場所で誰が何をできるか
          </h3>
          <p className="text-xs text-muted-foreground">
            {dirty ? '選んでいる設定で保存した場合の結果です。' : 'いま保存されている設定での結果です。'}
          </p>
        </div>
        <EffectivePreview effective={effective} draft={draftPreview} path={node.path} nameOf={nameOf} />
      </section>

      <OutdatedClientsDialog {...outdatedDialog} />

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm?.title ?? ''}
        description={confirm?.description}
        confirmLabel={confirm?.confirmLabel ?? ''}
        onConfirm={async () => {
          await confirm?.run()
        }}
      />
    </Card>
  )
}

function ModeOption({
  name,
  value,
  checked,
  onSelect,
  title,
  detail,
  bare = false,
}: {
  name: string
  value: EditMode
  checked: boolean
  onSelect: (mode: EditMode) => void
  title: string
  detail: string
  /** Inside a container that draws the border itself. */
  bare?: boolean
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-3 px-3 py-2.5 has-[:disabled]:cursor-default',
        !bare && 'rounded-lg border transition-colors',
        !bare && checked && 'border-brand/50 bg-brand/5'
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onSelect(value)}
        className="mt-0.5 size-4 shrink-0 accent-brand outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{detail}</span>
      </span>
    </label>
  )
}
