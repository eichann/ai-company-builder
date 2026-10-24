'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  ArrowLeft,
  ChatsCircle,
  CheckCircle,
  FileArrowDown,
  LockSimple,
  MagnifyingGlass,
  Warning,
} from '@phosphor-icons/react'

import { EmptyState, ErrorState, ListSkeleton } from '@/components/app/states'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  agentEventsApi,
  clientActivityApi,
  companiesApi,
  type AgentEventQuery,
  type AgentEventRecord,
} from '@/lib/api'
import {
  CATEGORY_LABELS,
  DECISION_LABELS,
  GUARD_REASON_LABELS,
  OUTCOME_LABELS,
  PERIOD_LABELS,
  PERIODS,
  TOOL_CATEGORIES,
  TOOL_DECISIONS,
  agentLabel,
  describeTarget,
  formatDuration,
  formatEventTime,
  hasNarrowingFilters,
  localTzOffsetMinutes,
  periodDays,
  periodRange,
  summaryRows,
  type LogFilters,
  type Period,
  type TargetItem,
} from '@/lib/agent-events'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { formatBuild, formatDateTime } from '@/lib/format'
import { useQuery } from '@/lib/use-query'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 50
const CONVERSATION_PAGE_SIZE = 200
const ALL = '__all__'

export function LogView({ filters, onChange }: { filters: LogFilters; onChange: (next: LogFilters) => void }) {
  const { isAdmin } = useCompany()
  const conversation = filters.conversationId

  return (
    <div className="space-y-6">
      {isAdmin && !conversation && <NotSendingNotice />}
      {conversation ? (
        <ConversationHeader onBack={() => onChange({ ...filters, conversationId: undefined })} />
      ) : (
        <Filters filters={filters} onChange={onChange} />
      )}
      {!conversation && <SummaryStrip filters={filters} onPickMember={(userId) => onChange({ ...filters, userId })} />}
      <EventList filters={filters} onChange={onChange} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function Filters({ filters, onChange }: { filters: LogFilters; onChange: (next: LogFilters) => void }) {
  const { companyId } = useCompany()
  const members = useQuery(`members:${companyId}`, () => companiesApi.getMembers(companyId))
  const [q, setQ] = useState(filters.q ?? '')
  const [syncedQ, setSyncedQ] = useState(filters.q ?? '')
  // Follow the URL when it changes from outside (back button, a shared link).
  if ((filters.q ?? '') !== syncedQ) {
    setSyncedQ(filters.q ?? '')
    setQ(filters.q ?? '')
  }

  // The search applies by itself shortly after typing stops.
  useEffect(() => {
    const value = q.trim()
    if (value === (filters.q ?? '')) return
    const t = setTimeout(() => onChange({ ...filters, q: value || undefined }), 400)
    return () => clearTimeout(t)
  }, [q, filters, onChange])

  const setPeriod = (period: Period) => onChange({ ...filters, period, ...(period === 'custom' ? {} : { fromDay: undefined, toDay: undefined }) })

  return (
    <section aria-label="絞り込み" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="期間" className="inline-flex rounded-lg border bg-card p-0.5 shadow-xs">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={filters.period === p}
              onClick={() => setPeriod(p)}
              className={cn(
                'rounded-md px-3 py-1 text-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
                filters.period === p && 'bg-accent font-medium text-foreground'
              )}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
        {filters.period === 'custom' && (
          <div className="flex items-center gap-1.5 text-sm">
            <Input
              type="date"
              aria-label="開始日"
              className="w-40"
              value={filters.fromDay ?? ''}
              onChange={(e) => onChange({ ...filters, fromDay: e.target.value || undefined })}
            />
            <span className="text-muted-foreground">〜</span>
            <Input
              type="date"
              aria-label="終了日"
              className="w-40"
              value={filters.toDay ?? ''}
              onChange={(e) => onChange({ ...filters, toDay: e.target.value || undefined })}
            />
          </div>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Select value={filters.userId ?? ALL} onValueChange={(v) => onChange({ ...filters, userId: v === ALL ? undefined : v })}>
          <SelectTrigger aria-label="メンバーで絞り込む">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>すべてのメンバー</SelectItem>
            {(members.data ?? []).map((m) => (
              <SelectItem key={m.userId} value={m.userId}>
                {m.name || m.email || '名前未設定'}
              </SelectItem>
            ))}
            {filters.userId && members.data && !members.data.some((m) => m.userId === filters.userId) && (
              <SelectItem value={filters.userId}>（いまはメンバーでない人）</SelectItem>
            )}
          </SelectContent>
        </Select>
        <Select
          value={filters.category ?? ALL}
          onValueChange={(v) => onChange({ ...filters, category: v === ALL ? undefined : (v as LogFilters['category']) })}
        >
          <SelectTrigger aria-label="種類で絞り込む">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>すべての種類</SelectItem>
            {TOOL_CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.decision ?? ALL}
          onValueChange={(v) => onChange({ ...filters, decision: v === ALL ? undefined : (v as LogFilters['decision']) })}
        >
          <SelectTrigger aria-label="判断で絞り込む">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>すべての判断</SelectItem>
            {TOOL_DECISIONS.map((d) => (
              <SelectItem key={d} value={d}>
                {DECISION_LABELS[d].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative">
          <MagnifyingGlass size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label="対象で検索"
            placeholder="対象で検索（フォルダ名・コマンド・宛先）"
            className="pl-8"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onChange({ ...filters, q: q.trim() || undefined })
            }}
          />
        </div>
      </div>
    </section>
  )
}

function ConversationHeader({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card px-4 py-3 shadow-xs sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2.5">
        <ChatsCircle size={20} className="mt-0.5 shrink-0 text-brand" />
        <div>
          <p className="text-sm font-medium">この会話の流れ</p>
          <p className="text-sm text-muted-foreground">1つの会話で AI が行った操作を、古い順に並べています（期間などの絞り込みは使いません）。</p>
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={onBack}>
        <ArrowLeft />
        一覧に戻る
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Apps that do not send the log (owner/admin)
// ---------------------------------------------------------------------------

function NotSendingNotice() {
  const { companyId } = useCompany()
  const activity = useQuery(`client-activity:${companyId}`, () => clientActivityApi.list(companyId))
  const behind = (activity.data ?? []).filter((m) => !m.supportsAgentEvents)
  if (behind.length === 0) return null

  return (
    <section
      aria-labelledby="not-sending-heading"
      className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3"
    >
      <div className="flex items-start gap-2.5">
        <Warning size={18} className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <h2 id="not-sending-heading" className="text-sm font-medium">
              記録を送っていないアプリ（{behind.length}人）
            </h2>
            <p className="text-sm text-muted-foreground">
              次のメンバーのアプリは古いか、版がわからないため、AI の操作が記録されていません。アプリを最新にしてもらうと、記録が届くようになります。
            </p>
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
            {behind.map((m) => {
              const name = m.name || m.email || '名前未設定'
              return (
                <li key={m.userId} className="flex items-center gap-1.5">
                  <Avatar name={name} seed={m.userId} className="size-5 text-[10px]" />
                  <span>{name}</span>
                  <span className="text-xs text-muted-foreground">
                    {m.clientVersion ? formatBuild(m.build, m.clientVersion) : 'アプリの版がわかりません'}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Counts per member and day
// ---------------------------------------------------------------------------

function SummaryStrip({ filters, onPickMember }: { filters: LogFilters; onPickMember: (userId: string) => void }) {
  const { companyId } = useCompany()
  const range = periodRange(filters)
  const tz = localTzOffsetMinutes()
  const key = `agent-events-summary:${companyId}:${range.from ?? ''}:${range.to ?? ''}:${tz}`
  const summary = useQuery(key, () => agentEventsApi.summary(companyId, { ...range, tzOffsetMinutes: tz }))
  const days = useMemo(() => periodDays(filters), [filters])
  const rows = useMemo(() => (summary.data ? summaryRows(summary.data, days) : []), [summary.data, days])
  const max = Math.max(1, ...rows.flatMap((r) => r.perDay))

  if (summary.error && !summary.data) return null // the list below explains the failure
  if (summary.loading) return <ListSkeleton rows={2} />
  if (rows.length === 0) return null

  return (
    <section aria-labelledby="summary-heading" className="space-y-2">
      <h2 id="summary-heading" className="text-sm font-semibold">
        メンバーごとの件数
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          {filters.period === 'today' ? '今日' : `${days[0]?.replaceAll('-', '/')} 〜 ${days.at(-1)?.replaceAll('-', '/')}`}
        </span>
      </h2>
      <Card className="divide-y py-0">
        {rows.map((r) => (
          <div key={r.userId} className="grid items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:grid-cols-[12rem_7rem_1fr]">
            <button
              type="button"
              onClick={() => onPickMember(r.userId)}
              className="flex min-w-0 items-center gap-2 rounded-md text-left text-sm outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
              title="このメンバーで絞り込む"
            >
              <Avatar name={r.name} seed={r.userId} />
              <span className="truncate font-medium">{r.name}</span>
            </button>
            <div className="text-sm tabular-nums">
              <span className="font-medium">{r.total.toLocaleString('ja-JP')}件</span>
              {r.denied > 0 && <span className="ml-1.5 text-xs text-destructive">拒否 {r.denied.toLocaleString('ja-JP')}</span>}
              <p className="text-xs text-muted-foreground">
                {r.topCategories.map((c) => `${CATEGORY_LABELS[c.category]} ${c.count}`).join('・')}
              </p>
            </div>
            <div className="flex h-8 items-end gap-px" role="img" aria-label={`${r.name}の日ごとの件数`}>
              {r.perDay.map((n, i) => (
                <div
                  key={days[i]}
                  title={`${days[i].replaceAll('-', '/')}: ${n}件`}
                  className={cn('min-w-0.5 max-w-4 flex-1 rounded-t-sm', n > 0 ? 'bg-brand/70' : 'bg-muted')}
                  style={{ height: n > 0 ? `${Math.max(12, (n / max) * 100)}%` : '2px' }}
                />
              ))}
            </div>
          </div>
        ))}
      </Card>
    </section>
  )
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

function EventList({ filters, onChange }: { filters: LogFilters; onChange: (next: LogFilters) => void }) {
  const { companyId } = useCompany()
  const conversation = filters.conversationId
  const query: AgentEventQuery = conversation
    ? { conversationId: conversation, limit: CONVERSATION_PAGE_SIZE }
    : {
        ...periodRange(filters),
        userId: filters.userId,
        category: filters.category,
        decision: filters.decision,
        q: filters.q,
        limit: PAGE_SIZE,
      }
  const key = `agent-events:${companyId}:${JSON.stringify(query)}`
  const first = useQuery(key, () => agentEventsApi.list(companyId, query))
  // Older pages, appended by 「もっと見る」; tied to the query they were loaded for.
  const [more, setMore] = useState<{ key: string; events: AgentEventRecord[]; cursor: string | null }>({ key: '', events: [], cursor: null })
  const [loadingMore, setLoadingMore] = useState(false)
  const extra = more.key === key ? more : null
  const loaded = [...(first.data?.events ?? []), ...(extra?.events ?? [])]
  const cursor = extra ? extra.cursor : (first.data?.nextCursor ?? null)
  const events = conversation ? [...loaded].reverse() : loaded

  const loadMore = async () => {
    if (!cursor) return
    setLoadingMore(true)
    try {
      const page = await agentEventsApi.list(companyId, { ...query, cursor })
      setMore({ key, events: [...(extra?.events ?? []), ...page.events], cursor: page.nextCursor })
    } catch (err) {
      toast.error('続きを読み込めませんでした', { description: describeError(err) })
    } finally {
      setLoadingMore(false)
    }
  }

  const filtered = !conversation && hasNarrowingFilters(filters)
  const moreButton = cursor && (
    <div className="flex justify-center">
      <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
        {loadingMore ? '読み込んでいます…' : conversation ? 'さらに前の操作を見る' : 'もっと見る'}
      </Button>
    </div>
  )

  return (
    <section aria-labelledby="events-heading" className="space-y-3">
      <h2 id="events-heading" className="text-sm font-semibold">
        {conversation ? '操作（古い順）' : '操作（新しい順）'}
      </h2>
      {first.loading ? (
        <ListSkeleton rows={5} />
      ) : first.error && !first.data ? (
        <ErrorState error={first.error} onRetry={first.reload} />
      ) : events.length === 0 ? (
        <EmptyState
          icon={filtered ? MagnifyingGlass : CheckCircle}
          title={filtered ? '条件に合う記録はありません' : 'この期間の記録はありません'}
          description={
            filtered
              ? '絞り込みを解除すると、この期間のすべての記録を表示します。'
              : 'メンバーがデスクトップアプリで AI を使うと、ここに記録されます。記録はアプリから1分ほどごとにまとめて届きます。'
          }
          action={
            filtered && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onChange({ period: filters.period, fromDay: filters.fromDay, toDay: filters.toDay })}
              >
                絞り込みを解除
              </Button>
            )
          }
        />
      ) : (
        <>
          {conversation && moreButton}
          <Card className="divide-y py-0">
            {events.map((e) => (
              <EventRow
                key={e.id}
                event={e}
                inConversation={Boolean(conversation)}
                onOpenConversation={(id) => onChange({ ...filters, conversationId: id })}
              />
            ))}
          </Card>
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span className="tabular-nums">{events.length.toLocaleString('ja-JP')}件を表示</span>
            {!conversation && moreButton}
          </div>
        </>
      )}
    </section>
  )
}

const DECISION_BADGE = { neutral: 'secondary', allowed: 'success', denied: 'destructive' } as const

export function EventRow({
  event: e,
  inConversation,
  onOpenConversation,
}: {
  event: AgentEventRecord
  inConversation: boolean
  onOpenConversation: (conversationId: string) => void
}) {
  const decision = DECISION_LABELS[e.decision]
  const denied = decision?.tone === 'denied'
  const name = e.name || e.email || '不明なメンバー'
  const target = describeTarget(e.target)
  const duration = formatDuration(e.durationMs)

  return (
    <div className={cn('grid gap-x-4 gap-y-1.5 px-4 py-3 md:grid-cols-[9rem_1fr_auto]', denied && 'bg-destructive/[0.03]')}>
      <div className="flex items-center gap-2 md:block">
        <time
          dateTime={e.at}
          className="text-sm tabular-nums"
          title={`${formatDateTime(e.at)}${e.atAdjusted ? '（PC の時計がずれていたため、サーバーが受け取った時刻）' : ''}`}
        >
          {formatEventTime(e.at)}
          {e.atAdjusted && <span className="text-muted-foreground">*</span>}
        </time>
        <div className="flex min-w-0 items-center gap-1.5 text-sm md:mt-0.5">
          <Avatar name={name} seed={e.userId} className="size-5 text-[10px]" />
          <span className="truncate">{name}</span>
        </div>
      </div>

      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">{CATEGORY_LABELS[e.category] ?? e.category}</Badge>
          <span className="truncate font-mono text-xs" title={e.tool}>
            {e.tool}
          </span>
        </div>
        <TargetLine items={target.items} more={target.more} redirect={target.redirect} />
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>{agentLabel(e)}</span>
          {e.department && <span>・作業フォルダ {e.department}</span>}
          {!inConversation && e.conversationId && (
            <button
              type="button"
              onClick={() => onOpenConversation(e.conversationId!)}
              className="rounded text-brand underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              この会話の流れ
            </button>
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 md:flex-col md:items-end md:gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant={DECISION_BADGE[decision?.tone ?? 'neutral']} tabIndex={0}>
              {decision?.label ?? e.decision}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>{decision?.description ?? e.decision}</TooltipContent>
        </Tooltip>
        {e.guardReason && (
          <span className={cn('text-xs', denied ? 'text-destructive' : 'text-muted-foreground')}>
            理由: {GUARD_REASON_LABELS[e.guardReason] ?? e.guardReason}
          </span>
        )}
        <span className="text-xs text-muted-foreground tabular-nums">
          {e.outcome ? (
            <span className={cn(e.outcome === 'error' && 'text-destructive')}>{OUTCOME_LABELS[e.outcome] ?? e.outcome}</span>
          ) : denied ? (
            '実行されず'
          ) : (
            ''
          )}
          {duration && `${e.outcome || denied ? '・' : ''}${duration}`}
        </span>
      </div>
    </div>
  )
}

function TargetLine({ items, more, redirect }: { items: TargetItem[]; more: number; redirect: boolean }) {
  if (items.length === 0 && more === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {items.map((it, i) => (
        <TargetPiece key={i} item={it} />
      ))}
      {more > 0 && <span className="text-xs text-muted-foreground">ほか{more.toLocaleString('ja-JP')}件</span>}
      {redirect && (
        <Badge variant="outline" title="コマンドの出力をファイルに書き出しました（>）">
          <FileArrowDown />
          ファイルに出力
        </Badge>
      )}
    </div>
  )
}

function TargetPiece({ item }: { item: TargetItem }) {
  switch (item.kind) {
    case 'path':
      return (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className="font-mono text-xs break-all">{item.text}</span>
          {item.sensitive && <Badge variant="warning">秘密の置き場所: {item.sensitive}</Badge>}
        </span>
      )
    case 'outside':
      return (
        <span className="inline-flex items-center gap-1.5">
          <Badge variant="outline">会社フォルダの外</Badge>
          {item.sensitive && <Badge variant="warning">秘密の置き場所: {item.sensitive}</Badge>}
        </span>
      )
    case 'hidden':
      return (
        <Badge variant="secondary">
          <LockSimple />
          {item.text}
        </Badge>
      )
    case 'code':
      return <span className="font-mono text-xs break-all">{item.text}</span>
    case 'plain':
      return <span className="text-xs text-muted-foreground">{item.text}</span>
  }
}
