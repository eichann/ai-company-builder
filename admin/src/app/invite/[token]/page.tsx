'use client'

// A member's first time (管理画面の見直し 2-2, demo Join.tsx): three steps and nothing to set —
// 招待リンク → アカウント → アプリ. The app learns this server's address from 「アプリを開く」
// (lib/app-link.ts; the app shows it and asks before using it), its company and departments
// come from the invitation (所属), so the member never types an address or picks a company.

import { use, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AppWindow, CheckCircle, DownloadSimple, LinkBreak } from '@phosphor-icons/react'

import { AuthLayout } from '@/components/app/brand'
import { FullPageLoading } from '@/components/app/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { configApi, invitationsApi } from '@/lib/api'
import { appOpenLink } from '@/lib/app-link'
import { useAuth } from '@/lib/auth-context'
import { describeError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { useQuery } from '@/lib/use-query'
import { cn } from '@/lib/utils'

const STEPS = ['招待リンク', 'アカウント', 'アプリ'] as const

function Steps({ current }: { current: 1 | 2 | 3 }) {
  return (
    <ol aria-label="参加の流れ" className="mb-4 flex items-center justify-center gap-2 text-xs">
      {STEPS.map((label, i) => {
        const n = i + 1
        return (
          <li key={label} className="flex items-center gap-2" aria-current={n === current ? 'step' : undefined}>
            <span
              className={cn(
                'flex size-6 items-center justify-center rounded-full text-[11px] font-bold',
                n < current ? 'bg-success text-white' : n === current ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              )}
            >
              {n < current ? <CheckCircle size={14} weight="fill" /> : n}
            </span>
            <span className={n === current ? 'font-semibold' : 'text-muted-foreground'}>{label}</span>
            {n < STEPS.length && <span className="h-px w-6 bg-border" />}
          </li>
        )
      })}
    </ol>
  )
}

/** 「営業部」 / 「営業部・サポート部」 */
const joinNames = (names: string[]) => names.join('・')

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const router = useRouter()
  const { user, loading: authLoading, signUp, signOut } = useAuth()
  const invitation = useQuery(`invitation:${token}`, () => invitationsApi.validate(token))
  const config = useQuery('config', () => configApi.get())

  const [step, setStep] = useState<'invite' | 'account' | 'login'>('invite')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [joined, setJoined] = useState<{ companyId: string; companyName: string; role: string } | null>(null)

  const accept = async () => {
    const res = await invitationsApi.accept(token)
    setJoined({ companyId: res.companyId, companyName: res.companyName, role: res.role })
  }

  const handleAccept = async () => {
    setBusy(true)
    setError(null)
    try {
      await accept()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      // The server only allows sign-up with a valid invitation token header.
      await signUp(email, password, name, token)
    } catch (err) {
      setError(describeError(err))
      setBusy(false)
      return
    }
    try {
      await accept()
    } catch (err) {
      // Signed up but not joined yet: the signed-in view offers 参加する again.
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  if (authLoading || invitation.loading) return <FullPageLoading />

  // 3. アプリ
  if (joined) {
    const downloadUrl = config.data?.appDownloadUrl ?? null
    const departments = invitation.data?.departmentNames ?? []
    const isAdminRole = joined.role === 'owner' || joined.role === 'admin'
    return (
      <AuthLayout>
        <Steps current={3} />
        <Card>
          <CardHeader>
            <CardTitle className="text-base">アプリを入れて開く</CardTitle>
            <CardDescription>{joined.companyName} に参加しました。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {downloadUrl ? (
              <Button asChild>
                <a href={downloadUrl}>
                  <DownloadSimple />
                  アプリをダウンロード（Mac）
                </a>
              </Button>
            ) : (
              <p className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
                アプリは、招待した方から受け取ってください。
              </p>
            )}
            <Button asChild variant="outline">
              <a href={appOpenLink(window.location.href)}>
                <AppWindow />
                アプリを開く
              </a>
            </Button>
            <ul className="grid gap-1.5 text-sm text-muted-foreground">
              <li>アプリを入れたら［アプリを開く］を押してください。{joined.companyName} にそのまま入ります（サーバーや会社を選ぶ必要はありません）。</li>
              <li>
                {departments.length > 0
                  ? `${joinNames(departments)}のファイルが自動で入ります（あとで設定で変えられます）。`
                  : '入れる部署は、アプリで選べます（あとで設定で変えられます）。'}
              </li>
              <li>アプリには、いま作ったメールアドレスとパスワードでログインします。</li>
              <li>最後に［Google で許可］を1回押すと、予定と議事録・メールが AI とつながります（会社が用意しているときだけ）。</li>
            </ul>
            {isAdminRole && (
              <Button variant="ghost" size="sm" onClick={() => router.push(`/companies/${joined.companyId}`)}>
                管理画面を開く
              </Button>
            )}
          </CardContent>
        </Card>
      </AuthLayout>
    )
  }

  if (invitation.error || !invitation.data) {
    return (
      <AuthLayout>
        <Card>
          <CardHeader className="justify-items-center text-center">
            <LinkBreak size={32} className="mb-1 text-muted-foreground" />
            <CardTitle className="text-base">この招待リンクは使えません</CardTitle>
            <CardDescription>
              有効期限が切れたか、すでに使われた可能性があります。招待した方に新しいリンクを依頼してください。
            </CardDescription>
          </CardHeader>
          <CardContent className="mt-2 flex justify-center">
            <Button asChild variant="outline">
              <Link href="/login">ログイン画面へ</Link>
            </Button>
          </CardContent>
        </Card>
      </AuthLayout>
    )
  }

  const info = invitation.data
  const errorBox = error && (
    <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      {error}
    </p>
  )

  // 1. 招待リンク
  if (step === 'invite' && !user) {
    return (
      <AuthLayout>
        <Steps current={1} />
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              {info.inviterName ? `${info.inviterName}さんが、${info.companyName}に招待しています` : `${info.companyName}への招待`}
            </CardTitle>
            <CardDescription>
              参加すると、会社のファイルとやることを AI と一緒に使えます。
              {info.departmentNames.length > 0 && `${joinNames(info.departmentNames)}のメンバーとして参加します。`}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Button onClick={() => setStep('account')}>参加する</Button>
            <p className="text-xs text-muted-foreground">このリンクは {formatDate(info.expiresAt)} まで使えます。</p>
          </CardContent>
        </Card>
      </AuthLayout>
    )
  }

  // 2. アカウント
  return (
    <AuthLayout>
      <Steps current={2} />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{user ? `${info.companyName}に参加する` : 'アカウントを作る'}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          {errorBox}
          {user ? (
            <>
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{user.email}</span> でログインしています。
              </p>
              <Button onClick={handleAccept} disabled={busy}>
                {busy ? '参加しています…' : '参加する'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  await signOut()
                  setStep('account')
                }}
              >
                別のアカウントで参加する
              </Button>
            </>
          ) : step === 'login' ? (
            <div className="grid gap-3">
              <Button asChild>
                <Link href={`/login?redirect=${encodeURIComponent(`/invite/${token}`)}`}>ログインして参加</Link>
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setStep('account')}>
                新しくアカウントを作る
              </Button>
            </div>
          ) : (
            <form onSubmit={handleRegister} className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="name">名前</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="山田 太郎" autoComplete="name" required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="email">メール</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="password">パスワード</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
                <p className="text-xs text-muted-foreground">8文字以上。アプリのログインにも使います。</p>
              </div>
              <Button type="submit" disabled={busy}>
                {busy ? '作っています…' : 'アカウントを作る'}
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                すでにアカウントをお持ちですか？{' '}
                <button type="button" className="font-medium text-foreground underline-offset-4 hover:underline" onClick={() => setStep('login')}>
                  ログインして参加
                </button>
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </AuthLayout>
  )
}
