'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

import { AuthLayout } from '@/components/app/brand'
import { ErrorState, FullPageLoading } from '@/components/app/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { configApi } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import { describeError } from '@/lib/errors'
import { safeRedirect } from '@/lib/redirect'

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirectTo = safeRedirect(searchParams.get('redirect'))
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

  useEffect(() => {
    if (!authLoading && user) router.replace(redirectTo)
  }, [authLoading, user, router, redirectTo])

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
      router.replace(redirectTo)
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

  return (
    <AuthLayout>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{isSetup ? '最初の管理者アカウントを作成' : 'ログイン'}</CardTitle>
          <CardDescription>
            {isSetup
              ? 'このサーバーにはまだアカウントがありません。最初に作成したアカウントで会社を作成できます。'
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
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
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
