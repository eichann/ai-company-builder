'use client'

import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { ArrowUUpLeft, LockSimple, User, UserCircle, UsersThree, X } from '@phosphor-icons/react'

import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { AccessToggle } from '@/components/permissions/access-toggle'
import { AddRulePopover } from '@/components/permissions/add-rule-popover'
import { EffectivePreview } from '@/components/permissions/effective-preview'
import { SubfolderPicker } from '@/components/permissions/subfolder-picker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { permissionsApi, type Member, type PermissionRule, type PermissionScope, type RuleSubject } from '@/lib/api'
import { describeError } from '@/lib/errors'
import { deepestAncestor } from '@/lib/scope-paths'
import { useQuery } from '@/lib/use-query'

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

const PRECEDENCE = { user: 0, role: 1, everyone: 2 } as const

function subjectOf(r: PermissionRule): RuleSubject {
  if (r.subjectType === 'everyone') return { subjectType: 'everyone', subjectId: null }
  if (r.subjectType === 'role') return { subjectType: 'role', subjectId: 'member' }
  return { subjectType: 'user', subjectId: r.subjectId ?? '' }
}

function subjectTitle(r: PermissionRule): string {
  if (r.subjectType === 'role') return `役割「${r.subjectLabel}」`
  return r.subjectLabel
}

function subjectHint(r: PermissionRule, members: Member[]): string {
  if (r.subjectType === 'everyone') return 'この会社の全員（個別・役割のルールがある人を除く）'
  if (r.subjectType === 'role') return `役割が「${r.subjectLabel}」の人（個人のルールがある人を除く）`
  return members.find((m) => m.userId === r.subjectId)?.email ?? '個人'
}

/**
 * Rules of one place (company / department / folder): own rules or the
 * inherited ones, access toggles, add / remove, back to inheriting, and the
 * effective-access preview. Changing an inherited rule (or adding one) gives
 * the place its own copy of the inherited rules first — the server does that
 * copy, so nobody else's access changes.
 */
