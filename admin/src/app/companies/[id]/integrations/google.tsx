'use client'

// 「つなぎ先」→「Google」 (milestone 4 G3, `.claude/rules/google-connector.md`):
// the company's Google app (the client ID and secret from Google Cloud, the
// company's Workspace domain), on / off, the address to register in Google
// Cloud, and members' permissions with 「止める」. The secret is a password
// field sent once and never shown again (last 4 only). Words for
// non-engineers: 「Google で許可」, 「読むもの・送るもの」 — no OAuth, scope or
// token on screen.
import { useState } from 'react'
import { toast } from 'sonner'
import { Copy, GoogleLogo } from '@phosphor-icons/react'

import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { ErrorState, ListSkeleton } from '@/components/app/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError, googleApi, type GoogleAdminView, type GoogleFeature, type GoogleGrantSummary } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { describeError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { GOOGLE_FEATURES } from '../../../../../../shared/core/google'
import { useQuery } from '@/lib/use-query'

import { MinutesFolderSection } from './minutes-folder'

/** What each permission lets ACB do, in the members' words. */
export const GOOGLE_FEATURE_TEXT: Record<GoogleFeature, string> = {
  minutes: '予定と議事録を読む',
  mail: 'メールを送る',
  drive: 'Drive で選んだものを読む・置く',
  inbox: '受信を読む',
}

const GRANT_STATUS_TEXT: Record<GoogleGrantSummary['status'], string> = {
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

export function GoogleSection({ companyId, nameOf }: { companyId: string; nameOf: (userId: string) => string }) {
  const google = useQuery(`google:${companyId}`, () => googleApi.get(companyId))
  const [view, setView] = useState<GoogleAdminView | null>(null)
  const data = view ?? google.data

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GoogleLogo size={16} />
          Google
          {data && <GoogleBadge view={data} />}
        </CardTitle>
        <CardDescription>
          メンバーが「Google で許可」をすると、ACB がその人の予定と Meet の議事録を読めるようになり、
          本人が「確かめて送る」を押したときだけ、その人の Gmail からメールを送れます。本人が「受信を読む」も許可すると、届いたメールを
          ACB がその場で読めるようになります（メールの中身は ACB に残しません）。何を読むか・送るかは、メンバーごとに本人が許可し、本人がいつでもオフにできます。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {google.loading && !data ? (
          <ListSkeleton rows={2} />
        ) : google.error && !data ? (
          <ErrorState error={google.error} onRetry={google.reload} />
        ) : data ? (
          <GoogleBody companyId={companyId} view={data} onView={setView} nameOf={nameOf} />
        ) : null}
      </CardContent>
    </Card>
  )
}

function GoogleBadge({ view }: { view: GoogleAdminView }) {
  if (!view.configured) return <Badge variant="outline">まだつないでいません</Badge>
  if (view.operatorStopped) return <Badge variant="outline">止まっています</Badge>
  return view.enabled ? <Badge>動いています</Badge> : <Badge variant="outline">オフ</Badge>
}

/**
 * Google Drive's file picking (google-drive.md): Google Picker needs an API key
 * and the Cloud project's number. Members then choose, in Google's own screen,
 * which Drive files the AI may read and which folder it may put proposals in —
 * ACB sees nothing else in Drive.
 */
