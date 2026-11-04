'use client'

// 「本人の許可で中継する」 on the 「API キー」 page (google-connector.md "The relay"): Google is relayed
// with each member's own Google permission, never a key. The admin chooses which Google services may
// be relayed (only スプレッドシート today), the per-person daily cap and the stop (everyone or one
// member), and sees who allowed it and what was relayed (never a cell's content).
import Link from 'next/link'
import { useState } from 'react'
import { toast } from 'sonner'
import { ClockCounterClockwise, GoogleLogo, Pause, Play, ShieldCheck, UserCircle } from '@phosphor-icons/react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { googleApi, type GoogleRelayAdminView, type GoogleRelaySave } from '@/lib/api'
import { describeError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { useQuery } from '@/lib/use-query'
import { GOOGLE_RELAY_CAP, GOOGLE_RELAY_LATER, googleRelayRecordWords, type GoogleRelayLaterService, type GoogleRelayService } from '../../../../shared/core/google-relay'

export const GOOGLE_RELAY_SERVICE_TEXT: Record<GoogleRelayService, { label: string; detail: string }> = {
  sheets: {
    label: 'スプレッドシート（読む・書く。消すは通さない）',
    detail: '本人が編集できる表に、行の追加・書き換えができます。表やシート、行や列を消す操作は中継しません。',
  },
}

export const GOOGLE_RELAY_LATER_TEXT: Record<GoogleRelayLaterService, string> = {
  drive: 'ドライブ（読むだけ）',
  calendar: 'カレンダー（読むだけ）',
  docs: 'ドキュメント（読むだけ）',
  slides: 'スライド（読むだけ）',
}

const UNAVAILABLE_TEXT: Record<NonNullable<GoogleRelayAdminView['reason']>, string> = {
  'not-configured': 'Google がまだつながっていません。先に「つなぎ先 → Google」で会社の Google を登録してください。',
  off: 'Google をオフにしています（「つなぎ先 → Google」）。オンにするまで中継しません。',
  'vault-off': 'サーバーの準備（鍵の金庫）ができていないため、中継できません。運用担当者に確かめてください。',
  'operator-stopped': '運用担当者が Google を止めています。',
}

export function GoogleRelayCard({ companyId }: { companyId: string }) {
  const relay = useQuery(`google-relay:${companyId}`, () => googleApi.relay(companyId))
  const [busy, setBusy] = useState(false)
  const [cap, setCap] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [who, setWho] = useState<string>('all')
  const data = relay.data

  const save = async (label: string, fn: () => Promise<GoogleRelayAdminView>) => {
    setBusy(true)
    try {
      const next = await fn()
      relay.setData(() => next)
      toast.success(label)
      return true
    } catch (err) {
      toast.error('保存できませんでした', { description: describeError(err) })
      return false
    } finally {
      setBusy(false)
    }
  }
  const saveRelay = (label: string, body: GoogleRelaySave) => save(label, () => googleApi.saveRelay(companyId, body))

  if (!data) {
    return null
  }
  const capDraft = cap ?? String(data.capPerMemberPerDay)
  const capValue = Number(capDraft)
  const capValid = Number.isInteger(capValue) && capValue >= GOOGLE_RELAY_CAP.min && capValue <= GOOGLE_RELAY_CAP.max
  const records = who === 'all' ? data.records : data.records.filter((r) => r.userId === who)
  const nameOf = (userId: string) => data.members.find((m) => m.userId === userId)?.memberName ?? data.records.find((r) => r.userId === userId)?.memberName ?? '（メンバー）'

  return (
    <Card data-testid="google-relay">
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <UserCircle size={16} />
          本人の許可で中継する
        </CardTitle>
        <CardDescription>会社の鍵を使わず、メンバー本人がアプリで許可したときだけ、その人の権限で届けます。</CardDescription>
      </CardHeader>
      <div className="space-y-5 px-6 pb-6">
        <div className="flex flex-wrap items-center gap-2">
          <GoogleLogo size={18} weight="bold" />
          <span className="font-medium">Google（本人の Google の許可で中継）</span>
          {data.stopped ? <Badge variant="warning">止めています</Badge> : data.services.some((s) => s.on) ? <Badge variant="success">使用中</Badge> : <Badge variant="secondary">オフ</Badge>}
        </div>
        {!data.available && data.reason && (
          <p role="status" className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm">
            {UNAVAILABLE_TEXT[data.reason]}{' '}
            <Link href={`/companies/${companyId}/integrations`} className="font-medium text-brand underline-offset-4 hover:underline">つなぎ先へ</Link>
          </p>
        )}
        <p className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2.5 text-sm">
          <ShieldCheck size={16} className="mt-0.5 shrink-0" />
          <span>
            鍵は預かりません。メンバーが自分で許可したときだけ、本人の権限で届けます。
            <span className="block text-xs text-muted-foreground">表ごとの指定はいりません。本人が編集できる表なら届き、本人に権限のない表は Google が断ります。PC にもスクリプトにも Google の鍵は置きません。</span>
          </span>
        </p>

        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">中継してよい Google のサービス</legend>
          <ul className="divide-y rounded-lg border">
            {data.services.map((s) => (
              <li key={s.service}>
                <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5">
                  <input type="checkbox" className="mt-1 h-4 w-4" checked={s.on} disabled={busy || !data.available}
                    onChange={() => void saveRelay(s.on ? 'スプレッドシートの中継をオフにしました' : 'スプレッドシートの中継をオンにしました', { services: { [s.service]: !s.on } })} />
                  <span className="min-w-0">
                    <span className="text-sm">{GOOGLE_RELAY_SERVICE_TEXT[s.service].label}</span>
                    <span className="block text-xs text-muted-foreground">{GOOGLE_RELAY_SERVICE_TEXT[s.service].detail}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
            あとから足せるもの（いまは中継しません）: {GOOGLE_RELAY_LATER.map((l) => GOOGLE_RELAY_LATER_TEXT[l]).join('、')}
          </p>
          <p className="text-xs text-muted-foreground">サービスを足したときは、使う人がアプリの「設定 → Google」でもう一度だけ許可します。</p>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="google-relay-cap">1人あたりの上限</Label>
            <div className="flex items-center gap-2 text-sm">
              <Input id="google-relay-cap" type="number" min={GOOGLE_RELAY_CAP.min} max={GOOGLE_RELAY_CAP.max} className="h-9 w-28 text-right"
                value={capDraft} onChange={(e) => setCap(e.target.value)} />
              回／人／日
              <Button size="sm" variant="outline" disabled={busy || !capValid || capValue === data.capPerMemberPerDay}
                onClick={async () => { if (await saveRelay('上限を保存しました', { capPerMemberPerDay: capValue })) setCap(null) }}>保存</Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {capValid ? '超えた日は、その人の中継をその日だけ止めます。' : `${GOOGLE_RELAY_CAP.min}〜${GOOGLE_RELAY_CAP.max} 回で指定してください。`}
            </p>
          </div>
          <div>
            <p className="text-sm font-medium">使える人</p>
            <p className="mt-1 text-sm">全員（自分で許可した人だけ）</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t pt-3">
          {data.stopped ? (
            <>
              <span className="text-sm">止めています（全員の Google 中継が止まっています）</span>
              <Button size="sm" disabled={busy} onClick={() => void saveRelay('中継を再開しました', { stopped: false })}><Play size={12} />再開する</Button>
            </>
          ) : confirm === '*' ? (
            <>
              <span className="text-sm">全員の Google の中継を今すぐ止めますか？（本人の許可は残ります）</span>
              <Button size="sm" variant="destructive" disabled={busy} onClick={async () => { await saveRelay('中継を止めました', { stopped: true }); setConfirm(null) }}>止める</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>やめる</Button>
            </>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm('*')}><Pause size={12} />全員の中継を止める</Button>
          )}
        </div>

        <section className="space-y-2">
          <h3 className="text-sm font-medium">許可しているメンバー</h3>
          {data.members.length === 0 ? (
            <p className="text-sm text-muted-foreground">まだ誰も許可していません。</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {data.members.map((m) => (
                <li key={m.userId} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-3 py-2.5 text-sm" data-testid={`google-relay-member-${m.userId}`}>
                  <div className="min-w-56">
                    <p className="flex items-center gap-2 font-medium">
                      {m.memberName || m.memberEmail || '（メンバー）'}
                      {m.stopped ? <Badge variant="warning">止めています</Badge> : m.allowed ? <Badge variant="success">許可済み</Badge> : <Badge variant="secondary">本人がやめています</Badge>}
                    </p>
                    {m.allowedAt && <p className="text-xs text-muted-foreground">{formatDateTime(m.allowedAt)} に許可</p>}
                  </div>
                  <p>今日 <span className="font-semibold">{m.usedToday}</span><span className="text-muted-foreground"> ／ {data.capPerMemberPerDay}回</span></p>
                  <div className="ml-auto flex items-center gap-2">
                    {confirm === m.userId ? (
                      <>
                        <span className="text-xs">この人の Google 中継を今すぐ止めますか？（本人の許可は残ります）</span>
                        <Button size="sm" variant="destructive" disabled={busy}
                          onClick={async () => { await save('この人の中継を止めました', () => googleApi.setRelayMemberStopped(companyId, m.userId, true)); setConfirm(null) }}>止める</Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>やめる</Button>
                      </>
                    ) : m.stopped ? (
                      <Button size="sm" disabled={busy} onClick={() => void save('この人の中継を再開しました', () => googleApi.setRelayMemberStopped(companyId, m.userId, false))}>
                        <Play size={12} />この人の中継を再開する
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(m.userId)}><Pause size={12} />この人の中継を止める</Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-medium"><ClockCounterClockwise size={14} />中継の記録（新しい順、最大100件）</h3>
          <p className="text-xs text-muted-foreground">だれが・いつ・どの表に・何をしたかだけを残します（表の中身・鍵・通行証は残しません）。すべての記録は「AI の操作の記録」にもあります。</p>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">だれ:</span>
            {['all', ...new Set(data.records.map((r) => r.userId))].map((w) => (
              <Button key={w} size="sm" variant={who === w ? 'default' : 'outline'} onClick={() => setWho(w)}>{w === 'all' ? '全員' : nameOf(w)}</Button>
            ))}
          </div>
          {records.length === 0 ? (
            <p className="text-sm text-muted-foreground">まだ記録はありません。</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted text-xs text-muted-foreground">
                  <tr><th className="px-3 py-2 font-medium">日時</th><th className="px-3 py-2 font-medium">だれ</th><th className="px-3 py-2 font-medium">したこと</th><th className="px-3 py-2 font-medium">結果</th></tr>
                </thead>
                <tbody className="divide-y">
                  {records.map((r) => {
                    const w = googleRelayRecordWords(r)
                    return (
                      <tr key={r.id} className="align-top">
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">{formatDateTime(r.at)}</td>
                        <td className="whitespace-nowrap px-3 py-2">{r.memberName ?? nameOf(r.userId)}</td>
                        <td className="px-3 py-2"><span className="font-medium">{w.action}</span>
                          {(r.range || r.spreadsheetId) && <span className="block break-all text-xs text-muted-foreground">{[r.range, r.spreadsheetId ? `表 ${r.spreadsheetId}` : null].filter(Boolean).join(' ・ ')}</span>}
                        </td>
                        <td className="px-3 py-2 text-xs">{w.result}{w.note && <span className="block text-muted-foreground">{w.note}</span>}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </Card>
  )
}
