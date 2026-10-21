'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import {
  CaretDown,
  CaretRight,
  CheckCircle,
  Key,
  LockSimple,
  Lightning,
  PencilSimpleSlash,
  UserFocus,
  WindowsLogo,
  Wrench,
} from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'

import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { companiesApi, pushRejectionsApi, type PushRejectionRecord } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { formatDateTime, formatRelative } from '@/lib/format'
import { explainRejection, rejectionShortLabel } from '@/lib/rejections'
import { useQuery } from '@/lib/use-query'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 25
const ALL = '__all__'

interface BuiltInRule {
  icon: Icon
  title: string
  marker: string | null
  body: string
  who: string
}

// What the server enforces on every push (server/src/templates/pre-receive-hook.sh),
// in the words a member's manager needs.
const BUILT_IN_RULES: BuiltInRule[] = [
  {
    icon: Wrench,
    title: '配布設定の保護',
    marker: 'PROTECTED_CONFIG',
    body: '.claude/settings.json・.mcp.json・.claude/hooks/ など、AIが確認なしにコマンドを実行する設定ファイルは、変更すると全員のPCで動きます。',
    who: '変更できるのはオーナー・管理者だけ',
  },
  {
    icon: Lightning,
    title: 'スキルの自動実行',
    marker: 'PROTECTED_CONFIG',
    body: 'スキル・サブエージェント・コマンドは誰でも共有できます。ただし hooks・mcpServers や !`コマンド` のように読み込み時に自動で動く部分を含むものは保護されます。',
    who: '自動実行を含むものはオーナー・管理者だけ',
  },
  {
    icon: UserFocus,
    title: '個人用フォルダ（.personal）',
    marker: 'PERSONAL_PATH',
    body: '.personal フォルダの中身は誰のものでも共有されません。誤って含めても、アプリが自動で共有対象から外して同期を続けます。',
    who: 'オーナー・管理者を含め全員に適用',
  },
  {
    icon: Key,
    title: '秘密情報の検出',
    marker: 'SECRET_DETECTED',
    body: 'APIキー・パスワード・秘密鍵などを含むファイルは共有を止めます。該当箇所を削除してから同期し直してください。',
    who: '全員に適用',
  },
  {
    icon: WindowsLogo,
    title: 'Windowsで使えない名前',
    marker: 'WINPATH_DETECTED',
    body: '< > : " \\ | ? * を含む名前、末尾がドットやスペースの名前、大文字・小文字だけが違う名前は、Windowsのメンバーの同期を壊すため共有を止めます。',
    who: '全員に適用',
  },
  {
    icon: PencilSimpleSlash,
    title: '編集権限',
    marker: 'WRITE_DENIED',
    body: '権限の画面で「閲覧のみ」にした場所のファイルを変更すると、その変更は共有されません。閲覧と手元での作業はできます。',
    who: 'ルールはオーナー・管理者と部署の責任者が設定（オーナー・管理者は常に編集可）',
  },
]

const WHO_CAN: Array<[string, string]> = [
  ['会社全体の権限ルール', 'オーナー・管理者'],
  ['部署とその中のフォルダの権限ルール', 'オーナー・管理者・その部署の責任者'],
  ['配布設定・自動実行を含むスキル', 'オーナー・管理者'],
  ['メンバーの役割の変更', 'オーナー'],
  ['メンバーの招待・削除、部署、会社名', 'オーナー・管理者'],
]

