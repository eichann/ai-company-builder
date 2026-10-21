'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from '@phosphor-icons/react'

import { RequireAuth } from '@/components/app/auth-guard'
import { AuthLayout } from '@/components/app/brand'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { companiesApi } from '@/lib/api'
import { describeError } from '@/lib/errors'

export default function NewCompanyPage() {
  return (
    <RequireAuth>
      <NewCompanyForm />
    </RequireAuth>
  )
}

function NewCompanyForm() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      // The server derives a unique URL slug from the name.
      const company = await companiesApi.create(name.trim())
      router.push(`/companies/${company.id}`)
    } catch (err) {
      setError(describeError(err))
      setBusy(false)
    }
  }

  return (
    <AuthLayout>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">会社を作成</CardTitle>
          <CardDescription>
            会社ごとに共有フォルダが用意され、標準の部署が作成されます。作成したあなたがオーナーになります。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="company-name">会社名</Label>
              <Input
                id="company-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="株式会社サンプル"
                autoFocus
                required
              />
            </div>
            {error && (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex items-center justify-between gap-2">
              <Button type="button" variant="ghost" onClick={() => router.back()}>
                <ArrowLeft />
                戻る
              </Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy ? '作成しています…' : '会社を作成'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </AuthLayout>
  )
}
