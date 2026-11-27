'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { SealCheck, ShieldSlash } from '@phosphor-icons/react'

import { AdvancedCrumb } from '@/components/advanced/crumb'
import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  SKILL_PER_RUN_NOTE,
  SKILL_PRE_APPROVED_NOTE,
  SKILL_REVOKE_DESCRIPTION,
  SKILL_REVOKE_TITLE,
  SKILL_STATUS_BADGE,
  SKILL_STATUS_WORDS,
  SKILLS_EMPTY,
  SKILLS_INCOMPLETE,
  SKILLS_INTRO,
  SKILLS_TITLE,
  howWords,
  skillActions,
  skillLabel,
  skillPlaceWords,
} from '@/lib/agent-browser-skills'
import { browserSkillsApi, type BrowserSkillApprovalMode, type BrowserSkillView } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { useQuery } from '@/lib/use-query'

/**
 * 「詳しい設定 › AI の安全 › ブラウザ操作 › Skill の承認」 (owner/admin; agent-browser.md "A Skill's browser declaration and its
 * approval"): each company Skill with a browser declaration as the server read it — its domain, write targets with their
 * counts, the addresses never read and read afterwards — and its state; approve (each run's card) or pre-approve exactly
 * the version shown, or take the approval back. The server checks the role and the version on every call.
 */
export default function BrowserSkillsPage() {
  const { companyId, role, isAdmin } = useCompany()
  const list = useQuery(isAdmin ? `browser-skills:${companyId}` : null, () => browserSkillsApi.list(companyId))
  const [revoking, setRevoking] = useState<BrowserSkillView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  if (role !== null && !isAdmin) {
    return (
      <>
        <AdvancedCrumb aiSafety browser />
        <PageHeader title={SKILLS_TITLE} />
        <EmptyState icon={ShieldSlash} title="このページはオーナーと管理者だけが使えます" />
      </>
    )
  }

  const approve = async (s: BrowserSkillView, mode: BrowserSkillApprovalMode) => {
    setBusy(s.path)
    try {
      await browserSkillsApi.approve(companyId, { skill: s.path, declarationHash: s.declarationHash, files: s.files, mode })
      toast.success(mode === 'pre_approved' ? '前もって承認しました' : '承認しました')
    } catch (err) {
      toast.error('承認できませんでした', { description: describeError(err) })
    } finally {
      setBusy(null)
      list.reload()
    }
  }
  const revoke = async (s: BrowserSkillView) => {
    try {
      await browserSkillsApi.revoke(companyId, s.path)
      toast.success('承認を取り消しました')
    } catch (err) {
      toast.error('取り消せませんでした', { description: describeError(err) })
      list.reload()
      throw err
    }
    list.reload()
  }

  return (
    <>
      <AdvancedCrumb aiSafety browser />
      <PageHeader title={SKILLS_TITLE} description={SKILLS_INTRO} />
      {list.loading ? (
        <ListSkeleton rows={3} />
      ) : list.error && !list.data ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.data ? (
        <div className="space-y-6 pb-4">
          {list.data.complete === false && <Callout variant="warning">{SKILLS_INCOMPLETE}</Callout>}
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2">
                <SealCheck size={16} />
                ブラウザを使う Skill
              </CardTitle>
              <CardDescription>
                {SKILL_PER_RUN_NOTE}
                <br />
                {SKILL_PRE_APPROVED_NOTE}
              </CardDescription>
            </CardHeader>
            <div className="border-t px-5 py-2">
              {list.data.items.length === 0 ? (
                <p className="py-2 text-body text-muted-foreground">{SKILLS_EMPTY}</p>
              ) : (
                <ul aria-label="ブラウザを使う Skill" className="divide-y">
                  {list.data.items.map((s) => {
                    const can = skillActions(s.status)
                    return (
                      <li key={s.path} data-skill={s.path} className="space-y-2 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono font-semibold">{s.name}</span>
                          <span className="text-small text-muted-foreground" data-place>{skillPlaceWords(s.department)}</span>
                          <Badge variant={SKILL_STATUS_BADGE[s.status]} data-status={s.status}>{SKILL_STATUS_WORDS[s.status]}</Badge>
                          {s.domain && <span className="break-all font-mono text-small text-muted-foreground">{s.domain}</span>}
                        </div>
                        {s.problem && <p className="text-body text-danger-text">{s.problem}</p>}
                        {s.writes.length > 0 && (
                          <div>
                            <p className="text-small font-semibold">書いてよい送り先と回数</p>
                            <ul aria-label={`${skillLabel(s)} の書き込み先`} className="text-small">
                              {s.writes.map((w) => <li key={w} className="break-all">{w}</li>)}
                            </ul>
                          </div>
                        )}
                        {s.neverRead.length > 0 && (
                          <p className="break-all text-small text-muted-foreground">{`読んではいけないアドレス：${s.neverRead.join('、')}`}</p>
                        )}
                        {s.afterRead.length > 0 && (
                          <p className="break-all text-small text-muted-foreground">{`書いたあとに読み直すアドレス：${s.afterRead.join('、')}`}</p>
                        )}
                        {s.accountMarker && <p className="text-small text-muted-foreground">{`アカウントの目印：${s.accountMarker}`}</p>}
                        {s.approval && (
                          <p className="text-small text-muted-foreground">
                            {`${howWords(s.approval.how)}：${s.approval.approvedByName ?? '（いまはメンバーでない人）'}・${formatDateTime(s.approval.approvedAt)}`}
                          </p>
                        )}
                        <div className="flex flex-wrap justify-end gap-2">
                          {can.approve && (
                            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void approve(s, 'per_run')}>承認する</Button>
                          )}
                          {can.preApprove && (
                            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void approve(s, 'pre_approved')}>前もって承認</Button>
                          )}
                          {can.revoke && (
                            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setRevoking(s)} aria-label={`${skillLabel(s)} の承認を取り消す`}>取り消す</Button>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </Card>
        </div>
      ) : null}

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={SKILL_REVOKE_TITLE}
        description={<p>{SKILL_REVOKE_DESCRIPTION}</p>}
        confirmLabel="取り消す"
        onConfirm={() => (revoking ? revoke(revoking) : Promise.resolve())}
      />
    </>
  )
}
