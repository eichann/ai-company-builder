'use client'

// 「つなぎ先」: connecting the company to outside systems (HubSpot first;
// connector plugins, milestone 3 P8, `.claude/rules/plugins.md`). Owner/admin
// only. Which version and which company key (named by id; the page shows the
// key's name and last four characters from 「API キー」, never a value), on /
// off, the mapping (読み替え表) as a table or as YAML with versions and
// restore, 「HubSpot に聞いて確かめる」, how each field is written back (auto
// needs the workflow acknowledgement — the server refuses without it),
// importing, and the history. The server decides every rule; the page shows
// what it says.
import { useState } from 'react'
import { toast } from 'sonner'
import { ArrowsClockwise, ClockCounterClockwise, LockSimple, PlugsConnected, Warning } from '@phosphor-icons/react'

import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  ApiError,
  companiesApi,
  keyBrokerApi,
  pluginsApi,
  type BrokerView,
  type ImportReport,
  type PluginDetail,
  type PluginListItem,
  type PluginMappingCheck,
} from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import {
  HISTORY_LABELS,
  IMPORT_STATUS_TEXT,
  PROBLEM_TEXT,
  WRITE_CHOICE_LABELS,
  changeMappingField,
  describeReason,
  integrationRefusal,
  mappingRows,
  type WriteChoice,
} from '@/lib/integrations'
import { useQuery } from '@/lib/use-query'

const TITLE = 'つなぎ先'

/** Japanese sentence for a failed request on this page. */
function explain(err: unknown): string {
  if (err instanceof ApiError) return integrationRefusal(err.code, err.body) ?? describeError(err)
  return describeError(err)
}

export default function IntegrationsPage() {
  const { companyId, role, isAdmin } = useCompany()
  const list = useQuery(isAdmin ? `plugins:${companyId}` : null, () => pluginsApi.list(companyId))
  const broker = useQuery(isAdmin ? `broker:${companyId}` : null, () => keyBrokerApi.get(companyId))
  const members = useQuery(isAdmin ? `members:${companyId}` : null, () => companiesApi.getMembers(companyId))
  const [open, setOpen] = useState<string | null>(null)

  if (role !== null && !isAdmin) {
    return (
      <>
        <PageHeader title={TITLE} />
        <EmptyState icon={LockSimple} title="このページはオーナーと管理者だけが使えます" />
      </>
    )
  }

  const nameOf = (id: string) => {
    const m = members.data?.find((x) => x.userId === id)
    return m?.name || m?.email || (id === 'connector' ? '自動' : '（メンバー）')
  }
  const items = list.data?.plugins ?? []

  return (
    <>
      <PageHeader title={TITLE} />
      <div className="-mt-2 mb-6 max-w-3xl space-y-2 text-sm text-muted-foreground">
        <p>
          会社で使っている外のサービス（HubSpot など）とつなぎます。つなぐと、案件などを会社の記録に取り込み、
          AI が決められた欄だけを書き戻せるようになります。鍵の中身は誰にも表示されません。
        </p>
      </div>
      {list.loading ? (
        <ListSkeleton rows={3} />
      ) : list.error && !list.data ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : items.length === 0 ? (
        <EmptyState icon={PlugsConnected} title="使えるつなぎ先はまだありません" description="運用担当者が用意すると、ここに表示されます。" />
      ) : (
        <div className="space-y-4 pb-4">
          {items.map((item) =>
            open === item.id || items.length === 1 ? (
              <IntegrationDetail key={item.id} item={item} broker={broker.data ?? null} nameOf={nameOf} onChanged={list.reload} />
            ) : (
              <IntegrationSummary key={item.id} item={item} onOpen={() => setOpen(item.id)} />
            )
          )}
        </div>
      )}
    </>
  )
}

function labelOf(item: PluginListItem) {
  const pkg = item.versions.find((v) => v.version === item.install?.version) ?? item.versions[item.versions.length - 1]
  return pkg?.label ?? item.id
}

function StatusBadge({ item }: { item: PluginListItem }) {
  if (!item.install) return <Badge variant="outline">まだ使っていません</Badge>
  if (item.install.problem === null) return <Badge>動いています</Badge>
  return <Badge variant="outline">{item.install.problem === 'off' ? 'オフ' : '止まっています'}</Badge>
}

function IntegrationSummary({ item, onOpen }: { item: PluginListItem; onOpen: () => void }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <PlugsConnected size={16} />
            {labelOf(item)}
            <StatusBadge item={item} />
          </CardTitle>
          {item.install?.problem && <CardDescription>{PROBLEM_TEXT[item.install.problem]}</CardDescription>}
        </div>
        <Button variant="outline" size="sm" onClick={onOpen}>開く</Button>
      </CardHeader>
    </Card>
  )
}

