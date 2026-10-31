'use client'

// 「API キー」: the key broker's admin page (owner/admin). Keys are write-only —
// the page shows the last four characters, never a value.
import { useState } from 'react'
import { toast } from 'sonner'
import { ClockCounterClockwise, Key, LockSimple, Plus, ShieldWarning, SlidersHorizontal, UserCircle, Warning } from '@phosphor-icons/react'

import { KeyForm, createBody, type KeyFormValues } from '@/components/key-broker/key-form'
import { RelayServicesCard } from '@/components/key-broker/relay-services'
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  companiesApi,
  keyBrokerApi,
  type BrokerKeyRule,
  type BrokerKeySummary,
  type BrokerServiceCategory,
  type BrokerServiceView,
  type BrokerView,
  type Member,
} from '@/lib/api'
import {
  BROKER_OFF_HELP,
  BROKER_OFF_TEXT,
  CHECK_RESULT_TEXT,
  OWN_KEYS_SWITCH_HELP,
  CATEGORY_HELP,
  CATEGORY_LABELS,
  RULE_LABELS,
  STATUS_LABELS,
  brokerChangeLines,
  checkBrokerSecret,
  describePeople,
  describeWork,
  describeCaps,
  describeUsage,
  hostsOf,
  invalidHosts,
  ownKeysOn,
  type Names,
} from '@/lib/key-broker'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { useQuery } from '@/lib/use-query'

const TITLE = 'API キー'

type Dialogs =
  | { kind: 'create' }
  | { kind: 'edit'; key: BrokerKeySummary }
  | { kind: 'replace'; key: BrokerKeySummary }
  | { kind: 'delete'; key: BrokerKeySummary }
  | { kind: 'stop-all' }
  | null

