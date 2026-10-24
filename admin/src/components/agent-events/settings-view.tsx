'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle, ClockCounterClockwise, Eye, Timer } from '@phosphor-icons/react'

import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { ErrorState, ListSkeleton } from '@/components/app/states'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  agentEventsApi,
  type AgentEventRetentionPreview,
  type AgentEventSettings,
  type AgentEventSettingsUpdate,
  type AgentEventSettingsValues,
  type AgentEventViewerMode,
} from '@/lib/api'
import { RETENTION_PRESETS, VIEWER_MODE_LABELS, retentionLabel } from '@/lib/agent-events'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { formatDate, formatDateTime, roleLabel } from '@/lib/format'
import { useQuery } from '@/lib/use-query'
import { cn } from '@/lib/utils'

const MIN_DAYS = 7
const MAX_DAYS = 3650
const MODES: AgentEventViewerMode[] = ['admins', 'admins-and-managers']

type RetentionChoice = (typeof RETENTION_PRESETS)[number] | 'custom'

interface Draft {
  choice: RetentionChoice
  customDays: string
  viewers: AgentEventViewerMode
}

function draftOf(s: AgentEventSettingsValues): Draft {
  const preset = (RETENTION_PRESETS as readonly number[]).includes(s.retentionDays)
  return {
    choice: preset ? (s.retentionDays as RetentionChoice) : 'custom',
    customDays: String(s.retentionDays),
    viewers: s.viewers,
  }
}

/** The days a draft asks for, or null when the custom number is not valid. */
export function draftDays(d: Draft): number | null {
  if (d.choice !== 'custom') return d.choice
  if (!/^\d+$/.test(d.customDays.trim())) return null
  const n = Number(d.customDays.trim())
  return n >= MIN_DAYS && n <= MAX_DAYS ? n : null
}

/** 「保存期間 180日 → 90日」 lines for what changes. */
export function changeLines(before: AgentEventSettingsValues, after: AgentEventSettingsValues): string[] {
  const lines: string[] = []
  if (before.retentionDays !== after.retentionDays) {
    lines.push(`保存期間: ${retentionLabel(before.retentionDays)} → ${retentionLabel(after.retentionDays)}`)
  }
  if (before.viewers !== after.viewers) {
    lines.push(`記録を見られる人: ${VIEWER_MODE_LABELS[before.viewers]} → ${VIEWER_MODE_LABELS[after.viewers]}`)
  }
  return lines
}

export function SettingsView() {
  const { companyId } = useCompany()
  const settings = useQuery(`agent-events-settings:${companyId}`, () => agentEventsApi.settings(companyId))

  if (settings.loading) return <ListSkeleton rows={3} />
  if (settings.error && !settings.data) return <ErrorState error={settings.error} onRetry={settings.reload} />
  if (!settings.data) return null
  return (
    <SettingsForm
      // A fresh draft whenever the saved values change (after a save, or a reload).
      key={`${settings.data.retentionDays}:${settings.data.viewers}`}
      saved={settings.data}
      onSaved={(next) => settings.setData(() => next)}
    />
  )
}