export function ScopeEditor({
  companyId,
  node,
  scopes,
  members,
  editable,
  nameOf,
  onChanged,
  onPickSubfolder,
}: {
  companyId: string
  node: EditorNode
  scopes: PermissionScope[]
  members: Member[]
  editable: boolean
  nameOf: (path: string) => string
  onChanged: () => void
  onPickSubfolder: (path: string) => void
}) {
  const effective = useQuery(`effective:${companyId}:${node.path}`, () => permissionsApi.effective(companyId, node.path))
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)

  const inherits = !node.scope || node.scope.inherited
  const withRules = scopes.filter((s) => !s.inherited && s.path !== node.path)
  const governingPath = inherits ? deepestAncestor(withRules.map((s) => s.path), node.path) : node.path
  const governing = inherits ? withRules.find((s) => s.path === governingPath) : node.scope
  const rules = [...(governing?.rules ?? [])].sort((a, b) => PRECEDENCE[a.subjectType] - PRECEDENCE[b.subjectType])
  const isRoot = node.path === ''
  const everyoneCount = rules.filter((r) => r.subjectType === 'everyone').length

  const refresh = () => {
    onChanged()
    effective.reload()
  }

  /** Run a change, report it, and offer undo when one is given. */
  const apply = async (work: () => Promise<unknown>, message: string, undo?: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await work()
      refresh()
      toast.success(message, undo ? {
        action: {
          label: '元に戻す',
          onClick: () => {
            undo().then(
              () => {
                refresh()
                toast.success('元に戻しました')
              },
              (err: unknown) => toast.error('元に戻せませんでした', { description: describeError(err) })
            )
          },
        },
      } : undefined)
    } catch (err) {
      toast.error('権限を変更できませんでした', { description: describeError(err) })
      throw err
    } finally {
      setBusy(false)
    }
  }

  const undoBreak = () => (node.scope ? permissionsApi.resetScope(companyId, node.scope.id) : resetCreatedScope())
  // A folder without a scope got one from the change; find it to reset it.
  const resetCreatedScope = async () => {
    const fresh = await permissionsApi.get(companyId)
    const created = fresh.scopes.find((s) => s.path === node.path)
    if (created) await permissionsApi.resetScope(companyId, created.id)
  }

  const changeAccess = (rule: PermissionRule, canWrite: boolean) => {
    const who = subjectTitle(rule)
    const message = `${node.name}：${who}を「${canWrite ? '編集できる' : '閲覧のみ'}」にしました`
    const run = () =>
      inherits
        ? apply(() => permissionsApi.setRule(companyId, node.path, subjectOf(rule), canWrite), message, undoBreak)
        : apply(() => permissionsApi.updateRule(companyId, rule.id, canWrite), message, () => permissionsApi.updateRule(companyId, rule.id, !canWrite))
    // Taking edit rights from a whole group is the change people regret.
    if (!canWrite && rule.subjectType !== 'user') {
      setConfirm({
        title: `${who}を「閲覧のみ」にしますか？`,
        description: (
          <>
            <p>
              「{node.name}」とその中のフォルダで、{who === '全員' ? '個別のルールがない人' : `${who}の人`}はファイルを変更して同期できなくなります（閲覧と手元での編集はできます）。
            </p>
            <p>オーナーと管理者は引き続き編集できます。</p>
          </>
        ),
        confirmLabel: '閲覧のみにする',
        run,
      })
    } else {
      void run().catch(() => {})
    }
  }

  const removeRule = (rule: PermissionRule) => {
    const who = subjectTitle(rule)
    setConfirm({
      title: `${who}のルールを削除しますか？`,
      description:
        rules.length === 1 ? (
          <p>これが最後のルールです。削除すると「{node.name}」は上の階層のルールに従います。</p>
        ) : (
          <p>{who}には、この場所のほかのルール（役割・全員）が適用されます。</p>
        ),
      confirmLabel: '削除する',
      run: () => apply(() => permissionsApi.deleteRule(companyId, rule.id), `${node.name}：${who}のルールを削除しました`, () =>
        permissionsApi.setRule(companyId, node.path, subjectOf(rule), rule.canWrite)),
    })
  }

  const reset = () => {
    if (!node.scope) return
    const scopeId = node.scope.id
    const parentName = nameOf(deepestAncestor(withRules.map((s) => s.path), node.path) ?? '')
    setConfirm({
      title: '上の階層のルールに合わせますか？',
      description: (
        <>
          <p>「{node.name}」の個別のルール（{rules.length}件）をすべて削除し、「{parentName}」のルールに従うようにします。</p>
          <p>この操作は元に戻せません。必要なら、あとでもう一度ルールを追加してください。</p>
        </>
      ),
      confirmLabel: 'ルールを削除して合わせる',
      run: () => apply(() => permissionsApi.resetScope(companyId, scopeId), `${node.name}：上の階層のルールに合わせました`),
    })
  }

  const add = (subject: RuleSubject, canWrite: boolean, label: string) =>
    apply(
      () => permissionsApi.setRule(companyId, node.path, subject, canWrite),
      `${node.name}：${label}を「${canWrite ? '編集できる' : '閲覧のみ'}」にしました`,
      inherits ? undoBreak : undefined
    )

  const removeBlockedReason = (r: PermissionRule): string | null => {
    if (inherits) return null
    if (isRoot && rules.length === 1) return '会社全体には少なくとも1つのルールが必要です'
    if (r.subjectType === 'everyone' && everyoneCount === 1 && rules.length > 1) {
      return 'ほかのルールがある間は「全員」のルールは削除できません（全員が閲覧できるようにするためです）'
    }
    return null
  }

  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold">{node.name}</h2>
            {inherits ? <Badge variant="outline">継承</Badge> : <Badge variant="brand">個別のルール</Badge>}
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{isRoot ? '会社のフォルダ全体' : node.path}</p>
        </div>
        {!editable && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <LockSimple size={14} />
            確認のみ
          </span>
        )}
      </div>

      <section aria-labelledby="rules-heading" className="space-y-3 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="rules-heading" className="text-sm font-medium">
            {inherits ? `「${nameOf(governingPath ?? '')}」から継承しているルール` : 'この場所のルール'}
          </h3>
          {editable && (
            <div className="flex flex-wrap items-center gap-1">
              <SubfolderPicker companyId={companyId} path={node.path} onPick={onPickSubfolder} />
              <AddRulePopover members={members} existing={rules} disabled={busy} onAdd={add} />
            </div>
          )}
        </div>
        {inherits && editable && (
          <p className="text-xs text-muted-foreground">
            ここで変更すると、いまのルールをこの場所にコピーしてから変更します。ほかの人の権限は変わりません。
          </p>
        )}

        {rules.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
            ルールがありません。オーナーと管理者以外は編集できません。
          </p>
        ) : (
          <ul className="divide-y rounded-lg border" aria-label="ルール">
            {rules.map((r) => {
              const blocked = removeBlockedReason(r)
              const SubjectIcon = r.subjectType === 'everyone' ? UsersThree : r.subjectType === 'role' ? UserCircle : User
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                  <SubjectIcon size={20} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="min-w-0 flex-1 basis-40">
                    <div className="truncate text-sm font-medium">{subjectTitle(r)}</div>
                    <div className="truncate text-xs text-muted-foreground">{subjectHint(r, members)}</div>
                  </div>
                  <AccessToggle
                    canWrite={r.canWrite}
                    onChange={(w) => changeAccess(r, w)}
                    disabled={!editable || busy}
                    label={`${subjectTitle(r)}の権限`}
                  />
                  {editable && !inherits && (
                    blocked ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span tabIndex={0} className="rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                            <Button variant="ghost" size="icon-sm" disabled aria-label={`${subjectTitle(r)}のルールは削除できません`}>
                              <X size={16} />
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-64">{blocked}</TooltipContent>
                      </Tooltip>
                    ) : (
                      <Button variant="ghost" size="icon-sm" disabled={busy} onClick={() => removeRule(r)} aria-label={`${subjectTitle(r)}のルールを削除`}>
                        <X size={16} />
                      </Button>
                    )
                  )}
                </li>
              )
            })}
          </ul>
        )}

        <p className="text-xs text-muted-foreground">
          優先順位：個人のルール ＞ 役割のルール ＞ 全員のルール。いちばん近い階層のルールだけが使われ、中のフォルダにも同じルールが適用されます。
        </p>

        {editable && !inherits && !isRoot && (
          <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={reset} disabled={busy}>
            <ArrowUUpLeft />
            上の階層のルールに合わせる
          </Button>
        )}
      </section>

      <section aria-labelledby="preview-heading" className="space-y-3 border-t px-5 py-4">
        <div>
          <h3 id="preview-heading" className="text-sm font-medium">
            プレビュー：この場所で誰が何をできるか
          </h3>
          <p className="text-xs text-muted-foreground">閲覧は現在、全員ができます。</p>
        </div>
        <EffectivePreview effective={effective} path={node.path} nameOf={nameOf} />
      </section>

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