export default function ApiKeysPage() {
  const { companyId, role, isAdmin } = useCompany()
  const view = useQuery(isAdmin ? `broker:${companyId}` : null, () => keyBrokerApi.get(companyId))
  const members = useQuery(isAdmin ? `members:${companyId}` : null, () => companiesApi.getMembers(companyId))
  const [dialog, setDialog] = useState<Dialogs>(null)
  const [busy, setBusy] = useState(false)

  if (role !== null && !isAdmin) {
    return (
      <>
        <PageHeader title={TITLE} />
        <EmptyState icon={LockSimple} title="このページはオーナーと管理者だけが使えます" />
      </>
    )
  }

  const data = view.data
  const memberList = members.data ?? []
  const names: Names = {
    member: (id) => memberList.find((m) => m.userId === id)?.name || memberList.find((m) => m.userId === id)?.email || '（メンバー）',
    department: (id) => data?.departments.find((d) => d.id === id)?.name ?? '（削除された部署）',
  }

  /** Run a change; the answer is the whole new view. Resolves whether it was saved. */
  const run = async (label: string, fn: () => Promise<BrokerView>): Promise<boolean> => {
    setBusy(true)
    try {
      const next = await fn()
      view.setData(() => next)
      // A key just saved was checked once (read-only request to the service): say how it went.
      if (next.check?.result === 'valid') toast.success(label, { description: CHECK_RESULT_TEXT.valid })
      else if (next.check) toast.warning(label, { description: CHECK_RESULT_TEXT[next.check.result] })
      else toast.success(label)
      setDialog(null)
      return true
    } catch (err) {
      toast.error('保存できませんでした', { description: describeError(err) })
      return false
    } finally {
      setBusy(false)
    }
  }

  const submitKey = (v: KeyFormValues) => {
    if (dialog?.kind === 'edit') {
      const k = dialog.key
      return run('設定を保存しました', () =>
        keyBrokerApi.update(companyId, k.id, {
          displayName: v.displayName,
          destinations: v.destinations,
          audience: v.audience,
          caps: v.caps,
          allowPrivateContent: v.allowPrivateContent,
        })
      )
    }
    return run('API キーを登録しました', () => keyBrokerApi.create(companyId, createBody(v)))
  }

  const companyKeys = data?.keys.filter((k) => k.scope === 'company') ?? []
  const ownKeys = data?.keys.filter((k) => k.scope === 'user') ?? []

  return (
    <>
      <PageHeader
        title={TITLE}
        actions={
          data?.status.enabled ? (
            <Button onClick={() => setDialog({ kind: 'create' })}>
              <Plus size={14} />
              API キーを登録
            </Button>
          ) : null
        }
      />
      <div className="-mt-2 mb-6 max-w-3xl space-y-2 text-sm text-muted-foreground">
        <p>
          会社の API キーをサーバーで預かります。メンバーの PC や AI にはキーを置かず、
          <strong className="font-medium text-foreground">AI には短い時間だけ使える通行証だけ</strong>
          を渡します。登録したキーは誰にも（管理者にも）表示されません。
        </p>
      </div>
      {view.loading ? (
        <ListSkeleton rows={4} />
      ) : view.error && !data ? (
        <ErrorState error={view.error} onRetry={view.reload} />
      ) : data ? (
        <div className="space-y-6 pb-4">
          {!data.status.enabled && data.status.reason && (
            <div role="status" className="flex gap-3 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm">
              <Warning size={18} className="mt-0.5 shrink-0 text-warning" />
              <div>
                <p className="font-medium">API キーを預かる機能は、いまは使えません</p>
                <p className="text-muted-foreground">
                  {BROKER_OFF_TEXT[data.status.reason]}
                  {BROKER_OFF_HELP}
                </p>
              </div>
            </div>
          )}

          {data.services.filter((s) => s.practice).map((s) => (
            <div key={s.service} role="status" className="flex gap-3 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm">
              <Warning size={18} className="mt-0.5 shrink-0 text-warning" />
              <p className="font-medium">練習用の {s.label} につながっています（このサーバーは検証用です。本物の {s.label} には届きません）</p>
            </div>
          ))}

          {data.keys.some((k) => k.status === 'active') && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 px-4 py-3 text-sm">
              <span>
                緊急のときは、すべての鍵（会社の鍵とメンバーの自分の鍵）を今すぐ止められます。AI からの呼び出しは、次の1回から止まります。
              </span>
              <Button variant="destructive" size="sm" disabled={busy} onClick={() => setDialog({ kind: 'stop-all' })}>
                すべての鍵を止める
              </Button>
            </div>
          )}

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2">
                <Key size={16} />
                会社の鍵
              </CardTitle>
              <CardDescription>部署や全員に使わせる会社の API キーです。</CardDescription>
            </CardHeader>
            <div className="border-t px-5 py-2">
              {companyKeys.length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">まだ登録されていません。</p>
              ) : (
                <ul className="divide-y">
                  {companyKeys.map((k) => (
                    <KeyRow key={k.id} k={k} names={names} busy={busy} enabled={data.status.enabled} onDialog={setDialog}
                      onToggle={() => run(k.status === 'active' ? 'キーを停止しました' : 'キーを再開しました', () =>
                        keyBrokerApi.update(companyId, k.id, { status: k.status === 'active' ? 'disabled' : 'active' }))} />
                  ))}
                </ul>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2">
                <UserCircle size={16} />
                メンバーの自分の鍵
              </CardTitle>
              <CardDescription>メンバーが自分用に登録したキーの一覧です（中身は管理者にも表示されません）。個別に停止・削除できます。</CardDescription>
            </CardHeader>
            <div className="space-y-3 border-t px-5 py-3">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={data.settings.memberKeysAllowed}
                  disabled={busy}
                  onChange={(e) => run('設定を保存しました', () => keyBrokerApi.setMemberKeysAllowed(companyId, e.target.checked))}
                />
                <span>
                  メンバーが自分の鍵を登録してよい
                  <span className="block text-xs text-muted-foreground">登録できるのは、下の「サービスごとの決め方」で「メンバーが自分の鍵を使ってよい」をオンにしたサービスだけです。</span>
                </span>
              </label>
              {ownKeys.length === 0 ? (
                <p className="text-sm text-muted-foreground">まだ登録されていません。</p>
              ) : (
                <ul className="divide-y">
                  {ownKeys.map((k) => (
                    <KeyRow key={k.id} k={k} names={names} busy={busy} enabled={data.status.enabled} onDialog={setDialog}
                      onToggle={() => run(k.status === 'active' ? 'キーを停止しました' : 'キーを再開しました', () =>
                        keyBrokerApi.update(companyId, k.id, { status: k.status === 'active' ? 'disabled' : 'active' }))} />
                  ))}
                </ul>
              )}
            </div>
          </Card>

          <RelayServicesCard
            view={data}
            busy={busy}
            onSave={(s, definition) => run('サービスを保存しました', () => keyBrokerApi.saveRelayService(companyId, s, definition))}
            onRemove={(s) => run('サービスを削除しました', () => keyBrokerApi.removeRelayService(companyId, s))}
          />
          <ServicesCard
            view={data}
            busy={busy}
            onSave={(s, setting) => run('サービスの設定を保存しました', () => keyBrokerApi.setService(companyId, s, setting))}
            onSwitch={(s, allowed) => run(allowed ? 'メンバーが自分の鍵を使えるようにしました' : '会社の鍵だけを使うようにしました', () => keyBrokerApi.setOwnKeys(companyId, s, allowed))}
          />
          <InternalHostsCard
            hosts={data.settings.internalHosts}
            busy={busy}
            onSave={(hosts) => run('社内の宛先の例外を保存しました', () => keyBrokerApi.setInternalHosts(companyId, hosts))}
          />
          <HistoryCard view={data} names={names} />
        </div>
      ) : null}

      <Dialog open={dialog?.kind === 'create' || dialog?.kind === 'edit'} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          {data && (dialog?.kind === 'create' || dialog?.kind === 'edit') && (
            <KeyForm
              view={data}
              members={memberList as Member[]}
              editing={dialog.kind === 'edit' ? dialog.key : undefined}
              busy={busy}
              onSubmit={submitKey}
              onCancel={() => setDialog(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={dialog?.kind === 'replace'} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          {dialog?.kind === 'replace' && (
            <ReplaceForm
              k={dialog.key}
              busy={busy}
              onCancel={() => setDialog(null)}
              onSubmit={(secret) => run('キーを差し替えました', () => keyBrokerApi.replaceSecret(companyId, dialog.key.id, secret))}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={dialog?.kind === 'delete'} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          {dialog?.kind === 'delete' && (
            <>
              <DialogHeader>
                <DialogTitle>「{dialog.key.displayName}」を削除しますか？</DialogTitle>
                <DialogDescription>
                  サーバーに預けたキー（…{dialog.key.last4}）を消します。このキーを使っている AI の作業は止まります。発行元のキーは消えないので、不要なら発行元の画面でも無効にしてください。
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialog(null)} disabled={busy}>
                  キャンセル
                </Button>
                <Button variant="destructive" disabled={busy} onClick={() => run('キーを削除しました', () => keyBrokerApi.remove(companyId, dialog.key.id))}>
                  削除
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={dialog?.kind === 'stop-all'} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>すべての鍵を今すぐ止めますか？</DialogTitle>
            <DialogDescription>
              会社の鍵とメンバーの自分の鍵をすべて「停止中」にします。AI 経由の API の呼び出しは、次の1回から止まります。再開は鍵ごとに「再開」を押します。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)} disabled={busy}>
              キャンセル
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => run('すべての鍵を止めました', () => keyBrokerApi.stopAll(companyId))}>
              すべて止める
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function KeyRow({
  k,
  names,
  busy,
  enabled,
  onDialog,
  onToggle,
}: {
  k: BrokerKeySummary
  names: Names
  busy: boolean
  enabled: boolean
  onDialog: (d: Dialogs) => void
  onToggle: () => void
}) {
  const [showUsers, setShowUsers] = useState(false)
  const listId = `users-${k.id}`
  return (
    <li className="space-y-1 py-3" aria-label={k.displayName}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{k.displayName}</span>
        <Badge variant="outline">{k.service}</Badge>
        <span className="font-mono text-xs text-muted-foreground">…{k.last4}</span>
        <Badge variant={k.status === 'active' ? 'success' : 'warning'}>{STATUS_LABELS[k.status]}</Badge>
        {k.scope === 'user' && <span className="text-xs text-muted-foreground">{k.ownerName ?? 'メンバー'}の鍵</span>}
      </div>
      <dl className="grid gap-x-4 text-xs text-muted-foreground sm:grid-cols-[auto_1fr]">
        <dt>送り先</dt>
        <dd className="font-mono">{k.destinations.hosts.join('、')}{k.destinations.pathPrefixes.length ? ` / ${k.destinations.pathPrefixes.join('、')}` : ''}</dd>
        {k.destinations.models.length > 0 && (
          <>
            <dt>モデル</dt>
            <dd className="font-mono">{k.destinations.models.join('、')}</dd>
          </>
        )}
        {k.scope === 'company' && (
          <>
            <dt>使える仕事</dt>
            <dd>{describeWork(k.audience, names)}</dd>
            <dt>使える人</dt>
            <dd>{describePeople(k.audience, names)}</dd>
            <dt>上限</dt>
            <dd>{describeCaps(k.caps)}</dd>
            <dt>今日の利用</dt>
            <dd>{describeUsage(k.usageToday, k.caps)}</dd>
            <dt>非公開の内容</dt>
            <dd>{k.allowPrivateContent ? '送ってよい' : '送る前に確認する'}</dd>
          </>
        )}
        <dt>キーの登録</dt>
        <dd>{formatDateTime(k.secretUpdatedAt)}</dd>
      </dl>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button variant="ghost" size="sm" aria-expanded={showUsers} aria-controls={listId} onClick={() => setShowUsers((v) => !v)}>
          今使える人（{k.usableBy.length}人）
        </Button>
        {k.scope === 'company' && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onDialog({ kind: 'edit', key: k })}>
            設定を変更
          </Button>
        )}
        {k.scope === 'company' && enabled && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onDialog({ kind: 'replace', key: k })}>
            キーを差し替える
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={busy} onClick={onToggle}>
          {k.status === 'active' ? '停止' : '再開'}
        </Button>
        <Button variant="ghost" size="sm" className="text-destructive" disabled={busy} onClick={() => onDialog({ kind: 'delete', key: k })}>
          削除
        </Button>
      </div>
      {showUsers && (
        <ul id={listId} className="flex flex-wrap gap-1 pt-1 text-xs">
          {k.usableBy.length === 0 ? (
            <li className="text-muted-foreground">いません</li>
          ) : (
            k.usableBy.map((u) => (
              <li key={u.userId} className="rounded-md border px-1.5 py-0.5">
                {u.name || u.email || u.userId}
              </li>
            ))
          )}
        </ul>
      )}
    </li>
  )
}

function ReplaceForm({ k, busy, onSubmit, onCancel }: { k: BrokerKeySummary; busy: boolean; onSubmit: (secret: string) => void; onCancel: () => void }) {
  const [secret, setSecret] = useState('')
  const check = secret ? checkBrokerSecret(secret) : null
  const bad = check !== null && 'error' in check
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (secret && !bad) onSubmit(secret.trim())
      }}
    >
      <DialogHeader>
        <DialogTitle>「{k.displayName}」のキーを差し替え</DialogTitle>
        <DialogDescription>新しいキーを貼り付けます。今のキー（…{k.last4}）は上書きされます。宛先や使える人はそのままです。</DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor="replace-secret">新しいキー</Label>
        <Input id="replace-secret" type="password" autoComplete="off" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} />
        {bad && <p className="text-sm text-destructive" role="alert">キーは8文字以上、空白なしで貼り付けてください</p>}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          キャンセル
        </Button>
        <Button type="submit" disabled={busy || !secret || bad}>
          差し替える
        </Button>
      </DialogFooter>
    </form>
  )
}

