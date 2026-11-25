'use client'

import Link from 'next/link'
import { useState } from 'react'
import { toast } from 'sonner'
import { Browsers, CaretRight, ClockCounterClockwise, Desktop, Globe, Key, Plus, ShieldSlash, Trash, UserSwitch, UsersThree } from '@phosphor-icons/react'

import { RadioCard } from '@/components/app/radio-card'
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { AdvancedCrumb } from '@/components/advanced/crumb'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  agentBrowserApi,
  companiesApi,
  type AgentBrowserChange,
  type AgentBrowserView,
  type BrowserOperationLevel,
  type BrowserOperationMode,
} from '@/lib/api'
import {
  BROWSER_INTRO,
  BROWSER_LEVELS,
  BROWSER_LEVEL_HELP,
  BROWSER_LEVEL_LABELS,
  BROWSER_LOGIN_NOTE,
  BROWSER_MODES,
  BROWSER_MODE_HELP,
  BROWSER_MODE_LABELS,
  BROWSER_NOT_YET_NOTE,
  BROWSER_DEVELOPER_PARTS_HELP,
  BROWSER_STORED_PARTS_NOTE,
  BROWSER_PARTS_NOTE,
  BROWSER_SITES_HELP,
  BROWSER_SITE_LIMIT,
  BROWSER_TITLE,
  SITE_PARTS_ASSETS_HELP,
  SITE_PARTS_FRAME_LABEL,
  SITE_PARTS_HELPERS_HELP,
  SITE_PARTS_HELPER_LIMIT,
  SITE_PARTS_INTRO,
  SITE_PARTS_POST_LABEL,
  SITE_PARTS_TITLE,
  browserChangeLines,
  developerAssetHostsShown,
  draftBrowserSettings,
  siteDrafts,
  sitePartsBody,
  sitePartsChangeLines,
  sitePartsDraft,
  sitePartsProblems,
  siteProblems,
  type SiteDraft,
  type SitePartsDraft,
} from '@/lib/agent-browser'
import { PCS_TITLE, PEOPLE_TITLE } from '@/lib/agent-browser-people'
import { linesOf } from '@/lib/agent-sandbox'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { useQuery } from '@/lib/use-query'
import { cn } from '@/lib/utils'

const FOLLOW = '__company__'

/** 「詳しい設定 › AI の安全 › ブラウザ操作」 (owner/admin; .claude/rules/agent-browser.md). */
export default function AgentBrowserPage() {
  const { companyId, role, isAdmin } = useCompany()
  const view = useQuery(isAdmin ? `agent-browser:${companyId}` : null, () => agentBrowserApi.get(companyId))

  if (role !== null && !isAdmin) {
    return (
      <>
        <AdvancedCrumb aiSafety />
        <PageHeader title={BROWSER_TITLE} />
        <EmptyState icon={ShieldSlash} title="このページはオーナーと管理者だけが使えます" />
      </>
    )
  }
  return (
    <>
      <AdvancedCrumb aiSafety />
      <PageHeader title={BROWSER_TITLE} />
      <div className="-mt-2 mb-6 max-w-3xl space-y-2 text-sm text-muted-foreground">
        <p>{BROWSER_INTRO}</p>
      </div>
      {view.loading ? (
        <ListSkeleton rows={4} />
      ) : view.error && !view.data ? (
        <ErrorState error={view.error} onRetry={view.reload} />
      ) : view.data ? (
        <div className="space-y-6 pb-4">
          <BrowserSubPages companyId={companyId} />
          <SettingsForm key={JSON.stringify(view.data.settings)} saved={view.data} onSaved={(next) => view.setData(() => next)} />
          <OverridesCard view={view.data} onSaved={(next) => view.setData(() => next)} />
          <HistoryCard history={view.data.history} />
        </div>
      ) : null}
    </>
  )
}

