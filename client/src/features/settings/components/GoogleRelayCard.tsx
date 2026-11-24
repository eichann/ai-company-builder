// 設定 → Google → 「スプレッドシートを中継で使う」 / 「ドキュメントを中継で使う」 (google-connector.md "The
// relay"): each shown only when the company offers it. ［許可する］ asks Google once (the browser);
// ［やめる］ turns that one off without leaving Google's permission; the member's own relay records
// below (never a cell's or a Doc's content).
import { useState } from 'react'
import { CheckCircle, FileText, Table } from '@phosphor-icons/react'
import { Button, Callout, Card } from '../../../shared/ui/primitives'
import { googleRelayCardView, googleRelayRecordWords, type GoogleFeature, type GoogleRelayService } from '../../../../shared/google'
import { useGoogleRelay } from '../hooks/useGoogleRelay'

/** What each relay service's card says; `feature` is what ［許可する］ asks Google for. */
const SERVICES: Array<{ service: GoogleRelayService; feature: GoogleFeature; title: string; points: string[]; consent: string; stop: string }> = [
  {
    service: 'sheets',
    feature: 'sheets',
    title: 'スプレッドシートを中継で使う',
    points: [
      'あなたが編集できる表に、AI のスクリプト（例: anken-sync）が読み書きできるようになります。表ごとの指定はいりません。',
      '表やシートを消すことはできません（会社のサーバーが通しません）。',
      'いつ・どの表に・何をしたかの記録が残ります（あなたと管理者が見られます。表の中身は残しません）。',
      'この PC にもスクリプトにも Google の鍵は置きません。',
    ],
    consent: 'Google の画面が開きます。会社の Google アカウントで「スプレッドシートの表示、編集」と、書き込む表が会社のものか確かめるための「Google ドライブのファイルの情報の表示」に同意してください。',
    stop: 'スプレッドシートの中継をやめますか？ AI のスクリプトは表に届かなくなります（ほかの Google の許可はそのままです）。',
  },
  {
    service: 'docs',
    feature: 'documents',
    title: 'ドキュメントを中継で使う',
    points: [
      'あなたが編集できるドキュメントに、AI のスクリプト（例: 週次レポート）が読んで書き足せるようになります。ドキュメントごとの指定はいりません。',
      '文字や表を消す・置き換えることはできません（会社のサーバーが通しません）。書き足すことと、見出し・太字・箇条書きなどの見た目を整えることだけです。',
      'いつ・どのドキュメントに・何をしたかの記録が残ります（あなたと管理者が見られます。中身は残しません）。',
      'この PC にもスクリプトにも Google の鍵は置きません。',
    ],
    consent: 'Google の画面が開きます。会社の Google アカウントで「Google ドキュメントの表示、編集」と、書き込むドキュメントが会社のものか確かめるための「Google ドライブのファイルの情報の表示」に同意してください。',
    stop: 'ドキュメントの中継をやめますか？ AI のスクリプトはドキュメントに届かなくなります（ほかの Google の許可はそのままです）。',
  },
]

function when(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function GoogleRelayCard({ companyId, account, busy: parentBusy, waiting, connect }: {
  companyId: string
  account: string | null
  busy: boolean
  waiting: boolean
  connect: (features: GoogleFeature[]) => Promise<void>
}) {
  const { loadRef, data, error, busy, setOn } = useGoogleRelay(companyId)
  const [confirming, setConfirming] = useState<GoogleRelayService | null>(null)
  const disabled = busy || parentBusy || waiting
  const shown = data ? SERVICES.map(s => ({ ...s, view: googleRelayCardView(data, s.service) })).filter(s => s.view) : []
  const usage = shown[0]?.view?.usage ?? null

  return (
    <div ref={loadRef} data-testid="google-relay">
      {error && <Callout tone="danger" role="alert">{error}</Callout>}
      {data && shown.length > 0 && (
        <div className="space-y-3">
          {shown.map(({ service, feature, title, points, consent, stop, view }) => view && (
            <Card key={service} className="space-y-3 p-5" data-testid={`google-relay-${service}`}>
              <div className="flex flex-wrap items-center gap-2">
                {service === 'docs' ? <FileText size={18} className="text-info-icon" /> : <Table size={18} className="text-success-icon" />}
                <p className="text-[14px] font-medium">{title}</p>
                <span className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-caption font-normal text-zinc-600 ring-1 ring-inset ring-zinc-200 dark:bg-white/[0.06] dark:text-zinc-300">会社が許可しています</span>
              </div>
              <ul className="space-y-1 text-body text-zinc-600 dark:text-zinc-300">
                {points.map(p => <li key={p} className="flex gap-2"><CheckCircle size={15} className="mt-0.5 shrink-0 text-zinc-400" />{p}</li>)}
              </ul>
              {view.state === 'allowed' ? (
                <div className="flex flex-wrap items-center gap-3 rounded-control bg-emerald-50 px-3 py-2.5 text-body text-emerald-900 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-200">
                  <CheckCircle size={16} weight="fill" className="text-emerald-600" />
                  <span>許可済み{account ? `（${account}）` : ''}</span>
                  <span className="opacity-80">{view.usage}</span>
                  {confirming !== service && <Button size="sm" variant="ghost" className="ml-auto" disabled={disabled} onClick={() => setConfirming(service)}>やめる</Button>}
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <Button size="sm" variant="primary" disabled={disabled}
                    onClick={() => void (view.state === 'resume' ? setOn(true, service) : connect([feature]))}>許可する</Button>
                  <span className="text-small text-zinc-500">
                    {view.state === 'resume' ? '前に許可したままなので、Google の画面は開きません。' : consent}
                  </span>
                </div>
              )}
              {confirming === service && (
                <div className="flex flex-wrap items-center gap-2 rounded-control bg-zinc-50 p-3 text-body dark:bg-white/[0.04]">
                  <span>{stop}</span>
                  <Button size="sm" variant="primary" disabled={disabled} onClick={async () => { await setOn(false, service); setConfirming(null) }}>やめる</Button>
                  <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setConfirming(null)}>やめない</Button>
                </div>
              )}
              {view.notice && <Callout tone="warning">{view.notice}</Callout>}
            </Card>
          ))}
          {data.records.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <h3 className="text-body font-medium">中継の記録（あなたの分）</h3>
                {usage && <span className="text-small text-zinc-500">{usage}</span>}
              </div>
              <Card className="overflow-hidden">
                <table className="w-full text-left text-body">
                  <thead className="bg-zinc-50 text-xs text-zinc-500 dark:bg-white/[0.04]">
                    <tr><th className="px-3 py-2 font-medium">日時</th><th className="px-3 py-2 font-medium">したこと</th><th className="px-3 py-2 font-medium">結果</th></tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-white/[0.06]">
                    {data.records.map(r => {
                      const w = googleRelayRecordWords(r)
                      const where = [r.range, r.spreadsheetId ? `表 ${r.spreadsheetId}` : null, r.documentId ? `ドキュメント ${r.documentId}` : null].filter(Boolean)
                      return (
                        <tr key={r.id} className="align-top">
                          <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-500">{when(r.at)}</td>
                          <td className="px-3 py-2"><span className="font-medium">{w.action}</span>
                            {where.length > 0 && <span className="block break-all text-xs text-zinc-500">{where.join(' ・ ')}</span>}
                          </td>
                          <td className="px-3 py-2 text-xs">{w.result}{w.note && <span className="block text-zinc-500">{w.note}</span>}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </Card>
              <p className="text-small text-zinc-500">同じ記録を管理者も見られます。</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
