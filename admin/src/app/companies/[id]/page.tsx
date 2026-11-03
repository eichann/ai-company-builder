'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import {
  ArrowRight,
  CheckCircle,
  Circle,
  ClockCounterClockwise,
  Copy,
  DownloadSimple,
  FolderSimpleDashed,
  HandWaving,
  PlugsConnected,
  ProhibitInset,
  Question,
  TreeStructure,
  Users,
} from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'

import { DepartmentIcon } from '@/components/app/department-icon'
import { ORPHANED_DESCRIPTION, ORPHANED_TITLE } from '@/components/permissions/orphaned-scopes'
import { EmptyState, ErrorState, PageHeader } from '@/components/app/states'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  companiesApi,
  departmentsApi,
  homeApi,
  type AdminHome,
  type Overview,
  type OverviewMember,
  type PushRejection,
  type SetupStepId,
} from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { formatBuild, formatDateTime, formatRelative, latest, parseBuild, roleLabel } from '@/lib/format'
import { SUMMARY_LABELS } from '@/lib/permission-labels'
import { explainRejection } from '@/lib/rejections'
import { useQuery } from '@/lib/use-query'
import { cn } from '@/lib/utils'

export default function OverviewPage() {
  const { isAdmin, role, managedDepartmentIds } = useCompany()
  if (role === null) return <OverviewSkeleton />
  if (isAdmin || managedDepartmentIds.length > 0) return <HomeView />
  return <MemberOverview />
}

/** 「最初にやること」 (管理画面の見直し 2-1): what each step is, where it opens, and the one-line hint shown on the next one. */
const STEPS: Record<SetupStepId, { title: string; hint: string; path: string }> = {
  departments: { title: '部署をつくる', hint: '会社のフォルダは部署ごとに分かれます。', path: 'departments' },
  members: { title: 'メンバーを招く', hint: '招待リンクを作って送ります。リンクを開いた人が参加します。', path: 'members' },
  'department-members': { title: '部署に人を入れ、部署の管理役を決める', hint: 'どの部署にも、所属する人を1人以上入れます。部署の管理役は1部署に1人いると安心です。', path: 'departments' },
  google: { title: 'Google をつなぐ', hint: '会社の登録は運用担当者が代わりにします。運用担当者に「Google をつないでほしい」と伝えてください。', path: 'integrations' },
  'minutes-folder': { title: '議事録の置き場所を選ぶ', hint: '会議が終わると、AI がここの議事録を読み、「議事録を確認する」が届きます。', path: 'integrations' },
  holidays: { title: '会社の休みを確かめる', hint: '夏休み・年末年始を足すか、「足すものはない」を押します。', path: 'advanced/calendar' },
}

function HomeView() {
  const { companyId, isAdmin, canViewAgentEvents } = useCompany()
  const home = useQuery(`home:${companyId}`, () => homeApi.get(companyId))
  const base = `/companies/${companyId}`
  const data = home.data
  const manager = data?.view === 'manager'

  return (
    <>
      <PageHeader
        title="ホーム"
        description={
          manager && data
            ? `${data.departments.map((d) => d.name).join('・')}の部署の管理役として開いています。所属する人の「対応が必要なこと」だけを出しています。`
            : undefined
        }
      />
      {home.loading ? (
        <OverviewSkeleton bare />
      ) : home.error && !data ? (
        <ErrorState error={home.error} onRetry={home.reload} />
      ) : data ? (
        <div className="space-y-8">
          {data.setup && <SetupCard setup={data.setup} base={base} />}
          <Attention
            attention={data.attention}
            membersHref={`${base}/members`}
            permissionsHref={`${base}/folders`}
            rejectionsHref={`${base}/advanced/info/rules`}
            extra={<ExtraAttention attention={data.attention} base={base} />}
            extraCount={(data.attention.meetingDuplicates > 0 ? 1 : 0) + data.attention.stoppedPlugins.length}
          />
          {!isAdmin && canViewAgentEvents && (
            // The log is inside 「詳しい設定」 (owners and admins); a manager the setting lets read it opens it from here.
            <FooterLink href={`${base}/advanced/ai-safety/events`}>AI の操作の記録</FooterLink>
          )}
          {!manager && (
            <div className="grid gap-3 sm:grid-cols-2">
              <StatCard icon={Users} label="メンバー" value={`${data.counts.members}人`} href={`${base}/members`} />
              <StatCard icon={TreeStructure} label="部署" value={`${data.counts.departments}`} href={`${base}/departments`} />
            </div>
          )}
        </div>
      ) : null}
    </>
  )
}

