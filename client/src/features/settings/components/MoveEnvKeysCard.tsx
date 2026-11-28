// On 「API キー・環境変数（この PC）」 (詳しい設定): says these are for older
// app versions and special cases, and offers to move a built-in service's key from
// this computer's .env to the server as one's own key. Only the last 4 are shown.
import { Button, Callout, Card, SubHeading } from '../../../shared/ui/primitives'
import { useEnvKeyMove } from '../hooks/useEnvKeyMove'
import { envKeysToMove } from '../own-keys'

export function LegacyKeysNote({ onOpenOwnKeys }: { onOpenOwnKeys: () => void }) {
  return (
    <Callout
      tone="info"
      title="古い版のアプリや、特別な場合のための画面です"
      action={<Button size="sm" onClick={onOpenOwnKeys}>「Claude・Gemini などの鍵」を開く</Button>}
    >
      鍵の置き場所のおすすめは「Claude・Gemini などの鍵」です。鍵は会社のサーバーで暗号化して預かり、この PC にも AI にも渡しません。ここ（この PC の .env）に置いた鍵は、AI や、AI が動かすスクリプトから読めてしまいます。
    </Callout>
  )
}

export function MoveEnvKeysCard({ companyId, rootPath, env, onMoved }: {
  companyId: string
  rootPath: string
  env: Record<string, { set: boolean; last4?: string }>
  /** Called after a move, to read the .env's state again. */
  onMoved: () => void
}) {
  const { data, busy, messages, move } = useEnvKeyMove(companyId, rootPath, onMoved)
  const rows = envKeysToMove(env, data)
  const done = Object.keys(messages).filter(name => !rows.some(r => r.name === name))
  if (rows.length === 0 && done.length === 0) return null
  return (
    <Card className="space-y-3 p-5">
      <SubHeading>この PC にある鍵を、サーバーに移せます</SubHeading>
      <p className="text-small leading-relaxed text-zinc-500 dark:text-zinc-400">
        移すと「自分の鍵」として会社のサーバーに預け、この PC の .env からは消します（サーバーが受け取ったのを確かめてから消します）。
        移したあと、このアプリから動かすスクリプトには、鍵の代わりに短い時間だけ使える通行証が渡され、これまでどおり動きます。
        アプリの外（ターミナルなど）で .env を読むスクリプトは、この鍵を使えなくなります。
      </p>
      <ul className="space-y-3">
        {rows.map(r => (
          <li key={r.name} className="space-y-1" aria-label={`${r.label}（${r.name}）`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-body font-medium">{r.label}</span>
              <code className="rounded-small bg-zinc-100 px-1 py-px font-mono text-small text-zinc-700 dark:bg-white/10 dark:text-zinc-200">{r.name}</code>
              {r.last4 && <span className="font-mono text-small text-zinc-500">末尾 {r.last4}</span>}
              {r.canMove && (
                <Button size="sm" variant="primary" className="ml-auto" disabled={busy !== null} onClick={() => void move(r.name)}>
                  {busy === r.name ? '移しています…' : 'この鍵をサーバーに移す'}
                </Button>
              )}
            </div>
            {r.note && <p className="text-small text-zinc-500 dark:text-zinc-400">{r.note}</p>}
            {messages[r.name] && (
              <p role={messages[r.name].failed ? 'alert' : 'status'} className={`text-small ${messages[r.name].failed ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-300'}`}>
                {messages[r.name].text}
              </p>
            )}
          </li>
        ))}
        {done.map(name => (
          <li key={name}>
            <p role="status" className="text-small text-emerald-700 dark:text-emerald-300">{name}: {messages[name].text}</p>
          </li>
        ))}
      </ul>
    </Card>
  )
}