/** The two pages of PC registration and per-作業 grants (design memo v2 §7-2: links only on this page). */
function BrowserSubPages({ companyId }: { companyId: string }) {
  const pages = [
    { segment: 'pcs', title: PCS_TITLE, description: 'メンバーが登録した PC を確かめて、使えるようにする・止める', icon: Desktop },
    { segment: 'people', title: PEOPLE_TITLE, description: 'AI に任せてよい作業を、人ごとに選ぶ', icon: UsersThree },
  ]
  return (
    <ul aria-label="ブラウザ操作の PC と使える人" className="divide-y overflow-hidden rounded-card border bg-card">
      {pages.map((p) => (
        <li key={p.segment}>
          <Link
            href={`/companies/${companyId}/advanced/ai-safety/browser/${p.segment}`}
            className="flex items-center gap-3 px-5 py-4 outline-none transition-colors hover:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <p.icon size={18} className="shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="text-body font-semibold">{p.title}</div>
              <div className="text-small text-muted-foreground">{p.description}</div>
            </div>
            <CaretRight size={14} className="shrink-0 text-muted-foreground" />
          </Link>
        </li>
      ))}
    </ul>
  )
}

function SettingsForm({ saved, onSaved }: { saved: AgentBrowserView; onSaved: (next: AgentBrowserView) => void }) {
  const { companyId } = useCompany()
  const [mode, setMode] = useState<BrowserOperationMode>(saved.settings.mode)
  const [sites, setSites] = useState<SiteDraft[]>(siteDrafts(saved.settings))
  const [busy, setBusy] = useState(false)

  const problems = sites.map((s, i) => siteProblems(s, sites.slice(0, i)))
  const savedHosts = saved.settings.sites.map((s) => s.host)
  const developer = developerAssetHostsShown()
  const invalid = problems.some((p) => p.length > 0)
  const after = draftBrowserSettings(mode, sites)
  const lines = browserChangeLines(saved.settings, after)
  const dirty = lines.length > 0 || invalid

  const edit = (index: number, change: Partial<SiteDraft>) => setSites((all) => all.map((s, i) => (i === index ? { ...s, ...change } : s)))
  const reset = () => {
    setMode(saved.settings.mode)
    setSites(siteDrafts(saved.settings))
  }

  const save = async () => {
    if (invalid || lines.length === 0) return
    setBusy(true)
    try {
      const next = await agentBrowserApi.update(companyId, after)
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
            <Browsers size={16} />
            会社全体
          </CardTitle>
          <CardDescription>メンバーごとに変える場合は、下の「メンバーごとの動作」で指定します。</CardDescription>
          <p className="text-sm font-medium text-foreground">{BROWSER_NOT_YET_NOTE}</p>
        </CardHeader>
        <div role="radiogroup" aria-label="会社全体" className="grid gap-3 border-t px-5 py-4 md:grid-cols-2">
          {BROWSER_MODES.map((m) => (
            <RadioCard key={m} checked={mode === m} onSelect={() => setMode(m)} label={BROWSER_MODE_LABELS[m]} help={BROWSER_MODE_HELP[m]} />
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2">
            <Globe size={16} />
            サイトの一覧
          </CardTitle>
          <CardDescription>{BROWSER_SITES_HELP}</CardDescription>
          <CardDescription>{BROWSER_PARTS_NOTE}</CardDescription>
        </CardHeader>
        <div className="space-y-4 border-t px-5 py-4">
          {sites.length === 0 && <p className="text-sm text-muted-foreground">まだサイトはありません。</p>}
          {sites.map((site, i) => {
            const n = i + 1
            return (
              <fieldset key={i} aria-label={`サイト ${n}`} className="space-y-3 rounded-control border p-4">
                <div className="grid gap-3 md:grid-cols-[1fr_14rem]">
                  <label className="space-y-1 text-sm">
                    <span className="font-medium">操作するサイト</span>
                    <Input
                      aria-label={`サイト ${n} の操作するサイト`}
                      className="font-mono"
                      placeholder="crm.example.com"
                      value={site.host}
                      onChange={(e) => edit(i, { host: e.target.value })}
                    />
                  </label>
                  <div className="space-y-1 text-sm">
                    <span className="font-medium">段階</span>
                    <Select value={site.level} onValueChange={(v) => edit(i, { level: v as BrowserOperationLevel })}>
                      <SelectTrigger className="w-full" aria-label={`サイト ${n} の段階`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {BROWSER_LEVELS.map((level) => (
                          <SelectItem key={level} value={level}>
                            {BROWSER_LEVEL_LABELS[level]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{BROWSER_LEVEL_HELP[site.level]}</p>
                  </div>
                </div>
                {developer && (
                  <label className="block space-y-1 text-sm">
                    <span className="font-medium">画面の部品を取る先（開発用）</span>
                    <Textarea
                      aria-label={`サイト ${n} の画面の部品を取る先`}
                      aria-invalid={problems[i].length > 0 || undefined}
                      className="min-h-20 font-mono"
                      placeholder="cdn.example.net"
                      value={site.assetHosts}
                      onChange={(e) => edit(i, { assetHosts: e.target.value })}
                    />
                    <span className="block text-small text-muted-foreground">{BROWSER_DEVELOPER_PARTS_HELP}</span>
                  </label>
                )}
                {!developer && linesOf(site.assetHosts).length > 0 && (
                  <div role="group" aria-label={`サイト ${n} の前に書いた部品を取る先`} className="space-y-2 rounded-control border p-3 text-body">
                    <p className="font-medium">画面の部品を取る先（前に書いたもの）</p>
                    <p className="font-mono">{linesOf(site.assetHosts).join('、')}</p>
                    <p className="text-small text-muted-foreground">{BROWSER_STORED_PARTS_NOTE}</p>
                    <Button variant="outline" size="sm" onClick={() => edit(i, { assetHosts: '' })}>
                      前に書いたものを消す
                    </Button>
                  </div>
                )}
                {problems[i].length > 0 && (
                  <ul className="text-sm text-destructive" role="alert">
                    {problems[i].map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                )}
                {savedHosts.includes(site.host) && (
                  <SitePartsEditor
                    key={`${site.host}:${JSON.stringify((saved.siteParts ?? []).find((p) => p.host === site.host) ?? null)}`}
                    host={site.host}
                    savedHosts={savedHosts}
                    view={saved}
                    onSaved={onSaved}
                  />
                )}
                <Button variant="outline" size="sm" onClick={() => setSites((all) => all.filter((_, j) => j !== i))}>
                  <Trash size={14} />
                  このサイトを外す
                </Button>
              </fieldset>
            )
          })}
          <Button
            variant="outline"
            size="sm"
            disabled={sites.length >= BROWSER_SITE_LIMIT}
            onClick={() => setSites((all) => [...all, { host: '', level: 'read', assetHosts: '' }])}
          >
            <Plus size={14} />
            サイトを追加
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2">
            <Key size={16} />
            サイトへのログイン
          </CardTitle>
          <CardDescription>{BROWSER_LOGIN_NOTE}</CardDescription>
        </CardHeader>
      </Card>

      <div
        className={cn(
          'sticky bottom-4 z-10 flex flex-col gap-3 rounded-card border bg-card px-4 py-3 shadow-md sm:flex-row sm:items-center sm:justify-between',
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

/**
 * A saved site's 「詳しい設定」 (agent-browser.md "A domain's parts and login helpers"): where its pages load parts
 * from and what a person's login needs, saved on its own (folded: the FDE fills it after reading a recording).
 */
function SitePartsEditor({ host, savedHosts, view, onSaved }: { host: string; savedHosts: string[]; view: AgentBrowserView; onSaved: (next: AgentBrowserView) => void }) {
  const { companyId } = useCompany()
  const stored = (view.siteParts ?? []).find((p) => p.host === host)
  const [draft, setDraft] = useState<SitePartsDraft>(sitePartsDraft(stored))
  const [busy, setBusy] = useState(false)
  const body = sitePartsBody(host, draft)
  const problems = sitePartsProblems(body, savedHosts)
  const changed = JSON.stringify(body) !== JSON.stringify(sitePartsBody(host, sitePartsDraft(stored)))
  const editHelper = (index: number, change: Partial<SitePartsDraft['loginHelpers'][number]>) =>
    setDraft((d) => ({ ...d, loginHelpers: d.loginHelpers.map((h, i) => (i === index ? { ...h, ...change } : h)) }))

  const save = async () => {
    if (problems.length > 0 || !changed) return
    setBusy(true)
    try {
      const next = await agentBrowserApi.setSiteParts(companyId, body)
      toast.success('詳しい設定を保存しました', { description: '各メンバーのアプリには、次にサイトを開くときから反映されます。' })
      onSaved(next)
    } catch (err) {
      toast.error('詳しい設定を保存できませんでした', { description: describeError(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="rounded-control border px-4 py-3 text-body">
      <summary className="cursor-pointer font-medium">{SITE_PARTS_TITLE}</summary>
      <div role="group" aria-label={`${host} の詳しい設定`} className="mt-3 space-y-4">
        <p className="text-small text-muted-foreground">{SITE_PARTS_INTRO}</p>
        <label className="block space-y-1">
          <span className="font-medium">画面の部品を読み込む先</span>
          <Textarea
            aria-label={`${host} の部品を読み込む先`}
            className="min-h-20 font-mono"
            placeholder="img.example.net"
            value={draft.assetHosts}
            onChange={(e) => setDraft((d) => ({ ...d, assetHosts: e.target.value }))}
          />
          <span className="block text-small text-muted-foreground">{SITE_PARTS_ASSETS_HELP}</span>
        </label>
        <div className="space-y-2">
          <p className="font-medium">ログインの補助</p>
          <p className="text-small text-muted-foreground">{SITE_PARTS_HELPERS_HELP}</p>
          {draft.loginHelpers.map((h, i) => {
            const n = i + 1
            return (
              <div key={i} role="group" aria-label={`${host} のログインの補助 ${n}`} className="space-y-2 rounded-control border p-3">
                <div className="grid gap-2 md:grid-cols-2">
                  <Input aria-label={`ログインの補助 ${n} のアドレス`} className="font-mono" placeholder="check.example.org" value={h.host} onChange={(e) => editHelper(i, { host: e.target.value })} />
                  <Input aria-label={`ログインの補助 ${n} の道`} className="font-mono" placeholder="/check/" value={h.pathPrefix} onChange={(e) => editHelper(i, { pathPrefix: e.target.value })} />
                </div>
                <div className="flex flex-wrap gap-4">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={h.frame} onChange={(e) => editHelper(i, { frame: e.target.checked })} />
                    {SITE_PARTS_FRAME_LABEL}
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={h.post} onChange={(e) => editHelper(i, { post: e.target.checked })} />
                    {SITE_PARTS_POST_LABEL}
                  </label>
                </div>
                <Button variant="outline" size="sm" onClick={() => setDraft((d) => ({ ...d, loginHelpers: d.loginHelpers.filter((_, j) => j !== i) }))}>
                  <Trash size={14} />
                  この補助を外す
                </Button>
              </div>
            )
          })}
          <Button
            variant="outline"
            size="sm"
            disabled={draft.loginHelpers.length >= SITE_PARTS_HELPER_LIMIT}
            onClick={() => setDraft((d) => ({ ...d, loginHelpers: [...d.loginHelpers, { host: '', pathPrefix: '', frame: false, post: false }] }))}
          >
            <Plus size={14} />
            ログインの補助を追加
          </Button>
        </div>
        {problems.length > 0 && (
          <ul className="text-body text-destructive" role="alert">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <Button size="sm" onClick={save} disabled={busy || problems.length > 0 || !changed}>
          {busy ? '保存しています…' : '詳しい設定を保存'}
        </Button>
      </div>
    </details>
  )
}

function OverridesCard({ view, onSaved }: { view: AgentBrowserView; onSaved: (next: AgentBrowserView) => void }) {
  const { companyId } = useCompany()
  const members = useQuery(`members:${companyId}`, () => companiesApi.getMembers(companyId))
  const [busy, setBusy] = useState<string | null>(null)
  const byUser = new Map(view.overrides.map((o) => [o.userId, o.mode]))

  const change = async (userId: string, value: string) => {
    setBusy(userId)
    try {
      const next = await agentBrowserApi.setOverride(companyId, userId, value === FOLLOW ? null : (value as BrowserOperationMode))
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
          まず一部の人だけで試すときに使います（例: 会社全体は「使わない」のまま、自分だけ「使う」）。会社全体の動作は「{BROWSER_MODE_LABELS[view.settings.mode]}」です。
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
                      <SelectItem value={FOLLOW}>会社と同じ（{BROWSER_MODE_LABELS[view.settings.mode]}）</SelectItem>
                      {BROWSER_MODES.map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {BROWSER_MODE_LABELS[mode]}
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

function describeChange(c: AgentBrowserChange['change']): string[] {
  if (c.target === 'member') {
    const who = c.memberName || 'メンバー'
    const label = (m: BrowserOperationMode | null) => (m ? BROWSER_MODE_LABELS[m] : '会社と同じ')
    return [`${who}の動作: ${label(c.before)} → ${label(c.after)}`]
  }
  if (c.target === 'site-parts') return sitePartsChangeLines(c.host, c.before, c.after)
  return browserChangeLines(c.before, c.after)
}

function HistoryCard({ history }: { history: AgentBrowserChange[] }) {
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