type ServiceSave = (service: string, s: { category: BrokerServiceCategory; rule: BrokerKeyRule; ownKeyHosts: string[] }) => void

function ServicesCard({ view, busy, onSave, onSwitch }: { view: BrokerView; busy: boolean; onSave: ServiceSave; onSwitch: (service: string, allowed: boolean) => void }) {
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <SlidersHorizontal size={16} />
          サービスごとの決め方
        </CardTitle>
        <CardDescription>
          スキルや AI はキーではなくサービス名で頼みます。メンバーに自分の鍵を使わせてよいサービスは、スイッチをオンにするだけです（送り先は自動で決まります）。種類や決め方を細かく変えるときは「詳しい設定」を開きます。
        </CardDescription>
      </CardHeader>
      <ul className="divide-y border-t">
        {view.services.map((s) => (
          <ServiceRow key={`${s.service}:${s.updatedAt}`} s={s} busy={busy} memberKeysAllowed={view.settings.memberKeysAllowed} onSave={onSave} onSwitch={onSwitch} />
        ))}
      </ul>
    </Card>
  )
}

function ServiceRow({ s, busy, memberKeysAllowed, onSave, onSwitch }: {
  s: BrokerServiceView
  busy: boolean
  memberKeysAllowed: boolean
  onSave: ServiceSave
  onSwitch: (service: string, allowed: boolean) => void
}) {
  // The destination is known for built-in services and registered ones: one switch is enough.
  const known = s.defaultHosts.length > 0
  const on = ownKeysOn(s)
  const [details, setDetails] = useState(!known)
  const detailsId = `service-details-${s.service}`
  return (
    <li className="space-y-2 px-5 py-3" aria-label={s.label}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-sm font-medium">{s.label}</p>
        <p className="text-xs text-muted-foreground">
          会社の鍵 {s.companyKeys}・自分の鍵 {s.userKeys}
        </p>
        <p className="text-xs text-muted-foreground">決め方: {RULE_LABELS[s.rule]}</p>
      </div>
      {known ? (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={on} disabled={busy} onChange={(e) => onSwitch(s.service, e.target.checked)} />
          <span>
            メンバーが自分の鍵を使ってよい
            <span className="block text-xs text-muted-foreground">{OWN_KEYS_SWITCH_HELP}</span>
            {on && <span className="block text-xs text-muted-foreground">送り先: <span className="font-mono">{s.ownKeyHosts.join('、')}</span></span>}
            {on && !memberKeysAllowed && (
              <span className="block text-xs text-warning">いまは上の「メンバーが自分の鍵を登録してよい」がオフのため、登録できません。</span>
            )}
          </span>
        </label>
      ) : (
        <p className="text-xs text-muted-foreground">このサービスは送り先が決まっていないため、メンバーに自分の鍵を使わせるときは「自分の鍵の送り先」にホスト名を書きます。</p>
      )}
      {known && (
        <Button variant="ghost" size="sm" aria-expanded={details} aria-controls={detailsId} onClick={() => setDetails((v) => !v)}>
          詳しい設定
        </Button>
      )}
      {details && <ServiceDetails id={detailsId} s={s} busy={busy} onSave={onSave} />}
    </li>
  )
}