function SetupCard({ setup, base }: { setup: NonNullable<AdminHome['setup']>; base: string }) {
  if (setup.done >= setup.total) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-success">
        <CheckCircle size={16} weight="fill" />
        最初にやることは全部終わりました
      </p>
    )
  }
  const next = setup.steps.find((s) => !s.done)
  return (
    <Card className="gap-0 py-0">
      <section aria-labelledby="setup-heading" className="px-5 py-4">
        <div className="flex items-center gap-2">
          <h2 id="setup-heading" className="text-sm font-semibold">最初にやること</h2>
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {setup.done} / {setup.total}
          </span>
        </div>
        <div className="mt-2 mb-3 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <div className="h-full bg-success" style={{ width: `${(setup.done / setup.total) * 100}%` }} />
        </div>
        <ol aria-label="最初にやること" className="space-y-1">
          {setup.steps.map((step, i) => {
            const words = STEPS[step.id]
            const isNext = step === next
            const href = `${base}/${words.path}`
            return (
              <li key={step.id} className={cn('flex items-start gap-2.5 rounded-lg px-2 py-2', isNext && 'bg-brand/5')}>
                {step.done ? (
                  <CheckCircle size={18} weight="fill" className="mt-px shrink-0 text-success" aria-label="終わった" />
                ) : (
                  <Circle size={18} className="mt-px shrink-0 text-muted-foreground/50" aria-label="まだ" />
                )}
                <div className="min-w-0 flex-1">
                  <div className={cn('flex flex-wrap items-center gap-2 text-sm', step.done ? 'text-muted-foreground line-through' : 'font-medium')}>
                    {i + 1} {words.title}
                    {step.byOperator && !step.done && (
                      <Badge variant="brand">
                        <HandWaving size={11} />
                        運用担当者に頼む
                      </Badge>
                    )}
                  </div>
                  {isNext && <p className="mt-0.5 text-xs text-muted-foreground">{words.hint}</p>}
                </div>
                {!step.done && (
                  <Button asChild size="sm" variant={isNext ? 'default' : 'ghost'} className="shrink-0">
                    <Link href={href}>{isNext && !step.byOperator ? '始める' : '開く'}</Link>
                  </Button>
                )}
              </li>
            )
          })}
        </ol>
      </section>
    </Card>
  )
}

/** What the home gathers besides the overview's lists (管理画面の見直し 2-3). */
function ExtraAttention({ attention, base }: { attention: AdminHome['attention']; base: string }) {
  return (
    <>
      {attention.meetingDuplicates > 0 && (
        <AttentionCard
          icon={Copy}
          tone="warning"
          title="同じ会議から重複して作られた記録"
          description="議事録の読み込みが同じものを2回作った分です。1つを残して、ほかを使わないものにできます（消しません）。"
          footer={<FooterLink href={`${base}/duplicates`}>まとめる</FooterLink>}
        >
          <li className="px-5 py-2.5 text-sm">{attention.meetingDuplicates}組</li>
        </AttentionCard>
      )}
      {attention.stoppedPlugins.length > 0 && (
        <AttentionCard
          icon={PlugsConnected}
          tone="destructive"
          title="動いていない業務・つなぎ先"
          description="オンになっているのに、いまは動いていません。つなぎ先の画面に理由が出ています。"
          footer={<FooterLink href={`${base}/integrations`}>つなぎ先の画面で見る</FooterLink>}
        >
          {attention.stoppedPlugins.map((p) => (
            <li key={p.id} className="px-5 py-2.5 text-sm">
              {p.label}
            </li>
          ))}
        </AttentionCard>
      )}
    </>
  )
}