export default function SecurityPage() {
  const { role, isAdmin } = useCompany()

  if (role !== null && !isAdmin) {
    return (
      <>
        <PageHeader title="セキュリティ" />
        <EmptyState icon={LockSimple} title="このページはオーナーと管理者だけが使えます" />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="セキュリティ"
        description="同期のたびにサーバーが確認している組み込みのルールと、止められた同期の記録です。"
      />
      <div className="space-y-10">
        <section aria-labelledby="builtin-heading" className="space-y-3">
          <h2 id="builtin-heading" className="text-sm font-semibold">
            組み込みのルール
          </h2>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {BUILT_IN_RULES.map((r) => (
              <Card key={r.title} className="gap-2 px-5 py-4">
                <div className="flex items-center gap-2.5">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                    <r.icon size={18} />
                  </span>
                  <h3 className="text-sm font-semibold">{r.title}</h3>
                </div>
                <p className="text-sm text-muted-foreground">{r.body}</p>
                <p className="mt-auto pt-1 text-xs font-medium">{r.who}</p>
              </Card>
            ))}
          </div>
        </section>

        <section aria-labelledby="who-heading" className="space-y-3">
          <h2 id="who-heading" className="text-sm font-semibold">
            誰が何を変更できるか
          </h2>
          <Card className="py-0">
            <dl className="divide-y text-sm">
              {WHO_CAN.map(([what, who]) => (
                <div key={what} className="grid gap-1 px-5 py-3 sm:grid-cols-[1fr_auto] sm:gap-4">
                  <dt>{what}</dt>
                  <dd className="text-muted-foreground">{who}</dd>
                </div>
              ))}
            </dl>
          </Card>
        </section>

        {isAdmin && <RejectionHistory />}
      </div>
    </>
  )
}

function RejectionHistory() {
  const { companyId } = useCompany()
  const members = useQuery(`members:${companyId}`, () => companiesApi.getMembers(companyId))
  const [userId, setUserId] = useState(ALL)
  const [marker, setMarker] = useState(ALL)
  const filters = { userId: userId === ALL ? undefined : userId, marker: marker === ALL ? undefined : marker }
  const first = useQuery(`push-rejections:${companyId}:${userId}:${marker}`, () =>
    pushRejectionsApi.list(companyId, { ...filters, limit: PAGE_SIZE })
  )
  // Further pages, appended by "さらに表示"; tied to the filter they were loaded for.
  const [more, setMore] = useState<{ key: string; rows: PushRejectionRecord[] }>({ key: '', rows: [] })
  const [loadingMore, setLoadingMore] = useState(false)
  const key = `${userId}:${marker}`
  const extra = more.key === key ? more.rows : []
  const rows = [...(first.data?.rejections ?? []), ...extra]
  const total = first.data?.total ?? 0
  const markers = [...new Set([...(first.data?.markers ?? []), ...(marker !== ALL ? [marker] : [])])]

  const loadMore = async () => {
    setLoadingMore(true)
    try {
      const page = await pushRejectionsApi.list(companyId, { ...filters, limit: PAGE_SIZE, offset: rows.length })
      setMore({ key, rows: [...extra, ...page.rejections] })
    } catch (err) {
      toast.error('続きを読み込めませんでした', { description: describeError(err) })
    } finally {
      setLoadingMore(false)
    }
  }

  const filtered = userId !== ALL || marker !== ALL

  return (
    <section aria-labelledby="history-heading" className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="history-heading" className="text-sm font-semibold">
            止められた同期の記録
          </h2>
          <p className="text-sm text-muted-foreground">同期が進まないメンバーがいるときは、ここで理由とファイルを確認できます。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={userId} onValueChange={setUserId}>
            <SelectTrigger className="w-44" aria-label="メンバーで絞り込む">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>すべてのメンバー</SelectItem>
              {(members.data ?? []).map((m) => (
                <SelectItem key={m.userId} value={m.userId}>
                  {m.name || m.email || '名前未設定'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={marker} onValueChange={setMarker}>
            <SelectTrigger className="w-48" aria-label="種類で絞り込む">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>すべての種類</SelectItem>
              {markers.map((m) => (
                <SelectItem key={m} value={m}>
                  {rejectionShortLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {first.loading ? (
        <ListSkeleton rows={3} />
      ) : first.error && !first.data ? (
        <ErrorState error={first.error} onRetry={first.reload} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={CheckCircle}
          title={filtered ? '条件に合う記録はありません' : '止められた同期はありません'}
          description={filtered ? '絞り込みを解除すると、すべての記録を表示します。' : '共有できないファイルが含まれていると、ここに記録されます。'}
          action={
            filtered && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setUserId(ALL)
                  setMarker(ALL)
                }}
              >
                絞り込みを解除
              </Button>
            )
          }
        />
      ) : (
        <>
          <Card className="divide-y py-0">
            {rows.map((r) => (
              <RejectionRow key={r.id} rejection={r} />
            ))}
          </Card>
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span className="tabular-nums">
              {total}件中 {rows.length}件を表示
            </span>
            {rows.length < total && (
              <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? '読み込んでいます…' : 'さらに表示'}
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  )
}

const MAX_PATHS_COLLAPSED = 3

function RejectionRow({ rejection: r }: { rejection: PushRejectionRecord }) {
  const [open, setOpen] = useState(false)
  const explained = explainRejection(r.marker)
  const name = r.name || r.email || '不明なメンバー'
  const detailsId = `rejection-${r.id}`

  return (
    <div className="px-4 py-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={detailsId}
        className="flex w-full items-start gap-3 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <Avatar name={name} seed={r.userId} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium">{name}</span>
            <Badge variant={explained ? 'destructive' : 'outline'}>{rejectionShortLabel(r.marker)}</Badge>
            <span className="text-xs text-muted-foreground" title={formatDateTime(r.createdAt)}>
              {formatRelative(r.createdAt)}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">{explained?.title ?? r.marker}</p>
          {!open && r.paths.length > 0 && (
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
              {r.paths.slice(0, MAX_PATHS_COLLAPSED).join('、')}
              {r.paths.length > MAX_PATHS_COLLAPSED && ` ほか${r.paths.length - MAX_PATHS_COLLAPSED}件`}
            </p>
          )}
        </div>
        {open ? <CaretDown size={14} className="mt-1 shrink-0 text-muted-foreground" /> : <CaretRight size={14} className="mt-1 shrink-0 text-muted-foreground" />}
      </button>
      <div id={detailsId} hidden={!open} className={cn('mt-3 space-y-2 pl-10')}>
        <p className="text-xs text-muted-foreground">{formatDateTime(r.createdAt)}</p>
        {explained && <p className="text-sm">{explained.advice}</p>}
        {r.paths.length > 0 ? (
          <ul className="space-y-0.5 rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs" aria-label="対象のファイル">
            {r.paths.map((p) => (
              <li key={p} className="break-all">
                {p}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">ファイルの一覧は記録されていません。</p>
        )}
      </div>
    </div>
  )
}