function SettingsForm({ saved, onSaved }: { saved: AgentEventSettings; onSaved: (next: AgentEventSettings) => void }) {
  const { companyId, refresh } = useCompany()
  const [draft, setDraft] = useState<Draft>(() => draftOf(saved))
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<AgentEventRetentionPreview | null>(null)

  const days = draftDays(draft)
  const after: AgentEventSettingsValues = { retentionDays: days ?? saved.retentionDays, viewers: draft.viewers }
  const lines = days === null ? [] : changeLines(saved, after)
  const dirty = lines.length > 0

  const put = async () => {
    const update: AgentEventSettingsUpdate = {}
    if (after.retentionDays !== saved.retentionDays) update.retentionDays = after.retentionDays
    if (after.viewers !== saved.viewers) update.viewers = after.viewers
    try {
      const next = await agentEventsApi.updateSettings(companyId, update)
      toast.success('設定を保存しました')
      onSaved(next)
      // The viewer setting decides whether managers see the page in the menu.
      refresh()
    } catch (err) {
      toast.error('設定を保存できませんでした', { description: describeError(err) })
      throw err
    }
  }

  const save = async () => {
    if (!dirty || days === null) return
    setBusy(true)
    try {
      if (after.retentionDays < saved.retentionDays) {
        // Shortening deletes older events: say how many first.
        try {
          setConfirm(await agentEventsApi.retentionPreview(companyId, after.retentionDays))
        } catch (err) {
          toast.error('消える記録の数を確かめられませんでした', { description: describeError(err) })
        }
        return
      }
      await put()
    } catch {
      // put() has shown the toast; the draft stays for another try.
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6 pb-4">
      <RetentionCard draft={draft} setDraft={setDraft} invalid={days === null} />
      <ViewersCard value={draft.viewers} onChange={(viewers) => setDraft((d) => ({ ...d, viewers }))} />

      <div
        className={cn(
          'sticky bottom-4 z-10 flex flex-col gap-3 rounded-xl border bg-card px-4 py-3 shadow-md sm:flex-row sm:items-center sm:justify-between',
          !dirty && 'hidden'
        )}
        aria-live="polite"
      >
        <div className="text-sm">
          <p className="font-medium">保存していない変更があります</p>
          <ul className="text-muted-foreground">
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" onClick={() => setDraft(draftOf(saved))} disabled={busy}>
            取り消す
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? '確認しています…' : '保存'}
          </Button>
        </div>
      </div>

      <HistoryCard history={saved.history} />

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="保存期間を短くします"
        description={
          confirm && (
            <>
              <p>
                {confirm.wouldDelete > 0
                  ? `${retentionLabel(confirm.days)}より前（${formatDate(confirm.olderThan)}より前）の記録 ${confirm.wouldDelete.toLocaleString('ja-JP')} 件が消えます。よろしいですか？`
                  : `${retentionLabel(confirm.days)}より前（${formatDate(confirm.olderThan)}より前）の記録はいまはありません。これから先は${retentionLabel(confirm.days)}を過ぎた記録が消えます。よろしいですか？`}
              </p>
              <p>消えた記録は元に戻せません。削除は1日1回、自動で行われます。</p>
            </>
          )
        }
        confirmLabel="短くして保存"
        onConfirm={put}
      />
    </div>
  )
}

function RetentionCard({ draft, setDraft, invalid }: { draft: Draft; setDraft: (f: (d: Draft) => Draft) => void; invalid: boolean }) {
  const choices: RetentionChoice[] = [...RETENTION_PRESETS, 'custom']
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <Timer size={16} />
          保存期間
        </CardTitle>
        <CardDescription>この期間を過ぎた記録は、1日1回自動で消えます。初期値は180日です。</CardDescription>
      </CardHeader>
      <div className="space-y-3 border-t px-5 py-4">
        <div role="radiogroup" aria-label="保存期間" className="flex flex-wrap gap-2">
          {choices.map((c) => {
            const checked = draft.choice === c
            return (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => setDraft((d) => ({ ...d, choice: c }))}
                className={cn(
                  'rounded-lg border px-3.5 py-1.5 text-sm transition-colors outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  checked && 'border-brand bg-brand/10 font-medium text-foreground hover:bg-brand/10'
                )}
              >
                {c === 'custom' ? 'カスタム' : retentionLabel(c)}
                {c === 180 && <span className="ml-1 text-xs text-muted-foreground">（初期値）</span>}
              </button>
            )
          })}
        </div>
        {draft.choice === 'custom' && (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="number"
              inputMode="numeric"
              min={MIN_DAYS}
              max={MAX_DAYS}
              aria-label="保存する日数"
              aria-invalid={invalid || undefined}
              aria-describedby="retention-hint"
              className="w-28"
              value={draft.customDays}
              onChange={(e) => {
                const customDays = e.target.value
                setDraft((d) => ({ ...d, customDays }))
              }}
            />
            <span className="text-sm">日</span>
            <span id="retention-hint" className={cn('text-xs', invalid ? 'text-destructive' : 'text-muted-foreground')}>
              {MIN_DAYS}〜{MAX_DAYS}日の間で指定してください。
            </span>
          </div>
        )}
      </div>
    </Card>
  )
}