function Attention({
  attention,
  membersHref,
  permissionsHref,
  rejectionsHref,
  extra,
  extraCount = 0,
}: {
  attention: Overview['attention']
  membersHref: string
  permissionsHref: string
  rejectionsHref: string
  extra?: ReactNode
  extraCount?: number
}) {
  const { recentRejections, outdatedClients, unknownClients, notSyncedRecently } = attention
  const orphanedScopes = attention.orphanedScopes ?? []
  const total =
    recentRejections.length + orphanedScopes.length + outdatedClients.length + unknownClients.length + notSyncedRecently.length + extraCount

  if (total === 0) {
    return (
      <EmptyState
        icon={CheckCircle}
        title="対応が必要なことはありません"
        description="全員のアプリが最新で、最近の同期も問題なく行われています。"
      />
    )
  }

  return (
    <section aria-labelledby="attention-heading" className="space-y-3">
      <h2 id="attention-heading" className="text-sm font-semibold">
        対応が必要なこと <span className="ml-1 font-normal text-muted-foreground">{total}件</span>
      </h2>

      {extra}

      {recentRejections.length > 0 && (
        <AttentionCard
          icon={ProhibitInset}
          tone="destructive"
          title="同期がブロックされました"
          description="共有できないファイルが含まれていたため、サーバーが同期を止めました。本人のPCにファイルは残っています。"
          footer={<FooterLink href={rejectionsHref}>止められた同期の記録を見る</FooterLink>}
        >
          {recentRejections.map((r) => (
            <RejectionRow key={r.id} rejection={r} />
          ))}
        </AttentionCard>
      )}

      {orphanedScopes.length > 0 && (
        <AttentionCard
          icon={FolderSimpleDashed}
          tone="warning"
          title={ORPHANED_TITLE}
          description={ORPHANED_DESCRIPTION}
          footer={<FooterLink href={permissionsHref}>フォルダの画面で対応する</FooterLink>}
        >
          {orphanedScopes.map((o) => (
            <li key={o.scopeId} className="flex items-center gap-3 px-5 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-sm">{o.path}</div>
                <div className="truncate text-xs text-muted-foreground">ルール：{SUMMARY_LABELS[o.summary]}</div>
              </div>
              <time className="shrink-0 text-xs text-muted-foreground" dateTime={o.since} title={formatDateTime(o.since)}>
                {formatRelative(o.since)}から
              </time>
            </li>
          ))}
        </AttentionCard>
      )}

      {outdatedClients.length > 0 && (
        <AttentionCard
          icon={DownloadSimple}
          tone="warning"
          title="アプリの更新が必要です"
          description="古いバージョンのデスクトップアプリを使っています。最新版への更新を案内してください。"
          footer={<FooterLink href={membersHref}>メンバー一覧で確認</FooterLink>}
        >
          {outdatedClients.map((m) => (
            <MemberRow key={m.userId} member={m} detail={formatBuild(parseBuild(m.clientVersion), m.clientVersion)} sub={`最終接続 ${formatRelative(m.lastSeenAt)}`} />
          ))}
        </AttentionCard>
      )}

      {unknownClients.length > 0 && (
        <AttentionCard
          icon={Question}
          tone="muted"
          title="アプリのバージョンがわかりません"
          description="まだ一度もアプリから接続していないか、バージョンを送らない古いアプリを使っています。"
        >
          {unknownClients.map((m) => (
            <MemberRow
              key={m.userId}
              member={m}
              detail={m.lastSeenAt ? `最終接続 ${formatRelative(m.lastSeenAt)}` : '未接続'}
            />
          ))}
        </AttentionCard>
      )}

      {notSyncedRecently.length > 0 && (
        <AttentionCard
          icon={ClockCounterClockwise}
          tone="muted"
          title="しばらく同期していません"
          description="変更がチームに共有されていない可能性があります。同期ボタンを押すよう声をかけてください。"
        >
          {notSyncedRecently.map((m) => {
            const lastSync = latest(m.lastFetchAt, m.lastPushAt)
            return (
              <MemberRow
                key={m.userId}
                member={m}
                detail={lastSync ? `最終同期 ${formatRelative(lastSync)}` : '同期の記録なし'}
              />
            )
          })}
        </AttentionCard>
      )}
    </section>
  )
}

const TONES = {
  destructive: 'bg-destructive/10 text-destructive',
  warning: 'bg-warning/15 text-warning',
  muted: 'bg-muted text-muted-foreground',
} as const

