'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

import { AuthLayout } from '@/components/app/brand'
import { ErrorState, FullPageLoading } from '@/components/app/states'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { configApi } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import { describeError } from '@/lib/errors'
import { isManualPath, safeRedirect } from '@/lib/redirect'

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirectTo = safeRedirect(searchParams.get('redirect'))
  // The user manual (server.md "The user manual") sends a reader here when not signed in. It is
  // served by the API, not this console, so it is opened as a whole page, not by the router.
  const forManual = isManualPath(redirectTo)
  const { signIn, signUp, user, loading: authLoading } = useAuth()
  // null until /api/config answers; false means no account exists yet.
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Whether an account exists cannot be guessed: when /api/config fails, say so
  // (with 再読み込み) instead of showing a login form on a server with no account.
  const [configError, setConfigError] = useState<unknown>(null)
  const [configAttempt, setConfigAttempt] = useState(0)

  useEffect(() => {
    let active = true
    configApi.get().then(
      (c) => active && setSetupComplete(c.setupComplete),
      (e: unknown) => active && setConfigError(e ?? new Error('config'))
    )
    return () => {
      active = false
    }
  }, [configAttempt])

  const goBack = useCallback(() => {
    if (forManual) window.location.replace(redirectTo)
    else router.replace(redirectTo)
  }, [forManual, router, redirectTo])

  // Already signed in when the page opens: back to the console page at once. Not to the manual: had
  // the manual refused this session (a cookie not reaching it), that would bounce between the two
  // pages for ever, so the reader is offered a link instead.
  useEffect(() => {
    if (!authLoading && user && !forManual) router.replace(redirectTo)
  }, [authLoading, user, forManual, router, redirectTo])

  const isSetup = setupComplete === false

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      if (isSetup) {
        await signUp(email, password, name)
      } else {
        await signIn(email, password)
      }
      goBack()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setSubmitting(false)
    }
  }

  if (configError && setupComplete === null) {
    return (
      <AuthLayout>
        <ErrorState error={configError} title="サーバーの状態を確認できませんでした" onRetry={() => { setConfigError(null); setConfigAttempt((n) => n + 1) }} />
      </AuthLayout>
    )
  }
  if (setupComplete === null || authLoading) return <FullPageLoading />
  if (forManual && user && !submitting) {
    return (
      <AuthLayout>
        <Card>
          <CardHeader>
            <CardTitle className="text-title">ログインしています</CardTitle>
            <CardDescription>使い方のページを開けます。</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" onClick={goBack}>使い方を開く</Button>
          </CardContent>
        </Card>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{isSetup ? '最初の管理者アカウントを作成' : 'ログイン'}</CardTitle>
          <CardDescription>
            {isSetup
              ? 'このサーバーにはまだアカウントがありません。最初に作成したアカウントで会社を作成できます。'
              : forManual
                ? 'ログインすると使い方を見られます。'
                : '管理画面にログインします。'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="grid gap-4">
            {isSetup && (
              <div className="grid gap-2">
                <Label htmlFor="name">名前</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="山田 太郎"
                  autoComplete="name"
                  required
                />
              </div>
            )}
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
                autoComplete={isSetup ? 'new-password' : 'current-password'}
                minLength={8}
                required
              />
              {isSetup && <p className="text-xs text-muted-foreground">8文字以上</p>}
            </div>
            {error && (
              <Callout variant="danger">
                {error}
              </Callout>
            )}
            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? '処理中…' : isSetup ? 'アカウントを作成' : 'ログイン'}
            </Button>
          </form>
        </CardContent>
      </Card>
      {!isSetup && (
        <p className="mt-4 text-center text-xs text-muted-foreground">
          アカウントをお持ちでない方は、管理者から届いた招待リンクを開いてください。
        </p>
      )}
    </AuthLayout>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<FullPageLoading />}>
      <LoginForm />
    </Suspense>
  )
}
