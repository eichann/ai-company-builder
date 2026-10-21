'use client'

import { use, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CheckCircle, EnvelopeSimpleOpen, LinkBreak } from '@phosphor-icons/react'

import { AuthLayout } from '@/components/app/brand'
import { FullPageLoading } from '@/components/app/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { invitationsApi } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import { describeError } from '@/lib/errors'
import { formatDate, roleLabel } from '@/lib/format'
import { useQuery } from '@/lib/use-query'

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const router = useRouter()
  const { user, loading: authLoading, signUp, signOut } = useAuth()
  const invitation = useQuery(`invitation:${token}`, () => invitationsApi.validate(token))

  const [mode, setMode] = useState<'register' | 'choose'>('register')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [joined, setJoined] = useState<{ companyId: string; companyName: string } | null>(null)

  const accept = async () => {
    const res = await invitationsApi.accept(token)
    setJoined({ companyId: res.companyId, companyName: res.companyName })
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
      // Signed up but not joined yet: the signed-in view offers the accept button again.
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  if (authLoading || invitation.loading) return <FullPageLoading />

  if (joined) {
    return (
      <AuthLayout>
        <Card>
          <CardHeader className="justify-items-center text-center">
            <CheckCircle size={36} weight="fill" className="mb-1 text-success" />
            <CardTitle className="text-base">{joined.companyName} に参加しました</CardTitle>
            <CardDescription>
              デスクトップアプリに同じメールアドレスとパスワードでログインすると、会社のファイルやAIスキルを使えます。
            </CardDescription>
          </CardHeader>
          <CardFooter className="mt-5 justify-center">
            <Button onClick={() => router.push(`/companies/${joined.companyId}`)}>管理画面を開く</Button>
          </CardFooter>
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
          <CardFooter className="mt-5 justify-center">
            <Button asChild variant="outline">
              <Link href="/login">ログイン画面へ</Link>
            </Button>
          </CardFooter>
        </Card>
      </AuthLayout>
    )
  }

  const info = invitation.data

  return (
    <AuthLayout>
      <Card>
        <CardHeader>
          <div className="mb-1 flex size-9 items-center justify-center rounded-lg bg-brand/10 text-brand">
            <EnvelopeSimpleOpen size={20} />
          </div>
          <CardTitle className="text-base">{info.companyName} への招待</CardTitle>
          <CardDescription>
            {roleLabel(info.role)}として参加します。招待の有効期限は {formatDate(info.expiresAt)} までです。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {error && (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          {user ? (
            <>
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{user.email}</span> でログインしています。
              </p>
              <Button onClick={handleAccept} disabled={busy}>
                {busy ? '参加しています…' : '招待を受け入れる'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  await signOut()
                  setMode('register')
                }}
              >
                別のアカウントで参加する
              </Button>
            </>
          ) : mode === 'register' ? (
            <form onSubmit={handleRegister} className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="name">名前</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="山田 太郎" autoComplete="name" required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="email">メールアドレス</Label>
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
                <p className="text-xs text-muted-foreground">8文字以上。デスクトップアプリのログインにも使います。</p>
              </div>
              <Button type="submit" disabled={busy}>
                {busy ? '登録しています…' : 'アカウントを作成して参加'}
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                すでにアカウントをお持ちですか？{' '}
                <button type="button" className="font-medium text-foreground underline-offset-4 hover:underline" onClick={() => setMode('choose')}>
                  ログインして参加
                </button>
              </p>
            </form>
          ) : (
            <div className="grid gap-3">
              <Button asChild>
                <Link href={`/login?redirect=${encodeURIComponent(`/invite/${token}`)}`}>ログインして参加</Link>
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setMode('register')}>
                新しくアカウントを作成する
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </AuthLayout>
  )
}
