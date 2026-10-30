'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { ArrowCounterClockwise, Barricade, ClockCounterClockwise, Globe, FolderLock, LockSimple, UserSwitch } from '@phosphor-icons/react'

import { ImpactCard } from '@/components/agent-sandbox/impact-card'
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  agentSandboxApi,
  companiesApi,
  type AgentSandboxChange,
  type AgentSandboxMode,
  type AgentSandboxUnavailable,
  type AgentSandboxView,
} from '@/lib/api'
import {
  SANDBOX_MODES,
  SANDBOX_MODE_HELP,
  SANDBOX_MODE_LABELS,
  UNAVAILABLE_HELP,
  UNAVAILABLE_LABELS,
  draftSettings,
  invalidDomains,
  invalidPaths,
  sandboxChangeLines,
} from '@/lib/agent-sandbox'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { useQuery } from '@/lib/use-query'
import { cn } from '@/lib/utils'

const TITLE = 'AI の囲い'
const FOLLOW = '__company__'

export default function AgentSandboxPage() {
  const { companyId, role, isAdmin } = useCompany()
  const view = useQuery(isAdmin ? `agent-sandbox:${companyId}` : null, () => agentSandboxApi.get(companyId))

  if (role !== null && !isAdmin) {
    return (
      <>
        <PageHeader title={TITLE} />
        <EmptyState icon={LockSimple} title="このページはオーナーと管理者だけが使えます" />
      </>
    )
  }
  return (
    <>
      <PageHeader title={TITLE} />
      <div className="-mt-2 mb-6 max-w-3xl space-y-2 text-sm text-muted-foreground">
        <p>
          メンバーのデスクトップアプリで AI が実行するコマンドを、
          <strong className="font-medium text-foreground">会社が許可した宛先にだけ接続でき、秘密の置き場所は読めない</strong>
          ように囲います。囲いは Claude Code・Codex に組み込まれた仕組みを使います（Mac のみ。Windows では「記録だけ」になります）。
        </p>
        <p>おすすめの進め方: まず自分だけ「囲う」にして1週間 → 1つの部署 → 全員。止まった操作は「AI の操作の記録」で確かめられます。</p>
      </div>
      {view.loading ? (
        <ListSkeleton rows={4} />
      ) : view.error && !view.data ? (
        <ErrorState error={view.error} onRetry={view.reload} />
      ) : view.data ? (
        <div className="space-y-6 pb-4">
          <SettingsForm
            key={JSON.stringify(view.data.settings)}
            saved={view.data}
            onSaved={(next) => view.setData(() => next)}
          />
          <OverridesCard view={view.data} onSaved={(next) => view.setData(() => next)} />
          <ImpactCard />
          <HistoryCard history={view.data.history} />
        </div>
      ) : null}
    </>
  )
}