function AttentionCard({
  icon: IconComponent,
  tone,
  title,
  description,
  footer,
  children,
}: {
  icon: Icon
  tone: keyof typeof TONES
  title: string
  description: string
  footer?: ReactNode
  children: ReactNode
}) {
  const count = Array.isArray(children) ? children.length : 1
  return (
    <Card className="overflow-hidden">
      <div className="flex gap-3 px-5 pt-4 pb-3">
        <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg ${TONES[tone]}`}>
          <IconComponent size={17} weight="bold" />
        </span>
        <div className="min-w-0 space-y-0.5">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            {title}
            <Badge variant="secondary">{count}</Badge>
          </h3>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <ul className="divide-y border-t">{children}</ul>
      {footer && <div className="border-t px-5 py-2.5">{footer}</div>}
    </Card>
  )
}

function FooterLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 rounded text-sm font-medium text-brand underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      {children}
      <ArrowRight size={14} />
    </Link>
  )
}

function MemberRow({ member, detail, sub }: { member: OverviewMember; detail: string; sub?: string }) {
  const name = member.name || member.email || '名前未設定'
  return (
    <li className="flex items-center gap-3 px-5 py-2.5">
      <Avatar name={name} seed={member.userId} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {member.email} · {roleLabel(member.role)}
        </div>
      </div>
      <div className="text-right">
        <div className="text-sm tabular-nums">{detail}</div>
        {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
      </div>
    </li>
  )
}

function RejectionRow({ rejection }: { rejection: PushRejection }) {
  const explanation = explainRejection(rejection.marker)
  const name = rejection.name || '不明なメンバー'
  const shown = rejection.paths.slice(0, 3)
  const rest = rejection.paths.length - shown.length
  return (
    <li className="flex gap-3 px-5 py-3">
      <Avatar name={name} seed={rejection.userId} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="text-sm font-medium">{name}</span>
          <time className="text-xs text-muted-foreground" dateTime={rejection.createdAt} title={formatDateTime(rejection.createdAt)}>
            {formatRelative(rejection.createdAt)}
          </time>
        </div>
        <p className="text-sm">
          {explanation ? explanation.title : <span className="font-mono text-xs">{rejection.marker}</span>}
        </p>
        {explanation && <p className="text-xs text-muted-foreground">{explanation.advice}</p>}
        {shown.length > 0 && (
          <ul className="flex flex-wrap gap-1.5 pt-0.5">
            {shown.map((p) => (
              <li key={p} className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                {p}
              </li>
            ))}
            {rest > 0 && <li className="px-1 py-0.5 text-xs text-muted-foreground">ほか{rest}件</li>}
          </ul>
        )}
      </div>
    </li>
  )
}

function StatCard({ icon: IconComponent, label, value, href }: { icon: Icon; label: string; value: string; href: string }) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-4 rounded-xl border bg-card px-5 py-4 shadow-xs transition-colors outline-none hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <IconComponent size={18} />
      </span>
      <div className="flex-1">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold tabular-nums">{value}</div>
      </div>
      <ArrowRight size={16} className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </Link>
  )
}

/** Members, and managers who are members, see their own place in the company. */
function MemberOverview() {
  const { companyId, role, managedDepartmentIds, company, canViewAgentEvents } = useCompany()
  const departments = useQuery(`departments:${companyId}`, () => departmentsApi.list(companyId))
  const members = useQuery(`members:${companyId}`, () => companiesApi.getMembers(companyId))
  const base = `/companies/${companyId}`
  const managed = (departments.data ?? []).filter((d) => managedDepartmentIds.includes(d.id))

  return (
    <>
      <PageHeader title="ホーム" description={`${company.data?.name ?? ''} でのあなたの役割と担当です。`} />
      <div className="space-y-8">
        <div className="grid gap-3 sm:grid-cols-2">
          {members.data ? (
            <StatCard icon={Users} label="メンバー" value={`${members.data.length}人`} href={`${base}/members`} />
          ) : (
            <Skeleton className="h-[74px] rounded-xl" />
          )}
          {departments.data ? (
            <StatCard icon={TreeStructure} label="部署" value={`${departments.data.length}`} href={`${base}/departments`} />
          ) : (
            <Skeleton className="h-[74px] rounded-xl" />
          )}
        </div>

        <Card>
          <CardHeader className="pb-5">
            <CardTitle>あなたの役割: {role ? roleLabel(role) : ''}</CardTitle>
            <CardDescription>
              メンバーや部署の変更はオーナー・管理者が行います。変更が必要なときは管理者に依頼してください。
            </CardDescription>
          </CardHeader>
          {managed.length > 0 && (
            <div className="border-t px-5 py-4">
              <div className="mb-2 text-xs font-medium text-muted-foreground">管理役を務めている部署</div>
              <ul className="flex flex-wrap gap-2">
                {managed.map((d) => (
                  <li key={d.id} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm">
                    <DepartmentIcon icon={d.icon} color={d.color} size="sm" />
                    {d.name}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        {canViewAgentEvents && (
          // The log is inside 「詳しい設定」 (owners and admins); a manager the setting lets read it opens it from here.
          <FooterLink href={`${base}/advanced/ai-safety/events`}>AI の操作の記録</FooterLink>
        )}

        {!!departments.error && !departments.data && <ErrorState error={departments.error} onRetry={departments.reload} />}
      </div>
    </>
  )
}

function OverviewSkeleton({ bare = false }: { bare?: boolean }) {
  return (
    <div aria-busy="true" aria-label="読み込み中">
      {!bare && (
        <div className="space-y-2 pb-6">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-4 w-64" />
        </div>
      )}
      <div className="space-y-8">
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-[74px] rounded-xl" />
          <Skeleton className="h-[74px] rounded-xl" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      </div>
    </div>
  )
}
