'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  CaretDown,
  CaretUp,
  CaretUpDown,
  Copy,
  DotsThree,
  LinkSimple,
  MagnifyingGlass,
  UserMinus,
  UserPlus,
  Users,
  X,
} from '@phosphor-icons/react'

import { ConfirmByTypingDialog } from '@/components/app/confirm-by-typing'
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  clientActivityApi,
  companiesApi,
  departmentsApi,
  invitationsApi,
  overviewApi,
  type ClientActivity,
  type ClientBuild,
  type Department,
  type Invitation,
  type Member,
  type Overview,
} from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import { copyText } from '@/lib/clipboard'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { compareBuilds, formatBuild, formatDate, formatDateTime, formatRelative, latest, parseServerDate, roleLabel } from '@/lib/format'
import { departmentsByManager, useDepartmentManagers } from '@/lib/managers'
import { useQuery, type QueryResult } from '@/lib/use-query'
import { cn } from '@/lib/utils'

type BuildStatus = 'latest' | 'outdated' | 'unknown'

interface Row {
  member: Member
  name: string
  managed: Department[]
  activity: ClientActivity | undefined
  buildStatus: BuildStatus
  lastSync: string | null
}

type SortKey = 'name' | 'role' | 'app' | 'lastSync'

const ROLE_ORDER = { owner: 0, admin: 1, member: 2 } as const
const STATUS_ORDER: Record<BuildStatus, number> = { outdated: 0, unknown: 1, latest: 2 }

/**
 * The overview's list is authoritative for members active in the last 30
 * days; anyone else is compared with the newest build seen in the company.
 */
function buildStatusOf(
  userId: string,
  activity: ClientActivity | undefined,
  overview: Overview | undefined,
  newest: ClientBuild | null
): BuildStatus {
  if (overview?.attention.outdatedClients.some((m) => m.userId === userId)) return 'outdated'
  const build = activity?.build
  if (!build) return 'unknown'
  return newest && compareBuilds(build, newest) < 0 ? 'outdated' : 'latest'
}