function SettingsForm({ saved, onSaved }: { saved: AgentSandboxView; onSaved: (next: AgentSandboxView) => void }) {
  const { companyId } = useCompany()
  const [mode, setMode] = useState<AgentSandboxMode>(saved.settings.mode)
  const [onUnavailable, setOnUnavailable] = useState<AgentSandboxUnavailable>(saved.settings.onUnavailable)
  const [domains, setDomains] = useState(saved.settings.allowedDomains.join('\n'))
  const [paths, setPaths] = useState(saved.settings.deniedReadPaths.join('\n'))
  const [busy, setBusy] = useState(false)

  const badDomains = invalidDomains(domains)
  const badPaths = invalidPaths(paths)
  const after = draftSettings({ mode, onUnavailable, domains, paths })
  const lines = sandboxChangeLines(saved.settings, after)
  const invalid = badDomains.length > 0 || badPaths.length > 0
  const dirty = lines.length > 0 || invalid

  const reset = () => {
    setMode(saved.settings.mode)
    setOnUnavailable(saved.settings.onUnavailable)
    setDomains(saved.settings.allowedDomains.join('\n'))
    setPaths(saved.settings.deniedReadPaths.join('\n'))
  }

  const save = async () => {
    if (invalid || lines.length === 0) return
    setBusy(true)
    try {
      const next = await agentSandboxApi.update(companyId, after)
      toast.success('設定を保存しました', { description: '各メンバーのアプリには、次に AI に相談するときから反映されます。' })
      onSaved(next)
    } catch (err) {
      toast.error('設定を保存できませんでした', { description: describeError(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2">
            <Barricade size={16} />
            会社全体の動作
          </CardTitle>
          <CardDescription>メンバーごとに変える場合は、下の「メンバーごとの動作」で指定します。</CardDescription>
        </CardHeader>
        <div role="radiogroup" aria-label="会社全体の動作" className="grid gap-3 border-t px-5 py-4 md:grid-cols-3">
          {SANDBOX_MODES.map((m) => (
            <RadioCard key={m} checked={mode === m} onSelect={() => setMode(m)} label={SANDBOX_MODE_LABELS[m]} help={SANDBOX_MODE_HELP[m]} />
          ))}
        </div>
        <div className="border-t px-5 py-4">
          <p className="mb-2 text-sm font-medium">囲いを開始できない PC では</p>
          <div role="radiogroup" aria-label="囲いを開始できない PC では" className="grid gap-3 md:grid-cols-2">
            {(['record-only', 'stop'] as const).map((u) => (
              <RadioCard key={u} checked={onUnavailable === u} onSelect={() => setOnUnavailable(u)} label={UNAVAILABLE_LABELS[u]} help={UNAVAILABLE_HELP[u]} />
            ))}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2">
            <Globe size={16} />
            接続してよい宛先
          </CardTitle>
          <CardDescription>
            1行に1つ。<code>*.example.com</code> と書くと、そのサブドメインすべてを許可します。ACB のサーバーはいつでも接続できます。AI 自身の Web 検索は「Web で調べる」を通るため、ここには関係しません。
          </CardDescription>
        </CardHeader>
        <div className="space-y-2 border-t px-5 py-4">
          <Textarea
            aria-label="接続してよい宛先"
            aria-invalid={badDomains.length > 0 || undefined}
            className="min-h-40 font-mono"
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
          />
          {badDomains.length > 0 && (
            <p className="text-sm text-destructive" role="alert">
              使えない書き方があります: {badDomains.join('、')}（「*」だけ・IP アドレス・localhost・https:// やパスは書けません）
            </p>
          )}
          <Button variant="outline" size="sm" onClick={() => setDomains(saved.defaultAllowedDomains.join('\n'))}>
            <ArrowCounterClockwise size={14} />
            初期の一覧に戻す
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2">
            <FolderLock size={16} />
            ほかに読ませない場所
          </CardTitle>
          <CardDescription>
            1行に1つ。<code>~/</code>（ホームフォルダ）か <code>/</code> から書きます。SSH・クラウドの鍵、キーチェーン、ブラウザのデータ、パスワード管理アプリ、ACB アプリのデータは、ここに書かなくても読めません。
          </CardDescription>
        </CardHeader>
        <div className="space-y-2 border-t px-5 py-4">
          <Textarea
            aria-label="ほかに読ませない場所"
            aria-invalid={badPaths.length > 0 || undefined}
            className="min-h-24 font-mono"
            placeholder="~/Desktop/社外秘"
            value={paths}
            onChange={(e) => setPaths(e.target.value)}
          />
          {badPaths.length > 0 && (
            <p className="text-sm text-destructive" role="alert">
              使えない書き方があります: {badPaths.join('、')}（ホームフォルダ全体「~」や「..」「*」は書けません）
            </p>
          )}
        </div>
      </Card>

      <div
        className={cn(
          'sticky bottom-4 z-10 flex flex-col gap-3 rounded-xl border bg-card px-4 py-3 shadow-md sm:flex-row sm:items-center sm:justify-between',
          !dirty && 'hidden'
        )}
        aria-live="polite"
      >
        <div className="text-sm">
          <p className="font-medium">{invalid ? '直してから保存してください' : '保存していない変更があります'}</p>
          <ul className="text-muted-foreground">
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" onClick={reset} disabled={busy}>
            取り消す
          </Button>
          <Button onClick={save} disabled={busy || invalid || lines.length === 0}>
            {busy ? '保存しています…' : '保存'}
          </Button>
        </div>
      </div>
    </>
  )
}

function RadioCard({ checked, onSelect, label, help }: { checked: boolean; onSelect: () => void; label: string; help: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        'flex flex-col items-start gap-1 rounded-xl border px-4 py-3 text-left outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
        checked ? 'border-brand ring-1 ring-brand/40' : 'hover:border-foreground/20'
      )}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        <span aria-hidden="true" className={cn('flex size-4 items-center justify-center rounded-full border', checked ? 'border-brand' : 'border-input')}>
          {checked && <span className="size-2 rounded-full bg-brand" />}
        </span>
        {label}
      </span>
      <span className="text-xs text-muted-foreground">{help}</span>
    </button>
  )
}

function OverridesCard({ view, onSaved }: { view: AgentSandboxView; onSaved: (next: AgentSandboxView) => void }) {
  const { companyId } = useCompany()
  const members = useQuery(`members:${companyId}`, () => companiesApi.getMembers(companyId))
  const [busy, setBusy] = useState<string | null>(null)
  const byUser = new Map(view.overrides.map((o) => [o.userId, o.mode]))

  const change = async (userId: string, value: string) => {
    setBusy(userId)
    try {
      const next = await agentSandboxApi.setOverride(companyId, userId, value === FOLLOW ? null : (value as AgentSandboxMode))
      onSaved(next)
      toast.success('メンバーの動作を変更しました')
    } catch (err) {
      toast.error('変更できませんでした', { description: describeError(err) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <UserSwitch size={16} />
          メンバーごとの動作
        </CardTitle>
        <CardDescription>
          順番に広げるときに使います（例: 会社全体は「記録だけ」のまま、自分だけ「囲う」）。会社全体の動作は「{SANDBOX_MODE_LABELS[view.settings.mode]}」です。
        </CardDescription>
      </CardHeader>
      <div className="border-t px-5 py-2">
        {members.loading ? (
          <ListSkeleton rows={3} />
        ) : members.error && !members.data ? (
          <p className="py-2 text-sm text-destructive">{describeError(members.error)}</p>
        ) : (
          <ul className="divide-y">
            {(members.data ?? []).map((m) => {
              const name = m.name || m.email || '名前未設定'
              const own = byUser.get(m.userId)
              return (
                <li key={m.userId} className="flex items-center gap-3 py-2">
                  <Avatar name={name} seed={m.userId} className="size-7" />
                  <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
                  <Select value={own ?? FOLLOW} onValueChange={(v) => change(m.userId, v)} disabled={busy === m.userId}>
                    <SelectTrigger className="w-52" aria-label={`${name}の動作`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={FOLLOW}>会社と同じ（{SANDBOX_MODE_LABELS[view.settings.mode]}）</SelectItem>
                      {SANDBOX_MODES.map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {SANDBOX_MODE_LABELS[mode]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Card>
  )
}

function describeChange(c: AgentSandboxChange['change']): string[] {
  if (c.target === 'member') {
    const who = c.memberName || 'メンバー'
    const label = (m: AgentSandboxMode | null) => (m ? SANDBOX_MODE_LABELS[m] : '会社と同じ')
    return [`${who}の動作: ${label(c.before)} → ${label(c.after)}`]
  }
  return sandboxChangeLines(c.before, c.after)
}

function HistoryCard({ history }: { history: AgentSandboxChange[] }) {
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <ClockCounterClockwise size={16} />
          変更の記録
        </CardTitle>
      </CardHeader>
      <div className="border-t px-5 py-2">
        {history.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">まだ変更はありません。</p>
        ) : (
          <ul className="divide-y text-sm">
            {history.map((h) => (
              <li key={h.id} className="py-2">
                <p className="text-muted-foreground">
                  {formatDateTime(h.changedAt)}・{h.name || h.email || '名前未設定'}
                </p>
                <ul>
                  {describeChange(h.change).map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}
