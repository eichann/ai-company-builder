'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from '@phosphor-icons/react'

import { RequireAuth } from '@/components/app/auth-guard'
import { RadioCard } from '@/components/app/radio-card'
import { AuthLayout } from '@/components/app/brand'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { companiesApi } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import { NOT_A_MEMBER_YET, offersCompanyCreation } from '@/lib/company-creation'
import { FOLDER_KIND_CHOICES, FOLDER_KIND_HINT } from '@/lib/company-folder'
import type { CompanyFolderKind } from '../../../../../shared/core/company-folder'
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
  const { user, refresh } = useAuth()
  const [name, setName] = useState('')
  // Today's kind unless the operator chooses otherwise (owner decision 2026-11-07).
  const [folderKind, setFolderKind] = useState<CompanyFolderKind>('git')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      // The server derives a unique URL slug from the name.
      const company = await companiesApi.create(name.trim(), undefined, folderKind)
      // The first company of a fresh server: its creator may not make another.
      await refresh()
      router.push(`/companies/${company.id}`)
    } catch (err) {
      setError(describeError(err))
      setBusy(false)
    }
  }

  // Reached by URL by someone the server does not let create a company.
  if (!offersCompanyCreation(user)) {
    return (
      <AuthLayout>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">会社の作成はできません</CardTitle>
            <CardDescription>
              会社の作成はサービスの運用担当者が行います。{NOT_A_MEMBER_YET}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" variant="ghost" onClick={() => router.back()}>
              <ArrowLeft />
              戻る
            </Button>
          </CardContent>
        </Card>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">会社を作成</CardTitle>
          <CardDescription>
            標準の部署が作成され、作成したあなたがオーナーになります。
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
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-medium">全社フォルダ</legend>
              <div role="radiogroup" aria-label="全社フォルダ" aria-describedby="folder-kind-hint" className="grid gap-2">
                {FOLDER_KIND_CHOICES.map((c) => (
                  <RadioCard key={c.kind} checked={folderKind === c.kind} onSelect={() => setFolderKind(c.kind)} label={c.label} help={c.help} />
                ))}
              </div>
              <p id="folder-kind-hint" className="text-xs text-muted-foreground">{FOLDER_KIND_HINT}</p>
            </fieldset>
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
