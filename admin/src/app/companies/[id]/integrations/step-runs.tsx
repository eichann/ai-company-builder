'use client'

// 「手順の始め方と置き場所」 of one business (owner decisions 2026-11-06, `.claude/rules/plugin-steps.md`
// "Starting by itself" / "The deliverable folder"): for a step a person starts with a button, the
// company may choose to have it start by itself after a meeting is read (the button by default); for
// every step, the folder (inside each member's own `.personal`) where what it makes is saved — the AI
// may write nowhere else while it runs the step. The server decides every rule.
import { useState } from 'react'
import { toast } from 'sonner'
import { Play } from '@phosphor-icons/react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { pluginsApi, type PluginStepSkillsView } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { useQuery } from '@/lib/use-query'

type Step = PluginStepSkillsView['steps'][number]

export function StepRunsSection({ pluginId }: { pluginId: string }) {
  const { companyId } = useCompany()
  const view = useQuery(`plugin-step-skills:${companyId}:${pluginId}`, () => pluginsApi.stepSkills(companyId, pluginId))
  // An older server says nothing about how steps start: nothing to choose here.
  const steps = view.data?.steps.filter((s) => s.start !== undefined) ?? []
  if (steps.length === 0) return null
  return (
    <section className="space-y-3" aria-label="手順の始め方と置き場所">
      <h3 className="flex items-center gap-2 text-sm font-medium"><Play size={14} />手順の始め方と置き場所</h3>
      <p className="text-xs text-muted-foreground">
        「自動で始める」にすると、商談の議事録を読んだあと、担当者の PC の AI がこの手順を始めます（1日の自動の上限に数えます）。
        自動で始めたときは、外に送る道具やネットで調べる道具は使いません。メールは下書きまでで、送るのは担当者です。
        AI が作ったものは、担当者だけのフォルダ（部署のフォルダの中の .personal）の、下のフォルダに置きます。ほかの場所には保存しません。
      </p>
      {steps.map((s) => (
        <StepRun key={`${s.step}:${s.autoStart}:${s.deliverableFolderChosen ?? ''}`} pluginId={pluginId} step={s} onSaved={(next) => view.setData(() => next)} />
      ))}
    </section>
  )
}

/** A folder name: Japanese or ASCII words with . _ -, never hidden, no slash or space (the server's rule). */
const FOLDER_NAME = /^[\w぀-ゟ゠-ヿ一-鿿][\w぀-ゟ゠-ヿ一-鿿._-]*$/

function StepRun({ pluginId, step, onSaved }: { pluginId: string; step: Step; onSaved: (view: PluginStepSkillsView) => void }) {
  const { companyId } = useCompany()
  const [folder, setFolder] = useState(step.deliverableFolderChosen ?? '')
  const [busy, setBusy] = useState(false)
  const trimmed = folder.trim()
  const valid = trimmed === '' || (trimmed.length <= 60 && FOLDER_NAME.test(trimmed))
  const save = async (body: { autoStart?: boolean; deliverableFolder?: string | null }, what: string) => {
    setBusy(true)
    try {
      onSaved(await pluginsApi.setStepSettings(companyId, pluginId, step.step, body))
      toast.success(`「${step.label}」の${what}を保存しました`)
    } catch (err) {
      toast.error('保存できませんでした', { description: describeError(err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <fieldset className="space-y-2 rounded-md border p-3" aria-label={step.label}>
      <legend className="px-1 text-sm">{step.label}</legend>
      {step.start === 'person' ? (
        <label className="flex items-center gap-2 text-sm">
          始め方
          <select aria-label={`${step.label}の始め方`} disabled={busy} value={step.autoStart ? 'auto' : 'button'}
            onChange={(e) => void save({ autoStart: e.target.value === 'auto' }, '始め方')}
            className="rounded-md border bg-background px-2 py-1 text-sm">
            <option value="button">ボタンで始める</option>
            <option value="auto">自動で始める</option>
          </select>
        </label>
      ) : (
        <p className="text-xs text-muted-foreground">この手順は、もともと自動で始まります。</p>
      )}
      <div className="flex items-center gap-2">
        <Input aria-label={`${step.label}の置き場所`} placeholder={step.deliverableFolder ?? ''} value={folder}
          onChange={(e) => setFolder(e.target.value)} className="max-w-xs" />
        <Button size="sm" disabled={busy || !valid || trimmed === (step.deliverableFolderChosen ?? '')}
          onClick={() => void save({ deliverableFolder: trimmed === '' ? null : trimmed }, '置き場所')}>保存</Button>
      </div>
      <p className="text-xs text-muted-foreground">いまの置き場所：（部署のフォルダ）/.personal/{step.deliverableFolder}/</p>
      {!valid && <p role="alert" className="text-xs text-destructive">フォルダの名前は1つだけ書きます（/ や空白は使えません。. で始めることもできません）。</p>}
    </fieldset>
  )
}
