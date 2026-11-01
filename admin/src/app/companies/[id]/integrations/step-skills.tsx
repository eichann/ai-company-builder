'use client'

// 「手順を会社のスキルで」 of one business (plan C5, `.claude/rules/plugin-steps.md`): for each step the
// business lets a company replace (`overridable`), the company's own Skill (`.claude/skills/<name>/`)
// to run instead of the business's procedure. The step's tools stay the limit whichever runs. A work
// keeps the procedure its first run used; a change here applies to work started later. The server
// decides every rule (owner / admin only, an overridable step only, a Skill on the shared branch).
import { useState } from 'react'
import { toast } from 'sonner'
import { ListChecks } from '@phosphor-icons/react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { pluginsApi, type PluginStepSkillsView } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { useQuery } from '@/lib/use-query'

const SKILL_NAME = /^[a-z0-9][a-z0-9_-]*$/

export function StepSkillsSection({ pluginId }: { pluginId: string }) {
  const { companyId } = useCompany()
  const skills = useQuery(`plugin-step-skills:${companyId}:${pluginId}`, () => pluginsApi.stepSkills(companyId, pluginId))
  const steps = skills.data?.steps.filter((s) => s.overridable) ?? []
  if (steps.length === 0) return null
  return (
    <section className="space-y-3" aria-label="手順を会社のスキルで">
      <h3 className="flex items-center gap-2 text-sm font-medium"><ListChecks size={14} />手順を会社のスキルで</h3>
      <p className="text-xs text-muted-foreground">
        この業務の手順のうち、会社のやり方に置き換えてよいものです。会社のスキル（.claude/skills/ のフォルダの名前）を書くと、業務の手順書の代わりにそれを使います。
        使える道具は手順で決まったままです。すでに始まった仕事は、最初に使った手順のまま進みます。
      </p>
      {steps.map((s) => (
        <StepSkill key={`${s.step}:${s.skill ?? ''}`} pluginId={pluginId} step={s} onSaved={(next) => skills.setData(() => next)} />
      ))}
    </section>
  )
}

function StepSkill({ pluginId, step, onSaved }: {
  pluginId: string
  step: PluginStepSkillsView['steps'][number]
  onSaved: (view: PluginStepSkillsView) => void
}) {
  const { companyId } = useCompany()
  const [value, setValue] = useState(step.skill ?? '')
  const [busy, setBusy] = useState(false)
  const trimmed = value.trim()
  const valid = trimmed === '' || SKILL_NAME.test(trimmed)
  const changed = trimmed !== (step.skill ?? '')
  const save = async () => {
    setBusy(true)
    try {
      onSaved(await pluginsApi.setStepSkill(companyId, pluginId, step.step, trimmed === '' ? null : trimmed))
      toast.success(`「${step.label}」を保存しました`)
    } catch (err) {
      toast.error('保存できませんでした', { description: describeError(err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <fieldset className="space-y-1 rounded-md border p-3" aria-label={step.label}>
      <legend className="px-1 text-sm">{step.label}</legend>
      <div className="flex items-center gap-2">
        <Input aria-label={`${step.label}の会社のスキル`} placeholder="（業務の手順書を使う）" value={value}
          onChange={(e) => setValue(e.target.value)} className="max-w-xs" />
        <Button size="sm" disabled={busy || !changed || !valid} onClick={save}>保存</Button>
      </div>
      {!valid && <p role="alert" className="text-xs text-destructive">スキルの名前は英小文字・数字・- _ で書きます。</p>}
    </fieldset>
  )
}
