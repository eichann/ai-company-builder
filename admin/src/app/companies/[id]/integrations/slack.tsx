'use client'

// 「つなぎ先」→「Slack」 (stage 3 A3, `.claude/rules/slack-connector.md`): the
// company's own Slack app (its workspace, client ID, client secret, signing
// secret and the bot's token), on / off, the two addresses to register in the
// Slack app, and members' permissions with 「止める」. Secrets and the bot token
// are password fields sent once and never shown again. The guide says to keep
// token rotation off (the server refuses a member's permission otherwise).
// Words for non-engineers: 「Slack で許可」, 「読むもの・送るもの」 — no OAuth,
// scope or token on screen (the bot's token is named 「ボットの鍵」).
import { useState } from 'react'
import { toast } from 'sonner'
import { Copy, SlackLogo } from '@phosphor-icons/react'

import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { ErrorState, ListSkeleton } from '@/components/app/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError, slackApi, type SlackAdminView, type SlackFeature, type SlackGrantSummary } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { describeError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { useQuery } from '@/lib/use-query'

/** What each permission lets ACB do, in the members' words. */
export const SLACK_FEATURE_TEXT: Record<SlackFeature, string> = {
  read: '自分あての DM とメンションを受け取る',
  reply: '返事を送る',
  notices: '大事な知らせを DM で受け取る',
}

const GRANT_STATUS_TEXT: Record<SlackGrantSummary['status'], string> = {
  active: '使えます',
  stopped: '止めました',
  revoked: '取り消されました',
}

/** The server's refusals are plain Japanese sentences for this page; anything else gets the usual restatement. */
function explain(err: unknown): string {
  if (err instanceof ApiError && err.status === 400 && /[ぁ-んァ-ヶ一-龠]/.test(err.message)) return err.message
  if (err instanceof ApiError && err.code === 'BROKER_OFF') return err.message
  return describeError(err)
}

export function SlackSection({ companyId, nameOf }: { companyId: string; nameOf: (userId: string) => string }) {
  const slack = useQuery(`slack:${companyId}`, () => slackApi.get(companyId))
  const [view, setView] = useState<SlackAdminView | null>(null)
  const data = view ?? slack.data

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SlackLogo size={16} />
          Slack
          {data && <SlackBadge view={data} />}
        </CardTitle>
        <CardDescription>
          メンバーが「Slack で許可」をすると、その人あての DM とメンションが届いたことを ACB が受け取り、本人が確かめた返事を
          その人として送れます（メッセージの中身は ACB に残しません）。「あなたの番」になったことは、会社の Slack のボットが
          本人に DM で知らせます（件名だけ）。何を許可するかはメンバーごとに本人が決め、本人がいつでもオフにできます。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {slack.loading && !data ? (
          <ListSkeleton rows={2} />
        ) : slack.error && !data ? (
          <ErrorState error={slack.error} onRetry={slack.reload} />
        ) : data ? (
          <SlackBody companyId={companyId} view={data} onView={setView} nameOf={nameOf} />
        ) : null}
      </CardContent>
    </Card>
  )
}

function SlackBadge({ view }: { view: SlackAdminView }) {
  if (!view.configured) return <Badge variant="outline">まだつないでいません</Badge>
  if (view.operatorStopped) return <Badge variant="outline">止まっています</Badge>
  return view.enabled ? <Badge>動いています</Badge> : <Badge variant="outline">オフ</Badge>
}

function CopyLine({ value, label, testId }: { value: string; label: string; testId: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="break-all rounded bg-muted px-2 py-1 text-xs" data-testid={testId}>{value}</code>
      <Button variant="outline" size="sm" aria-label={`${label}をコピー`}
        onClick={async () => { if (await copyText(value)) toast.success('コピーしました') }}>
        <Copy size={14} /> コピー
      </Button>
    </div>
  )
}