type Change = (acknowledgeAuto: string[]) => Promise<PluginDetail>
type AckRequest = { fields: string[]; acknowledgement: string; label: string; change: Change }

function IntegrationDetail({ item, broker, nameOf, onChanged }: {
  item: PluginListItem
  broker: BrokerView | null
  nameOf: (id: string) => string
  onChanged: () => void
}) {
  const { companyId } = useCompany()
  const detail = useQuery(`plugin:${companyId}:${item.id}`, () => pluginsApi.get(companyId, item.id))
  const [busy, setBusy] = useState(false)
  const [ack, setAck] = useState<AckRequest | null>(null)
  const [confirmOff, setConfirmOff] = useState(false)
  const [confirmRenew, setConfirmRenew] = useState(false)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [accountChanged, setAccountChanged] = useState(false)

  const d = detail.data
  const current = d?.plugin ?? item
  const install = current.install
  const latest = current.versions[current.versions.length - 1]
  const pkg = current.versions.find((v) => v.version === install?.version) ?? latest
  const service = broker?.services.find((s) => s.service === pkg?.service)
  const keys = broker?.keys.filter((k) => k.scope === 'company' && k.service === pkg?.service) ?? []
  const [version, setVersion] = useState<string>(install?.version ?? latest?.version ?? '')
  const [keyId, setKeyId] = useState<string>(install?.keyId ?? '')

  /** Run a change whose answer is the whole detail. Resolves whether it was saved. */
  const run = async (label: string, fn: Change, acknowledgeAuto: string[] = []): Promise<boolean> => {
    setBusy(true)
    try {
      const next = await fn(acknowledgeAuto)
      detail.setData(() => next)
      onChanged()
      toast.success(label)
      return true
    } catch (err) {
      if (err instanceof ApiError && err.code === 'AUTO_NEEDS_ACKNOWLEDGEMENT' && Array.isArray(err.body?.fields)) {
        setAck({ fields: err.body.fields as string[], acknowledgement: String(err.body.acknowledgement ?? ''), label, change: fn })
        return false
      }
      if (err instanceof ApiError && err.code === 'MAPPING_INVALID' && Array.isArray(err.body?.errors)) {
        toast.error('読み替え表を保存できませんでした', { description: (err.body.errors as string[]).join('\n') })
        return false
      }
      toast.error('保存できませんでした', { description: explain(err) })
      return false
    } finally {
      setBusy(false)
    }
  }

  const runImport = async () => {
    setBusy(true)
    setAccountChanged(false)
    try {
      const r = await pluginsApi.import(companyId, item.id)
      setReport(r)
      toast.success(IMPORT_STATUS_TEXT[r.status])
      detail.reload()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ACCOUNT_CHANGED') setAccountChanged(true)
      toast.error('取り込めませんでした', { description: explain(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <PlugsConnected size={16} />
          {labelOf(current)}
          <StatusBadge item={current} />
        </CardTitle>
        <CardDescription>
          送り先：{pkg?.host ?? '—'}
          {install?.accountId ? `　つないでいるアカウント：${install.accountId}` : ''}
        </CardDescription>
      </CardHeader>
      <div className="space-y-6 border-t px-5 py-4">
        {service?.practice && (
          <div role="status" className="flex gap-3 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm">
            <Warning size={18} className="mt-0.5 shrink-0 text-warning" />
            <p className="font-medium">
              練習用の {service.label} につながっています（このサーバーは検証用です。本物の {service.label} には届きません）
            </p>
          </div>
        )}
        {pkg?.stopped && (
          <p role="status" className="text-sm text-destructive">運用担当者が全社で止めています。止まっている間は何も送りません。</p>
        )}

        {/* Version and key */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium">使う版と鍵</h3>
          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1 text-sm">
              <span className="block text-muted-foreground">版</span>
              <select aria-label="版" className="h-9 rounded-md border bg-transparent px-2 text-sm" value={version} onChange={(e) => setVersion(e.target.value)}>
                {current.versions.map((v) => <option key={v.version} value={v.version}>{v.version}{v.stopped ? '（止められています）' : ''}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="block text-muted-foreground">鍵（「API キー」で登録した会社の鍵）</span>
              <select aria-label="鍵" className="h-9 min-w-56 rounded-md border bg-transparent px-2 text-sm" value={keyId} onChange={(e) => setKeyId(e.target.value)}>
                <option value="">選んでいません</option>
                {keys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.displayName}（末尾 {k.last4}）{k.status === 'active' ? '' : '・止められています'}
                  </option>
                ))}
              </select>
            </label>
            <Button size="sm" disabled={busy || !version}
              onClick={() => run(install ? '版と鍵を保存しました' : '使い始めました', () => pluginsApi.install(companyId, item.id, version, keyId || null))}>
              {install ? '保存' : '使い始める'}
            </Button>
          </div>
          {keys.length === 0 && pkg && (
            <p className="text-xs text-muted-foreground">この送り先の会社の鍵がまだありません。「API キー」で登録してください（鍵の中身はここには表示されません）。</p>
          )}
        </section>

        {/* On / off */}
        {install && (
          <section className="space-y-2">
            <h3 className="text-sm font-medium">オン・オフ</h3>
            {install.problem && install.problem !== 'off' && (
              <p className="text-sm text-muted-foreground">いまは動いていません：{PROBLEM_TEXT[install.problem]}</p>
            )}
            {install.enabled ? (
              <Button variant="destructive" size="sm" disabled={busy} onClick={() => setConfirmOff(true)}>止める（オフにする）</Button>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => run('オンにしました', () => pluginsApi.setEnabled(companyId, item.id, true))}>オンにする</Button>
            )}
            <p className="text-xs text-muted-foreground">
              オンにすると、この送り先へは決められた書き戻しだけが届くようになります（オフにしても、自由な書き込みには戻りません）。
            </p>
          </section>
        )}

        {install && d && (
          <MappingEditor
            pluginId={item.id}
            detail={d}
            busy={busy}
            nameOf={nameOf}
            onSave={(text) => run('読み替え表を保存しました', (acks) => pluginsApi.saveMapping(companyId, item.id, text, acks))}
            onRestore={(v) => run(`版 ${v} に戻しました`, (acks) => pluginsApi.restoreMapping(companyId, item.id, v, acks))}
          />
        )}

        {/* Import */}
        {install && (
          <section className="space-y-2">
            <h3 className="text-sm font-medium">取り込む</h3>
            <p className="text-xs text-muted-foreground">読み替え表の範囲の案件を、会社の記録に取り込みます（ファイルは作りません）。</p>
            <Button size="sm" variant="outline" disabled={busy || install.problem !== null} onClick={runImport}>
              <ArrowsClockwise size={14} />
              取り込む
            </Button>
            {report && <ImportReportView report={report} />}
            {accountChanged && (
              <div role="alert" className="space-y-2 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm">
                <p>
                  鍵が、これまでとは別のアカウントのものになっています。意図して切り替えたときだけ、新しいつなぎ先として始めてください
                  （これまでに取り込んだ記録とは混ざりません）。
                </p>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmRenew(true)}>新しいつなぎ先として始める</Button>
              </div>
            )}
          </section>
        )}

        {d && d.history.length > 0 && (
          <section className="space-y-2">
            <h3 className="flex items-center gap-2 text-sm font-medium"><ClockCounterClockwise size={14} />履歴</h3>
            <ul className="divide-y text-sm">
              {d.history.map((h, i) => (
                <li key={`${h.at}-${i}`} className="flex flex-wrap gap-x-3 py-1.5">
                  <span className="text-muted-foreground">{formatDateTime(h.at)}</span>
                  <span>{HISTORY_LABELS[h.action] ?? h.action}</span>
                  <span className="text-muted-foreground">{nameOf(h.by)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {detail.error && !d ? <ErrorState error={detail.error} onRetry={detail.reload} /> : null}
      </div>

      <ConfirmDialog
        open={confirmOff}
        onOpenChange={setConfirmOff}
        title="止めますか？"
        description="取り込みと書き戻しが、次の1回から止まります。読み替え表と記録はそのまま残ります。"
        confirmLabel="止める"
        onConfirm={async () => {
          if (await run('止めました', () => pluginsApi.setEnabled(companyId, item.id, false))) setConfirmOff(false)
        }}
      />
      <ConfirmDialog
        open={confirmRenew}
        onOpenChange={setConfirmRenew}
        title="新しいつなぎ先として始めますか？"
        description="これまでのアカウントの記録には、もう書き戻しません。次の取り込みから、いまの鍵のアカウントにつなぎます。"
        confirmLabel="新しく始める"
        onConfirm={async () => {
          try {
            await pluginsApi.renewConnection(companyId, item.id)
            setAccountChanged(false)
            setConfirmRenew(false)
            detail.reload()
            toast.success('新しいつなぎ先として始めました')
          } catch (err) {
            toast.error('できませんでした', { description: explain(err) })
            throw err
          }
        }}
      />
      <AcknowledgeDialog
        request={ack}
        busy={busy}
        onCancel={() => setAck(null)}
        onConfirm={async (fields) => {
          const r = ack
          setAck(null)
          if (r) await run(r.label, r.change, fields)
        }}
      />
    </Card>
  )
}

function ImportReportView({ report }: { report: ImportReport }) {
  return (
    <div className="rounded-xl border px-4 py-3 text-sm" role="status">
      <p className="font-medium">{IMPORT_STATUS_TEXT[report.status]}{report.reason ? `（${describeReason(report.reason)}）` : ''}</p>
      <ul className="mt-1 text-muted-foreground">
        {Object.entries(report.objects).map(([name, o]) => (
          <li key={name}>
            {name}：見た {o.seen} 件／新しく {o.created} 件／更新 {o.updated} 件／変わらず {o.unchanged} 件
            {Object.keys(o.problems).length > 0 && `／読み替えられなかった欄：${Object.keys(o.problems).join('、')}`}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-muted-foreground">ここに出ていない案件が HubSpot にない、という意味ではありません（範囲と件数の上限は読み替え表で決まります）。</p>
    </div>
  )
}

function MappingEditor({ pluginId, detail, busy, nameOf, onSave, onRestore }: {
  pluginId: string
  detail: PluginDetail
  busy: boolean
  nameOf: (id: string) => string
  onSave: (text: string) => Promise<boolean>
  onRestore: (version: number) => Promise<boolean>
}) {
  const { companyId } = useCompany()
  const saved = detail.mapping?.text ?? ''
  const [draft, setDraft] = useState(saved)
  const [base, setBase] = useState(saved)
  const [mode, setMode] = useState<'table' | 'yaml'>('table')
  const [check, setCheck] = useState<PluginMappingCheck | null>(null)
  const [checkErrors, setCheckErrors] = useState<string[]>([])
  const [checking, setChecking] = useState(false)
  // A new version arrived from the server (saved / restored): start from it.
  if (saved !== base) {
    setBase(saved)
    setDraft(saved)
  }
  const table = mappingRows(draft, detail.policies)
  const dirty = draft !== saved

  const askOutside = async () => {
    setChecking(true)
    setCheck(null)
    setCheckErrors([])
    try {
      setCheck(await pluginsApi.checkMapping(companyId, pluginId, draft))
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MAPPING_INVALID' && Array.isArray(err.body?.errors)) setCheckErrors(err.body.errors as string[])
      else toast.error('確かめられませんでした', { description: explain(err) })
    } finally {
      setChecking(false)
    }
  }

  const setField = (object: string, field: string, change: { from?: string; choice?: WriteChoice }) =>
    setDraft((t) => changeMappingField(t, object, field, change))

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          読み替え表{detail.mapping ? `（版 ${detail.mapping.version}）` : ''}
        </h3>
        <div className="flex gap-1">
          <Button size="sm" variant={mode === 'table' ? 'secondary' : 'ghost'} onClick={() => setMode('table')}>表で直す</Button>
          <Button size="sm" variant={mode === 'yaml' ? 'secondary' : 'ghost'} onClick={() => setMode('yaml')}>文字で直す（詳しい人向け）</Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        ACB の欄と HubSpot の項目の対応、取り込む範囲、欄ごとの書き戻し方を決めます。保存すると新しい版になり、前の版に戻せます。
      </p>
      {detail.mappingErrors.length > 0 && (
        <div role="alert" className="rounded-xl border border-destructive/30 px-4 py-2 text-sm">
          <p className="font-medium">いま使っている読み替え表に直すところがあります</p>
          <ul className="list-disc pl-5">{detail.mappingErrors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}

      {mode === 'table' ? (
        table.ok ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-3 font-normal">ACB の欄</th>
                  <th className="py-1 pr-3 font-normal">HubSpot の項目</th>
                  <th className="py-1 font-normal">書き戻し</th>
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r) => (
                  <tr key={`${r.object}.${r.field}`} className="border-t">
                    <td className="py-1.5 pr-3">{r.object}・{r.field}</td>
                    <td className="py-1.5 pr-3">
                      <Input aria-label={`${r.field} の HubSpot の項目`} className="h-8" value={r.from}
                        onChange={(e) => setField(r.object, r.field, { from: e.target.value })} />
                    </td>
                    <td className="py-1.5">
                      {r.locked ? (
                        <span className="text-muted-foreground">書き戻せません（受注・失注につながるため）</span>
                      ) : (
                        <select aria-label={`${r.field} の書き戻し`} className="h-8 rounded-md border bg-transparent px-2 text-sm" value={r.choice}
                          onChange={(e) => setField(r.object, r.field, { choice: e.target.value as WriteChoice })}>
                          {(Object.keys(WRITE_CHOICE_LABELS) as WriteChoice[]).map((c) => <option key={c} value={c}>{WRITE_CHOICE_LABELS[c]}</option>)}
                        </select>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted-foreground">
              「自動で書き戻す」にした欄は、保存するときに「その欄の変更をきっかけに動く HubSpot のワークフローがないか」の確認をお願いします。
              表で保存すると、文字の中のコメント（# の行）は残りません。
            </p>
          </div>
        ) : (
          <p role="alert" className="text-sm text-destructive">表にできません（{table.error}）。「文字で直す」で直してください。</p>
        )
      ) : (
        <Textarea aria-label="読み替え表（文字）" className="min-h-72 font-mono text-xs" value={draft} onChange={(e) => setDraft(e.target.value)} />
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || !dirty} onClick={() => onSave(draft)}>保存（新しい版にする）</Button>
        <Button size="sm" variant="outline" disabled={busy || checking} onClick={askOutside}>
          {checking ? '確かめています…' : 'HubSpot に聞いて確かめる'}
        </Button>
        {dirty && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(saved)}>変更を取り消す</Button>}
      </div>

      {checkErrors.length > 0 && (
        <div role="alert" className="rounded-xl border border-destructive/30 px-4 py-2 text-sm">
          <p className="font-medium">読み替え表の書き方に直すところがあります</p>
          <ul className="list-disc pl-5">{checkErrors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}
      {check && <CheckResult check={check} />}

      {detail.mappingVersions.length > 1 && (
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-muted-foreground">これまでの版</h4>
          <ul className="divide-y text-sm">
            {detail.mappingVersions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center gap-x-3 py-1.5">
                <span>版 {v.version}</span>
                <span className="text-muted-foreground">{formatDateTime(v.createdAt)}・{nameOf(v.createdBy)}</span>
                {v.version === detail.mapping?.version ? (
                  <Badge variant="outline">いま使っている版</Badge>
                ) : (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRestore(v.version)}>この版に戻す</Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

function CheckResult({ check }: { check: PluginMappingCheck }) {
  if (!check.reachable) {
    return (
      <div role="status" className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-2 text-sm">
        HubSpot に聞けませんでした：{describeReason(check.reason)}。保存はできますが、項目名が合っているかは確かめられていません。
      </div>
    )
  }
  const entries = Object.entries(check.objects)
  const errors = entries.flatMap(([, o]) => o.errors)
  const warnings = entries.flatMap(([, o]) => o.warnings)
  return (
    <div role="status" className="space-y-1 rounded-xl border px-4 py-2 text-sm">
      {errors.length === 0 && warnings.length === 0 && <p className="font-medium">HubSpot の項目と合っています。</p>}
      {errors.length > 0 && (
        <>
          <p className="font-medium text-destructive">HubSpot と合わないところがあります</p>
          <ul className="list-disc pl-5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </>
      )}
      {warnings.length > 0 && (
        <>
          <p className="font-medium">気をつけるところ</p>
          <ul className="list-disc pl-5">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </>
      )}
    </div>
  )
}

function AcknowledgeDialog({ request, busy, onCancel, onConfirm }: {
  request: AckRequest | null
  busy: boolean
  onCancel: () => void
  onConfirm: (fields: string[]) => Promise<void>
}) {
  const [checked, setChecked] = useState(false)
  return (
    <Dialog open={request !== null} onOpenChange={(o) => { if (!o) { setChecked(false); onCancel() } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>自動で書き戻す欄の確認</DialogTitle>
          <DialogDescription>
            次の欄は、AI の変更がすぐ HubSpot に書き込まれます。HubSpot 側で、その欄の変更をきっかけにメールや通知などが動く設定（ワークフロー）がないかを確かめてください。
            あとで ACB から前の値を書き戻しても、HubSpot 側で動いたことは元に戻りません。
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc pl-5 text-sm">{request?.fields.map((f) => <li key={f}>{f}</li>)}</ul>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>{request?.acknowledgement || 'この欄の変更をきっかけに動く HubSpot のワークフローがないか確かめました'}</span>
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setChecked(false); onCancel() }}>やめる</Button>
          <Button disabled={!checked || busy} onClick={async () => { const f = request?.fields ?? []; setChecked(false); await onConfirm(f) }}>
            確認して保存する
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