export default function MembersPage() {
  const { companyId, isAdmin } = useCompany()
  const { user } = useAuth()
  const members = useQuery(`members:${companyId}`, () => companiesApi.getMembers(companyId))
  const departments = useQuery(`departments:${companyId}`, () => departmentsApi.list(companyId))
  const managers = useDepartmentManagers(companyId, departments.data)
  // Build and sync activity are only visible to owners and admins.
  const activity = useQuery(isAdmin ? `client-activity:${companyId}` : null, () => clientActivityApi.list(companyId))
  const overview = useQuery(isAdmin ? `overview:${companyId}` : null, () => overviewApi.get(companyId))
  const invitations = useQuery(isAdmin ? `invitations:${companyId}` : null, () => invitationsApi.list(companyId))

  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'role', dir: 'asc' })
  const [inviteOpen, setInviteOpen] = useState(false)
  const [removing, setRemoving] = useState<Row | null>(null)

  const rows = useMemo<Row[]>(() => {
    if (!members.data) return []
    const managedBy = departmentsByManager(departments.data, managers.data)
    const activityBy = new Map((activity.data ?? []).map((a) => [a.userId, a]))
    let newest: ClientBuild | null = null
    for (const a of activity.data ?? []) {
      if (a.build && (!newest || compareBuilds(a.build, newest) > 0)) newest = a.build
    }
    return members.data.map((m) => {
      const a = activityBy.get(m.userId)
      return {
        member: m,
        name: m.name || m.email || '名前未設定',
        managed: managedBy[m.userId] ?? [],
        activity: a,
        buildStatus: buildStatusOf(m.userId, a, overview.data, newest),
        lastSync: latest(a?.lastFetchAt, a?.lastPushAt),
      }
    })
  }, [members.data, departments.data, managers.data, activity.data, overview.data])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? rows.filter((r) => r.name.toLowerCase().includes(q) || (r.member.email ?? '').toLowerCase().includes(q))
      : rows
    const dir = sort.dir === 'asc' ? 1 : -1
    const time = (v: string | null) => parseServerDate(v)?.getTime() ?? 0
    return [...filtered].sort((a, b) => {
      let c = 0
      if (sort.key === 'name') c = a.name.localeCompare(b.name, 'ja')
      else if (sort.key === 'role') c = ROLE_ORDER[a.member.role] - ROLE_ORDER[b.member.role]
      else if (sort.key === 'app') c = STATUS_ORDER[a.buildStatus] - STATUS_ORDER[b.buildStatus]
      else c = time(a.lastSync) - time(b.lastSync)
      return c * dir || a.name.localeCompare(b.name, 'ja')
    })
  }, [rows, query, sort])

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'lastSync' ? 'desc' : 'asc' }))

  const removeMember = async () => {
    if (!removing) return
    try {
      await companiesApi.removeMember(companyId, removing.member.userId)
      toast.success(`${removing.name} さんを会社から削除しました`)
      setRemoving(null)
      members.reload()
    } catch (err) {
      toast.error('メンバーを削除できませんでした', { description: describeError(err) })
      throw err
    }
  }

  return (
    <>
      <PageHeader
        title="メンバー"
        description={
          isAdmin
            ? 'メンバーの役割・担当部署・アプリの状態を確認できます。'
            : 'この会社のメンバーと担当部署です。'
        }
        actions={
          isAdmin && (
            <Button onClick={() => setInviteOpen(true)}>
              <UserPlus />
              メンバーを招待
            </Button>
          )
        }
      />

      {members.loading ? (
        <ListSkeleton rows={5} />
      ) : members.error && !members.data ? (
        <ErrorState error={members.error} onRetry={members.reload} />
      ) : (
        <div className="space-y-4">
          <div className="relative max-w-xs">
            <MagnifyingGlass size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="名前・メールで検索"
              aria-label="メンバーを検索"
              className="pl-8"
            />
          </div>

          {(!!activity.error || !!overview.error) && (
            <p className="text-sm text-muted-foreground">
              アプリの状態を読み込めませんでした。{' '}
              <button
                type="button"
                className="font-medium text-foreground underline underline-offset-4"
                onClick={() => {
                  activity.reload()
                  overview.reload()
                }}
              >
                再読み込み
              </button>
            </p>
          )}

          <Card className="overflow-hidden py-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <SortableHead label="メンバー" k="name" sort={sort} onSort={toggleSort} className="pl-4" />
                  <SortableHead label="役割" k="role" sort={sort} onSort={toggleSort} />
                  <TableHead>部署の責任者</TableHead>
                  {isAdmin && <SortableHead label="アプリ" k="app" sort={sort} onSort={toggleSort} />}
                  {isAdmin && <SortableHead label="最終同期" k="lastSync" sort={sort} onSort={toggleSort} />}
                  {isAdmin && (
                    <TableHead className="w-12 pr-4">
                      <span className="sr-only">操作</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((r) => (
                  <TableRow key={r.member.userId}>
                    <TableCell className="pl-4">
                      <div className="flex items-center gap-3">
                        <Avatar name={r.name} seed={r.member.userId} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 truncate font-medium">
                            {r.name}
                            {r.member.userId === user?.id && <span className="text-xs font-normal text-muted-foreground">(あなた)</span>}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">{r.member.email}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={r.member.role === 'member' ? 'outline' : r.member.role === 'owner' ? 'default' : 'brand'}>
                        {roleLabel(r.member.role)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {managers.loading ? (
                        <span className="text-muted-foreground">…</span>
                      ) : r.managed.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {r.managed.map((d) => (
                            <span key={d.id} className="inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs">
                              <span className="size-2 rounded-full" style={{ backgroundColor: d.color }} aria-hidden="true" />
                              {d.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    {isAdmin && (
                      <TableCell>
                        <AppCell row={r} loading={activity.loading} />
                      </TableCell>
                    )}
                    {isAdmin && (
                      <TableCell className="whitespace-nowrap">
                        {activity.loading ? (
                          <span className="text-muted-foreground">…</span>
                        ) : r.lastSync ? (
                          <span title={formatDateTime(r.lastSync)}>{formatRelative(r.lastSync)}</span>
                        ) : (
                          <span className="text-muted-foreground">記録なし</span>
                        )}
                      </TableCell>
                    )}
                    {isAdmin && (
                      <TableCell className="pr-4 text-right">
                        {r.member.role !== 'owner' && r.member.userId !== user?.id && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon-sm" aria-label={`${r.name} の操作`}>
                                <DotsThree size={18} weight="bold" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(r)}>
                                <UserMinus />
                                会社から削除
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {visible.length === 0 && (
              <div className="border-t px-4 py-10 text-center text-sm text-muted-foreground">
                「{query}」に一致するメンバーはいません
              </div>
            )}
          </Card>

          {rows.length === 1 && isAdmin && !query && (
            <EmptyState
              icon={Users}
              title="まだメンバーはあなただけです"
              description="招待リンクを作成して、一緒に使うメンバーに送りましょう。"
              action={
                <Button variant="outline" onClick={() => setInviteOpen(true)}>
                  <UserPlus />
                  メンバーを招待
                </Button>
              }
            />
          )}
        </div>
      )}

      {isAdmin && (
        <PendingInvitations companyId={companyId} invitations={invitations} onInvite={() => setInviteOpen(true)} />
      )}

      {isAdmin && (
        <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} companyId={companyId} onCreated={invitations.reload} />
      )}

      <ConfirmByTypingDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="メンバーを会社から削除"
        description={
          <>
            <p>
              {removing?.name} さんは、この会社のファイルやAIスキルを同期できなくなります。本人のPCにあるファイルは削除されません。
            </p>
            <p className="mt-2">もう一度参加してもらうには、新しい招待リンクが必要です。</p>
          </>
        }
        confirmText={removing?.name ?? ''}
        confirmLabel="削除する"
        onConfirm={removeMember}
      />
    </>
  )
}

function SortableHead({
  label,
  k,
  sort,
  onSort,
  className,
}: {
  label: string
  k: SortKey
  sort: { key: SortKey; dir: 'asc' | 'desc' }
  onSort: (k: SortKey) => void
  className?: string
}) {
  const active = sort.key === k
  const SortIcon = !active ? CaretUpDown : sort.dir === 'asc' ? CaretUp : CaretDown
  return (
    <TableHead className={className} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn(
          '-ml-1.5 inline-flex items-center gap-1 rounded px-1.5 py-1 outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
          active && 'text-foreground'
        )}
      >
        {label}
        <SortIcon size={12} className={cn(!active && 'opacity-50')} />
      </button>
    </TableHead>
  )
}

const STATUS_BADGE: Record<BuildStatus, { label: string; variant: 'success' | 'warning' | 'outline' }> = {
  latest: { label: '最新', variant: 'success' },
  outdated: { label: '古い', variant: 'warning' },
  unknown: { label: '不明', variant: 'outline' },
}

function AppCell({ row, loading }: { row: Row; loading: boolean }) {
  if (loading) return <span className="text-muted-foreground">…</span>
  const badge = STATUS_BADGE[row.buildStatus]
  const a = row.activity
  const detail = a?.clientVersion ? formatBuild(a.build, a.clientVersion) : a?.lastSeenAt ? 'バージョン情報なし' : '未接続'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* The version text folds away below lg; the tooltip keeps it reachable. */}
        <span className="inline-flex cursor-default items-center gap-2 rounded whitespace-nowrap outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" tabIndex={0}>
          <Badge variant={badge.variant}>{badge.label}</Badge>
          <span className={cn('hidden text-sm tabular-nums lg:inline', !a?.clientVersion && 'text-muted-foreground')}>{detail}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <div>{detail}</div>
        {a?.clientVersion && <div className="opacity-70">{a.clientVersion}</div>}
        {a?.clientPlatform && <div>{platformLabel(a.clientPlatform)}</div>}
        {a?.lastSeenAt && <div>最終接続 {formatDateTime(a.lastSeenAt)}</div>}
      </TooltipContent>
    </Tooltip>
  )
}

function platformLabel(p: string): string {
  if (p.startsWith('darwin') || p.startsWith('mac')) return 'Mac'
  if (p.startsWith('win')) return 'Windows'
  if (p.startsWith('linux')) return 'Linux'
  return p
}

function inviteUrl(token: string): string {
  return `${window.location.origin}/invite/${token}`
}

function InviteDialog({
  open,
  onOpenChange,
  companyId,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  companyId: string
  onCreated: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open && <InviteForm companyId={companyId} onCreated={onCreated} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function InviteForm({ companyId, onCreated, onDone }: { companyId: string; onCreated: () => void; onDone: () => void }) {
  const [role, setRole] = useState<'member' | 'admin'>('member')
  const [days, setDays] = useState('7')
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<Invitation | null>(null)

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const inv = await invitationsApi.create(companyId, role, Number(days))
      setCreated(inv)
      onCreated()
    } catch (err) {
      toast.error('招待リンクを作成できませんでした', { description: describeError(err) })
    } finally {
      setBusy(false)
    }
  }

  if (created) {
    const url = inviteUrl(created.token)
    return (
      <div className="grid gap-4">
        <DialogHeader>
          <DialogTitle>招待リンクを作成しました</DialogTitle>
          <DialogDescription>
            このリンクを招待する人に送ってください。リンクは1回だけ使え、{formatDate(created.expiresAt)} まで有効です。
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input readOnly value={url} aria-label="招待リンク" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <Button
            type="button"
            variant="outline"
            onClick={async () => {
              if (await copyText(url)) toast.success('リンクをコピーしました')
              else toast.error('コピーできませんでした', { description: 'リンクを選択して手動でコピーしてください。' })
            }}
          >
            <Copy />
            コピー
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onDone}>完了</Button>
        </DialogFooter>
      </div>
    )
  }

  return (
    <form onSubmit={create} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>メンバーを招待</DialogTitle>
        <DialogDescription>招待リンクを作成します。リンクを開いた人がアカウントを作成して参加できます。</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="invite-role">役割</Label>
          <Select value={role} onValueChange={(v) => setRole(v as 'member' | 'admin')}>
            <SelectTrigger id="invite-role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">メンバー</SelectItem>
              <SelectItem value="admin">管理者</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="invite-days">有効期限</Label>
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger id="invite-days">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">1日</SelectItem>
              <SelectItem value="7">7日</SelectItem>
              <SelectItem value="30">30日</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {role === 'admin'
          ? '管理者は、メンバーの招待・削除や部署の設定など、この管理画面のほぼすべての操作ができます。'
          : 'メンバーは、会社のファイルやAIスキルを同期して使えます。管理画面の設定は変更できません。'}
      </p>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          キャンセル
        </Button>
        <Button type="submit" disabled={busy}>
          <LinkSimple />
          {busy ? '作成しています…' : '招待リンクを作成'}
        </Button>
      </DialogFooter>
    </form>
  )
}

function PendingInvitations({
  companyId,
  invitations,
  onInvite,
}: {
  companyId: string
  invitations: QueryResult<Invitation[]>
  onInvite: () => void
}) {
  const [revoking, setRevoking] = useState<string | null>(null)

  const pending = (invitations.data ?? []).filter((i) => !i.isUsed && !i.isExpired)

  const revoke = async (inv: Invitation) => {
    setRevoking(inv.id)
    try {
      await invitationsApi.delete(companyId, inv.id)
      toast.success('招待リンクを無効にしました')
      invitations.reload()
    } catch (err) {
      toast.error('招待リンクを無効にできませんでした', { description: describeError(err) })
    } finally {
      setRevoking(null)
    }
  }

  return (
    <section aria-labelledby="pending-heading" className="mt-10 space-y-3">
      <div>
        <h2 id="pending-heading" className="text-sm font-semibold">
          未使用の招待リンク
        </h2>
        <p className="text-sm text-muted-foreground">まだ誰も使っていない、有効期限内のリンクです。</p>
      </div>
      {invitations.loading ? (
        <ListSkeleton rows={2} />
      ) : invitations.error && !invitations.data ? (
        <ErrorState error={invitations.error} onRetry={invitations.reload} />
      ) : pending.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
          未使用の招待リンクはありません
          <Button variant="outline" size="sm" onClick={onInvite}>
            <UserPlus />
            メンバーを招待
          </Button>
        </div>
      ) : (
        <Card className="divide-y py-0">
          {pending.map((inv) => (
            <div key={inv.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <div className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <LinkSimple size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {roleLabel(inv.role)}として招待
                </div>
                <div className="text-xs text-muted-foreground">
                  {inv.createdByName || inv.createdByEmail || '不明'} が {formatDate(inv.createdAt)} に作成 · {formatDate(inv.expiresAt)} まで有効
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    if (await copyText(inviteUrl(inv.token))) toast.success('リンクをコピーしました')
                    else toast.error('コピーできませんでした')
                  }}
                >
                  <Copy />
                  リンクをコピー
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="この招待リンクを無効にする"
                      disabled={revoking === inv.id}
                      onClick={() => revoke(inv)}
                    >
                      <X size={16} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>無効にする</TooltipContent>
                </Tooltip>
              </div>
            </div>
          ))}
        </Card>
      )}
    </section>
  )
}
