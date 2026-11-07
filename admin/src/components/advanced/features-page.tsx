'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { SquaresFour } from '@phosphor-icons/react'

import { AdvancedCrumb } from '@/components/advanced/crumb'
import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { featuresApi, type FeatureId } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { useQuery } from '@/lib/use-query'
import { cn } from '@/lib/utils'
import { FEATURE_IDS, FEATURE_OFF_CONFIRM, FEATURE_WORDS } from '../../../../shared/core/features'

/**
 * 「詳しい設定 › 使う機能」 (owner decisions 2026-11-07, records.md "Features on and off"): the five
 * feature switches, one line each on what it is and what turning it off does. Everything starts on.
 * Turning one on is at once; turning one off asks first and says that past records stay (見るだけ)
 * and that turning it on again continues. Who may change them is the server's answer (`canEdit`):
 * anyone else sees them read only.
 */
export function FeaturesPage() {
  const { companyId } = useCompany()
  const query = useQuery(`features:${companyId}`, () => featuresApi.get(companyId))
  const [busy, setBusy] = useState<FeatureId | null>(null)
  const [confirmOff, setConfirmOff] = useState<FeatureId | null>(null)
  const shown = query.data ?? null

  const change = async (feature: FeatureId, on: boolean) => {
    setBusy(feature)
    try {
      const next = await featuresApi.set(companyId, feature, on)
      query.setData(() => next)
      toast.success(`「${FEATURE_WORDS[feature].name}」を${on ? 'オン' : 'オフ'}にしました`)
    } catch (err) {
      toast.error('変えられませんでした', { description: describeError(err) })
      throw err
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <AdvancedCrumb />
      <PageHeader title="使う機能" description="会社で使う機能を選びます。はじめは全部オンです。オフにしても、これまでの記録は消えません。" />
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2">
            <SquaresFour size={16} />
            使う機能
          </CardTitle>
          <CardDescription>
            {shown && !shown.canEdit ? '変えられるのはオーナーと管理者だけです。' : 'オフにした機能は、メンバーのアプリから見えなくなります。'}
          </CardDescription>
        </CardHeader>
        {query.loading && !shown ? (
          <div className="border-t px-5 py-4">
            <ListSkeleton rows={5} />
          </div>
        ) : !shown ? (
          <div className="border-t px-5 py-4">
            <ErrorState error={query.error} onRetry={query.reload} />
          </div>
        ) : (
          <ul aria-label="使う機能" className="divide-y border-t">
            {FEATURE_IDS.map((id) => {
              const on = shown.features[id]
              const words = FEATURE_WORDS[id]
              return (
                <li key={id} className="flex items-start gap-4 px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">{words.name}</div>
                    <p className="text-xs text-muted-foreground">{words.what}</p>
                    <p className="mt-1 text-xs text-muted-foreground">オフにすると：{words.whenOff}</p>
                  </div>
                  <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">{on ? 'オン' : 'オフ'}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={words.name}
                    disabled={!shown.canEdit || busy !== null}
                    onClick={() => (on ? setConfirmOff(id) : void change(id, true).catch(() => {}))}
                    className={cn(
                      'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50',
                      on ? 'bg-primary' : 'bg-input'
                    )}
                  >
                    <span className={cn('block size-5 rounded-full bg-background shadow transition-transform', on ? 'translate-x-5' : 'translate-x-0')} />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {shown?.updatedAt && (
          <div className="border-t px-5 py-3 text-xs text-muted-foreground">
            最後に変えた日時: {formatDateTime(shown.updatedAt)}
            {shown.updatedByName ? `（${shown.updatedByName}）` : ''}
          </div>
        )}
      </Card>
      <ConfirmDialog
        open={confirmOff !== null}
        onOpenChange={(open) => { if (!open) setConfirmOff(null) }}
        title={confirmOff ? `「${FEATURE_WORDS[confirmOff].name}」をオフにしますか？` : ''}
        description={
          confirmOff ? (
            <>
              <p>{FEATURE_WORDS[confirmOff].whenOff}</p>
              <p className="mt-2">{FEATURE_OFF_CONFIRM}</p>
            </>
          ) : null
        }
        confirmLabel="オフにする"
        onConfirm={() => (confirmOff ? change(confirmOff, false) : Promise.resolve())}
      />
    </>
  )
}