function ViewersCard({ value, onChange }: { value: AgentEventViewerMode; onChange: (m: AgentEventViewerMode) => void }) {
  const [peek, setPeek] = useState<AgentEventViewerMode | null>(null)
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <Eye size={16} />
          記録を見られる人
        </CardTitle>
        <CardDescription>
          選んだ方の下に、実際に見られる人と、その人が見られる範囲を表示しています。部署の責任者は、自分の部署で行われた操作だけを見られ、自分が読めないフォルダの名前は「非公開（表示できません）」になります。
        </CardDescription>
      </CardHeader>
      <div role="radiogroup" aria-label="記録を見られる人" className="grid gap-3 border-t px-5 py-4 md:grid-cols-2">
        {MODES.map((mode) => {
          const checked = value === mode
          return (
            <div
              key={mode}
              className={cn(
                'flex flex-col rounded-xl border transition-colors',
                checked ? 'border-brand ring-1 ring-brand/40' : 'hover:border-foreground/20'
              )}
              onMouseEnter={() => setPeek(mode)}
              onMouseLeave={() => setPeek((p) => (p === mode ? null : p))}
            >
              <button
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => onChange(mode)}
                onFocus={() => setPeek(mode)}
                onBlur={() => setPeek((p) => (p === mode ? null : p))}
                className="flex items-start gap-2.5 rounded-t-xl px-4 py-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                    checked ? 'border-brand' : 'border-input'
                  )}
                >
                  {checked && <span className="size-2 rounded-full bg-brand" />}
                </span>
                <span className="text-sm font-medium">
                  {VIEWER_MODE_LABELS[mode]}
                  {mode === 'admins' && <span className="ml-1 text-xs font-normal text-muted-foreground">（初期値）</span>}
                </span>
              </button>
              {(checked || peek === mode) && <ViewerList mode={mode} />}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function ViewerList({ mode }: { mode: AgentEventViewerMode }) {
  const { companyId } = useCompany()
  const viewers = useQuery(`agent-events-viewers:${companyId}:${mode}`, () => agentEventsApi.viewers(companyId, mode))
  return (
    <div className="border-t px-4 py-2.5" aria-label={`${VIEWER_MODE_LABELS[mode]}のときに見られる人`} role="region">
      {viewers.loading ? (
        <div className="space-y-2 py-1" aria-busy="true">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-32" />
        </div>
      ) : viewers.error && !viewers.data ? (
        <p className="text-sm text-destructive">{describeError(viewers.error)}</p>
      ) : (
        <ul className="divide-y text-sm">
          {(viewers.data?.viewers ?? []).map((v) => {
            const name = v.name || v.email || '名前未設定'
            return (
              <li key={v.userId} className="flex items-center gap-2 py-1.5">
                <Avatar name={name} seed={v.userId} className="size-6" />
                <span className="min-w-0 flex-1 truncate">
                  {name}
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {v.scope === 'all' ? roleLabel(v.role) : '部署の責任者'}
                  </span>
                </span>
                {v.scope === 'all' ? (
                  <Badge variant="secondary">全部</Badge>
                ) : (
                  <Badge variant="outline" className="max-w-[12rem] truncate" title={v.departments.map((d) => d.name).join('・')}>
                    {v.departments.map((d) => d.name).join('・')}の分
                  </Badge>
                )}
              </li>
            )
          })}
          {mode === 'admins-and-managers' && (viewers.data?.viewers ?? []).every((v) => v.scope === 'all') && (
            <li className="py-1.5 text-xs text-muted-foreground">部署の責任者はまだいません（「部署」の画面で設定できます）。</li>
          )}
        </ul>
      )}
    </div>
  )
}

function HistoryCard({ history }: { history: AgentEventSettings['history'] }) {
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <ClockCounterClockwise size={16} />
          変更の履歴
        </CardTitle>
        <CardDescription>この設定を、誰が・いつ・どう変えたか（新しい順、最新20件）。</CardDescription>
      </CardHeader>
      {history.length === 0 ? (
        <div className="flex items-center gap-2 border-t px-5 py-4 text-sm text-muted-foreground">
          <CheckCircle size={16} />
          まだ変更されていません（保存期間 180日・オーナーと管理者だけ、のまま）。
        </div>
      ) : (
        <ul className="divide-y border-t text-sm">
          {history.map((h) => {
            const name = h.name || h.email || '不明なメンバー'
            return (
              <li key={h.id} className="grid gap-1 px-5 py-3 sm:grid-cols-[11rem_10rem_1fr] sm:gap-4">
                <span className="text-muted-foreground tabular-nums">{formatDateTime(h.changedAt)}</span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <Avatar name={name} seed={h.changedBy} className="size-5 text-[10px]" />
                  <span className="truncate">{name}</span>
                </span>
                <ul>
                  {changeLines(h.before, h.after).map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
