// 設定 → Google → 「スプレッドシートを中継で使う」 (google-connector.md "The relay"): shown only when
// the company offers it. ［許可する］ asks Google once (the browser); ［やめる］ turns it off without
// leaving Google's permission; the member's own relay records below (never a cell's content).
import { useState } from 'react'
import { CheckCircle, Table } from '@phosphor-icons/react'
import { Button, Callout, Card } from '../../../shared/ui/primitives'
import { googleRelayCardView, googleRelayRecordWords, type GoogleFeature } from '../../../../shared/google'
import { useGoogleRelay } from '../hooks/useGoogleRelay'

const POINTS = [
  'あなたが編集できる表に、AI のスクリプト（例: anken-sync）が読み書きできるようになります。表ごとの指定はいりません。',
  '表やシートを消すことはできません（会社のサーバーが通しません）。',
  'いつ・どの表に・何をしたかの記録が残ります（あなたと管理者が見られます。表の中身は残しません）。',
  'この PC にもスクリプトにも Google の鍵は置きません。',
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
  const [confirming, setConfirming] = useState(false)
  const view = data ? googleRelayCardView(data) : null
  const disabled = busy || parentBusy || waiting

  return (
    <div ref={loadRef} data-testid="google-relay">
      {error && <Callout tone="warning" role="alert">{error}</Callout>}
      {view && data && (
        <div className="space-y-3">
          <Card className="space-y-3 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <Table size={18} className="text-emerald-600" />
              <p className="text-[14px] font-medium">スプレッドシートを中継で使う</p>
              <span className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-600 ring-1 ring-inset ring-zinc-200 dark:bg-white/[0.06] dark:text-zinc-300">会社が許可しています</span>
            </div>
            <ul className="space-y-1 text-[13px] text-zinc-600 dark:text-zinc-300">
              {POINTS.map(p => <li key={p} className="flex gap-2"><CheckCircle size={15} className="mt-0.5 shrink-0 text-zinc-400" />{p}</li>)}
            </ul>
            {view.state === 'allowed' ? (
              <div className="flex flex-wrap items-center gap-3 rounded-lg bg-emerald-50 px-3 py-2.5 text-[13px] text-emerald-900 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-200">
                <CheckCircle size={16} weight="fill" className="text-emerald-600" />
                <span>許可済み{account ? `（${account}）` : ''}</span>
                <span className="opacity-80">{view.usage}</span>
                {!confirming && <Button size="sm" variant="ghost" className="ml-auto" disabled={disabled} onClick={() => setConfirming(true)}>やめる</Button>}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <Button size="sm" variant="primary" disabled={disabled}
                  onClick={() => void (view.state === 'resume' ? setOn(true) : connect(['sheets']))}>許可する</Button>
                <span className="text-[12px] text-zinc-500">
                  {view.state === 'resume' ? '前に許可したままなので、Google の画面は開きません。' : 'Google の画面が開きます。会社の Google アカウントで「スプレッドシートの表示、編集」と、書き込む表が会社のものか確かめるための「Google ドライブのファイルの情報の表示」に同意してください。'}
                </span>
              </div>
            )}
            {confirming && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 p-3 text-[13px] dark:bg-white/[0.04]">
                <span>スプレッドシートの中継をやめますか？ AI のスクリプトは表に届かなくなります（ほかの Google の許可はそのままです）。</span>
                <Button size="sm" variant="primary" disabled={disabled} onClick={async () => { await setOn(false); setConfirming(false) }}>やめる</Button>
                <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setConfirming(false)}>やめない</Button>
              </div>
            )}
            {view.notice && <Callout tone="warning">{view.notice}</Callout>}
          </Card>
          {data.records.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <h3 className="text-[13px] font-medium">中継の記録（あなたの分）</h3>
                <span className="text-[12px] text-zinc-500">{view.usage}</span>
              </div>
              <Card className="overflow-hidden">
                <table className="w-full text-left text-[13px]">
                  <thead className="bg-zinc-50 text-xs text-zinc-500 dark:bg-white/[0.04]">
                    <tr><th className="px-3 py-2 font-medium">日時</th><th className="px-3 py-2 font-medium">したこと</th><th className="px-3 py-2 font-medium">結果</th></tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-white/[0.06]">
                    {data.records.map(r => {
                      const w = googleRelayRecordWords(r)
                      return (
                        <tr key={r.id} className="align-top">
                          <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-500">{when(r.at)}</td>
                          <td className="px-3 py-2"><span className="font-medium">{w.action}</span>
                            {(r.spreadsheetId || r.range) && <span className="block break-all text-xs text-zinc-500">{[r.range, r.spreadsheetId ? `表 ${r.spreadsheetId}` : null].filter(Boolean).join(' ・ ')}</span>}
                          </td>
                          <td className="px-3 py-2 text-xs">{w.result}{w.note && <span className="block text-zinc-500">{w.note}</span>}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </Card>
              <p className="text-[12px] text-zinc-500">同じ記録を管理者も見られます。</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