function ServiceDetails({ id, s, busy, onSave }: { id: string; s: BrokerServiceView; busy: boolean; onSave: ServiceSave }) {
  const [category, setCategory] = useState(s.category)
  const [rule, setRule] = useState(s.rule)
  const [hosts, setHosts] = useState(s.ownKeyHosts.join(', '))
  const hostText = hosts.split(/[,\s]+/).join('\n')
  const bad = invalidHosts(hostText)
  const dirty = category !== s.category || rule !== s.rule || hostsOf(hostText).join() !== s.ownKeyHosts.join()
  return (
    <div id={id} className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto] md:items-center">
      <select aria-label={`${s.label}の種類`} title={CATEGORY_HELP[category]} className="h-9 rounded-md border bg-transparent px-2 text-sm" value={category} onChange={(e) => setCategory(e.target.value as BrokerServiceCategory)}>
        {(Object.keys(CATEGORY_LABELS) as BrokerServiceCategory[]).map((c) => (
          <option key={c} value={c}>
            {CATEGORY_LABELS[c]}
          </option>
        ))}
      </select>
      <select aria-label={`${s.label}の決め方`} className="h-9 rounded-md border bg-transparent px-2 text-sm" value={rule} onChange={(e) => setRule(e.target.value as BrokerKeyRule)}>
        {(Object.keys(RULE_LABELS) as BrokerKeyRule[]).map((r) => (
          <option key={r} value={r}>
            {RULE_LABELS[r]}
          </option>
        ))}
      </select>
      <Input aria-label={`${s.label}の自分の鍵の送り先`} aria-invalid={bad.length > 0 || undefined} placeholder="自分の鍵の送り先（なし）" className="font-mono" value={hosts} onChange={(e) => setHosts(e.target.value)} />
      <Button size="sm" disabled={busy || !dirty || bad.length > 0} onClick={() => onSave(s.service, { category, rule, ownKeyHosts: hostsOf(hostText) })}>
        保存
      </Button>
    </div>
  )
}