function DrivePickerSection({ companyId, view, onView }: { companyId: string; view: GoogleAdminView; onView: (v: GoogleAdminView) => void }) {
  const [apiKey, setApiKey] = useState('')
  const [appId, setAppId] = useState(view.picker.appId ?? '')
  const [busy, setBusy] = useState(false)

  async function save(remove = false) {
    setBusy(true)
    try {
      const next = await googleApi.savePicker(companyId, remove ? { appId: null } : { appId: appId.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) })
      setApiKey('')
      if (remove) setAppId('')
      onView(next)
      toast.success(remove ? 'Drive のファイル選びを止めました。' : '保存しました。')
    } catch (err) {
      toast.error(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-2" data-testid="google-drive-picker">
      <h3 className="text-sm font-medium">Google Drive のファイル選び</h3>
      <p className="text-xs text-muted-foreground">
        設定すると、メンバーが AI への相談の中で、Google の画面から「読ませるファイル」と「提案書を置くフォルダ」を選べます。
        ACB が使えるのは、メンバーが選んだファイルとフォルダ、ACB が置いたファイルだけです。
      </p>
      <div className="flex items-center gap-2">
        <code className="break-all rounded bg-muted px-2 py-1 text-xs" data-testid="google-picker-page">{view.picker.pageUrl}</code>
        <Button variant="outline" size="sm" aria-label="ファイル選びのページをコピー"
          onClick={async () => { if (await copyText(view.picker.pageUrl)) toast.success('コピーしました') }}>
          <Copy size={14} /> コピー
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Google Cloud で「Google Picker API」と「Google Drive API」を有効にし、API キーを作って「ウェブサイトの制限」にこのページを足してください（使える API も Picker に絞ります）。
      </p>
      <div className="grid max-w-xl gap-3">
        <div className="grid gap-1">
          <Label htmlFor="google-picker-key">API キー</Label>
          <Input id="google-picker-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="new-password"
            placeholder={view.picker.apiKeyLast4 ? `登録済み（末尾 ${view.picker.apiKeyLast4}）。取り替えるときだけ入れてください` : ''} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="google-picker-app">プロジェクト番号</Label>
          <Input id="google-picker-app" value={appId} onChange={(e) => setAppId(e.target.value)} inputMode="numeric" autoComplete="off" spellCheck={false} />
          <p className="text-xs text-muted-foreground">Google Cloud の「プロジェクト情報」に出ている数字です（クライアント ID と同じプロジェクト）。</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => save()} disabled={busy || !appId.trim() || (!view.picker.configured && !apiKey.trim())}>ファイル選びの設定を保存</Button>
          {view.picker.configured && <Button variant="outline" onClick={() => save(true)} disabled={busy}>ファイル選びを止める</Button>}
        </div>
      </div>
    </section>
  )
}