function SlackBody({ companyId, view, onView, nameOf }: {
  companyId: string; view: SlackAdminView; onView: (v: SlackAdminView) => void; nameOf: (userId: string) => string
}) {
  const [teamId, setTeamId] = useState(view.teamId ?? '')
  const [clientId, setClientId] = useState(view.clientId ?? '')
  const [clientSecret, setClientSecret] = useState('')
  const [signingSecret, setSigningSecret] = useState('')
  const [botToken, setBotToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState<SlackGrantSummary | null>(null)

  async function save() {
    setBusy(true)
    try {
      const next = await slackApi.saveApp(companyId, {
        teamId: teamId.trim(), clientId: clientId.trim(),
        ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
        ...(signingSecret.trim() ? { signingSecret: signingSecret.trim() } : {}),
        ...(botToken.trim() ? { botToken: botToken.trim() } : {}),
      })
      setClientSecret('')
      setSigningSecret('')
      setBotToken('')
      onView(next)
      toast.success('保存しました。シークレットとボットの鍵は二度と表示されません。')
    } catch (err) {
      toast.error(explain(err))
    } finally {
      setBusy(false)
    }
  }

  async function toggle() {
    setBusy(true)
    try {
      onView(await slackApi.setEnabled(companyId, !view.enabled))
    } catch (err) {
      toast.error(explain(err))
    } finally {
      setBusy(false)
    }
  }

  async function stop(grant: SlackGrantSummary) {
    try {
      onView(await slackApi.stopGrant(companyId, grant.userId))
      toast.success('止めました。この人が使うには、もう一度「Slack で許可」が必要です。')
    } catch (err) {
      toast.error(explain(err))
    }
  }

  const firstTime = !view.configured
  return (
    <>
      {view.practice && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          練習用の Slack につながっています。本物のシークレットやボットの鍵は登録できません（練習用の値だけ）。
        </p>
      )}
      {view.operatorStopped && (
        <p className="rounded-md border px-3 py-2 text-sm">運用担当者が Slack を止めています。止めている間は、誰も使えません。</p>
      )}
      {!view.vaultEnabled && (
        <p className="rounded-md border px-3 py-2 text-sm">サーバーに鍵の金庫が用意されていないため、登録できません。運用担当者に確かめてください。</p>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Slack のアプリに登録するもの</h3>
        <p className="text-xs text-muted-foreground">会社の Slack のワークスペースで、社内だけで使うアプリを作り、次の2つをそのまま足してください。</p>
        <div className="space-y-1">
          <p className="text-xs">戻り先（Slack のアプリ設定の「Redirect URLs」）</p>
          <CopyLine value={view.redirectUri} label="戻り先" testId="slack-redirect-uri" />
        </div>
        <div className="space-y-1">
          <p className="text-xs">知らせの届け先（「Event Subscriptions」の Request URL。あとから変えられません）</p>
          <CopyLine value={view.eventsUrl} label="知らせの届け先" testId="slack-events-url" />
        </div>
        <p className="text-xs text-muted-foreground" data-testid="slack-rotation-note">
          アプリの「Token Rotation」は<strong>オフのまま</strong>にしてください。オンにすると、メンバーの「Slack で許可」を受け付けません。
        </p>
      </section>

      <section className="grid max-w-xl gap-3">
        <div className="grid gap-1">
          <Label htmlFor="slack-team-id">ワークスペースの ID</Label>
          <Input id="slack-team-id" value={teamId} onChange={(e) => setTeamId(e.target.value)} placeholder="T0123ABCD" autoComplete="off" spellCheck={false} />
          <p className="text-xs text-muted-foreground">このワークスペースのアカウントで、ACB に登録したのと同じメールアドレスのものだけを受け付けます。</p>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="slack-client-id">Slack のクライアント ID</Label>
          <Input id="slack-client-id" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="slack-client-secret">Slack のクライアント シークレット</Label>
          <Input id="slack-client-secret" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="new-password"
            placeholder={view.clientSecretLast4 ? `登録済み（末尾 ${view.clientSecretLast4}）。取り替えるときだけ入れてください` : ''} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="slack-signing-secret">署名のシークレット（Signing Secret）</Label>
          <Input id="slack-signing-secret" type="password" value={signingSecret} onChange={(e) => setSigningSecret(e.target.value)} autoComplete="new-password"
            placeholder={view.configured ? '登録済み。取り替えるときだけ入れてください' : ''} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="slack-bot-token">ボットの鍵（xoxb- で始まる）</Label>
          <Input id="slack-bot-token" type="password" value={botToken} onChange={(e) => setBotToken(e.target.value)} autoComplete="new-password"
            placeholder={view.hasBotToken ? '登録済み。取り替えるときだけ入れてください' : ''} />
          <p className="text-xs text-muted-foreground">保存するとき Slack に確かめます。同じワークスペースのボットでないと保存しません。</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={save}
            disabled={busy || !view.vaultEnabled || !teamId.trim() || !clientId.trim() || (firstTime && (!clientSecret.trim() || !signingSecret.trim()))}>
            Slack の設定を保存
          </Button>
          {view.configured && (
            <Button variant="outline" onClick={toggle} disabled={busy}>{view.enabled ? 'オフにする' : 'オンにする'}</Button>
          )}
        </div>
        {!view.hasBotToken && view.configured && (
          <p className="text-xs text-muted-foreground">ボットの鍵がまだないため、大事な知らせの DM は届きません。</p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">メンバーの許可（受け取るもの・送るもの）</h3>
        {view.grants.length === 0 ? (
          <p className="text-sm text-muted-foreground">まだ誰も「Slack で許可」をしていません。</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {view.grants.map((g) => (
              <li key={g.userId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm" data-testid={`slack-grant-${g.userId}`}>
                <div className="space-y-0.5">
                  <div className="font-medium">{g.memberEmail || nameOf(g.userId)}</div>
                  <div className="text-xs text-muted-foreground">
                    Slack: {g.slackEmail} ・ {g.features.length > 0 ? g.features.map((f) => `${SLACK_FEATURE_TEXT[f]}${g.featuresOff.includes(f) ? '（本人がオフ）' : ''}`).join('・') : '（なし）'}
                    {g.lastUsedAt ? ` ・ 最後に使った日時 ${formatDateTime(g.lastUsedAt)}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={g.status === 'active' ? 'default' : 'outline'}>{GRANT_STATUS_TEXT[g.status]}</Badge>
                  {g.status === 'active' && <Button variant="outline" size="sm" onClick={() => setStopping(g)}>止める</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">「API キー」の「すべての鍵を止める」でも、全員の Slack の許可が止まります。</p>
      </section>

      <ConfirmDialog
        open={stopping !== null}
        onOpenChange={(open) => { if (!open) setStopping(null) }}
        title="この人の Slack の許可を止めますか？"
        description="Slack 側の許可も取り消します。この人が使うには、もう一度「Slack で許可」が必要です。"
        confirmLabel="止める"
        onConfirm={async () => { if (stopping) await stop(stopping); setStopping(null) }}
      />
    </>
  )
}