/** The relay refuses internal addresses; an admin may name in-house hosts as an exception. */
function InternalHostsCard({ hosts, busy, onSave }: { hosts: string[]; busy: boolean; onSave: (hosts: string[]) => void }) {
  const [text, setText] = useState(hosts.join('\n'))
  const bad = invalidHosts(text)
  const changed = hostsOf(text).join('\n') !== hosts.join('\n')
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <ShieldWarning size={16} />
          社内の宛先（例外）
        </CardTitle>
        <CardDescription>
          AI 経由の送信は、社内・家庭内のアドレス（127.0.0.1、10.x、192.168.x、169.254.x など）を指す宛先には送りません。社内のシステムに送る必要があるときだけ、そのホスト名をここに書いてください。変更は履歴に残ります。
        </CardDescription>
      </CardHeader>
      <div className="space-y-2 border-t px-5 py-3">
        <Textarea aria-label="社内の宛先として許可するホスト" className="min-h-16 font-mono" placeholder="例: crm.example.co.jp" value={text} onChange={(e) => setText(e.target.value)} />
        {bad.length > 0 && <p role="alert" className="text-sm text-destructive">使えない書き方があります: {bad.join('、')}（ホスト名だけを書きます。IP アドレスは書けません）</p>}
        <Button size="sm" variant="outline" disabled={busy || bad.length > 0 || !changed} onClick={() => onSave(hostsOf(text))}>
          保存
        </Button>
      </div>
    </Card>
  )
}

function HistoryCard({ view, names }: { view: BrokerView; names: Names }) {
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <ClockCounterClockwise size={16} />
          変更の記録
        </CardTitle>
      </CardHeader>
      <div className="border-t px-5 py-2">
        {view.history.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">まだ変更はありません。</p>
        ) : (
          <ul className="divide-y text-sm">
            {view.history.map((h) => (
              <li key={h.id} className="py-2">
                <p className="text-muted-foreground">
                  {formatDateTime(h.changedAt)}・{h.name || h.email || '名前未設定'}
                </p>
                <ul>
                  {brokerChangeLines(h.change, names).map((l) => (
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