function GoogleBody({ companyId, view, onView, nameOf }: {
  companyId: string; view: GoogleAdminView; onView: (v: GoogleAdminView) => void; nameOf: (userId: string) => string
}) {
  const [clientId, setClientId] = useState(view.clientId ?? '')
  const [secret, setSecret] = useState('')
  const [domain, setDomain] = useState(view.domain ?? '')
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState<GoogleGrantSummary | null>(null)

  async function save() {
    setBusy(true)
    try {
      const next = await googleApi.saveClient(companyId, { clientId: clientId.trim(), domain: domain.trim(), ...(secret.trim() ? { clientSecret: secret.trim() } : {}) })
      setSecret('')
      onView(next)
      toast.success('保存しました。シークレットは二度と表示されません（末尾の4文字だけ表示します）。')
    } catch (err) {
      toast.error(explain(err))
    } finally {
      setBusy(false)
    }
  }

  async function toggle() {
    setBusy(true)
    try {
      onView(await googleApi.setEnabled(companyId, !view.enabled))
    } catch (err) {
      toast.error(explain(err))
    } finally {
      setBusy(false)
    }
  }

  async function setFeature(feature: GoogleFeature, on: boolean) {
    setBusy(true)
    try {
      onView(await googleApi.setFeature(companyId, feature, on))
    } catch (err) {
      toast.error(explain(err))
    } finally {
      setBusy(false)
    }
  }

  async function stop(grant: GoogleGrantSummary) {
    try {
      onView(await googleApi.stopGrant(companyId, grant.userId))
      toast.success('止めました。この人が使うには、もう一度「Google で許可」が必要です。')
    } catch (err) {
      toast.error(explain(err))
    }
  }

  return (
    <>
      {view.practice && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          練習用の Google につながっています。本物のクライアント シークレットは登録できません（練習用の値だけ）。
        </p>
      )}
      {view.operatorStopped && (
        <p className="rounded-md border px-3 py-2 text-sm">運用担当者が Google を止めています。止めている間は、誰も使えません。</p>
      )}
      {!view.vaultEnabled && (
        <p className="rounded-md border px-3 py-2 text-sm">サーバーに鍵の金庫が用意されていないため、登録できません。運用担当者に確かめてください。</p>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Google Cloud に登録する戻り先（承認済みのリダイレクト URI）</h3>
        <div className="flex items-center gap-2">
          <code className="break-all rounded bg-muted px-2 py-1 text-xs" data-testid="google-redirect-uri">{view.redirectUri}</code>
          <Button variant="outline" size="sm" aria-label="戻り先をコピー"
            onClick={async () => { if (await copyText(view.redirectUri)) toast.success('コピーしました') }}>
            <Copy size={14} /> コピー
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Google Cloud の「認証情報」で作ったウェブ アプリケーションに、この文字をそのまま足してください。</p>
      </section>

      <section className="grid max-w-xl gap-3">
        <div className="grid gap-1">
          <Label htmlFor="google-client-id">クライアント ID</Label>
          <Input id="google-client-id" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="google-client-secret">クライアント シークレット</Label>
          <Input id="google-client-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password"
            placeholder={view.secretLast4 ? `登録済み（末尾 ${view.secretLast4}）。取り替えるときだけ入れてください` : ''} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="google-domain">社内のドメイン</Label>
          <Input id="google-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.co.jp" autoComplete="off" spellCheck={false} />
          <p className="text-xs text-muted-foreground">このドメインの Google アカウントで、ACB に登録したのと同じメールアドレスのものだけを受け付けます。</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={save} disabled={busy || !view.vaultEnabled || !clientId.trim() || !domain.trim() || (!view.configured && !secret.trim())}>Google の設定を保存</Button>
          {view.configured && (
            <Button variant="outline" onClick={toggle} disabled={busy}>{view.enabled ? 'オフにする' : 'オンにする'}</Button>
          )}
        </div>
        {view.configured && view.updatedAt && (
          <p className="text-xs text-muted-foreground">最後の変更: {formatDateTime(view.updatedAt)}（{nameOf(view.updatedBy ?? '')}）</p>
        )}
      </section>

      {view.configured && (
        <section className="space-y-2" data-testid="google-company-features">
          <h3 className="text-sm font-medium">会社で使うもの</h3>
          <p className="text-xs text-muted-foreground">
            メンバーはアプリの「仕事の道具をつなぐ」で、ここでオンのものを一度にまとめて許可します。オフにしたものは誰にも許可を求めず、すでに許可した人の分も次から使いません。
          </p>
          <ul className="space-y-1">
            {GOOGLE_FEATURES.map((f) => {
              const on = !view.featuresOff.includes(f)
              const needsPicker = f === 'drive' && on && !view.picker.configured
              return (
                <li key={f} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="min-w-56">{GOOGLE_FEATURE_TEXT[f]}</span>
                  <span className="text-muted-foreground">{on ? (needsPicker ? 'オン（下の「ファイル選び」を設定すると使えます）' : 'オン') : 'オフ'}</span>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => setFeature(f, !on)}>{on ? 'オフにする' : 'オンにする'}</Button>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-medium">メンバーの許可（読むもの・送るもの）</h3>
        {view.grants.length === 0 ? (
          <p className="text-sm text-muted-foreground">まだ誰も「Google で許可」をしていません。</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {view.grants.map((g) => (
              <li key={g.userId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm" data-testid={`google-grant-${g.userId}`}>
                <div className="space-y-0.5">
                  <div className="font-medium">{g.memberName || g.memberEmail || nameOf(g.userId)}</div>
                  <div className="text-xs text-muted-foreground">
                    Google: {g.googleEmail} ・ {g.features.length > 0 ? g.features.map((f) => `${GOOGLE_FEATURE_TEXT[f]}${g.featuresOff.includes(f) ? '（本人がオフ）' : ''}`).join('・') : '（なし）'}
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
        <p className="text-xs text-muted-foreground">「API キー」の「すべての鍵を止める」でも、全員の Google の許可が止まります。</p>
      </section>

      {view.configured && <DrivePickerSection companyId={companyId} view={view} onView={onView} />}

      <MinutesFolderSection companyId={companyId} />

      <ConfirmDialog
        open={stopping !== null}
        onOpenChange={(open) => { if (!open) setStopping(null) }}
        title="この人の Google の許可を止めますか？"
        description="Google 側の許可も取り消します。この人が使うには、もう一度「Google で許可」が必要です。"
        confirmLabel="止める"
        onConfirm={async () => { if (stopping) await stop(stopping); setStopping(null) }}
      />
    </>
  )
}
