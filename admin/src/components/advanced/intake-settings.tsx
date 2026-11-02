'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { EnvelopeSimple, Plus, Trash } from '@phosphor-icons/react'

import { RadioCard } from '@/components/app/radio-card'
import { ErrorState, ListSkeleton } from '@/components/app/states'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { inboxSettingsApi, type Department, type InboxSettingsView, type IntakeSettings } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { useQuery } from '@/lib/use-query'

/**
 * 来た連絡の細かい決まり (the company's intake settings, inbox.md): asked as
 * plain questions; the defaults are the owner's decisions. Rules and
 * validation: shared/core/intake-settings.ts (the server checks again).
 */
export function IntakeSettingsSection({ departments }: { departments: Department[] }) {
  const { companyId } = useCompany()
  const settings = useQuery(`inbox-settings:${companyId}`, () => inboxSettingsApi.get(companyId))
  if (settings.loading) return <ListSkeleton rows={2} />
  if (settings.error && !settings.data) return <ErrorState error={settings.error} onRetry={settings.reload} />
  if (!settings.data) return null
  return (
    <IntakeForm
      key={settings.data.updatedAt ?? 'defaults'}
      view={settings.data}
      departments={departments}
      onSaved={(next) => settings.setData(() => next)}
    />
  )
}

const copy = (s: IntakeSettings): IntakeSettings => ({
  ...s,
  internalDomains: [...s.internalDomains],
  sharedAddresses: s.sharedAddresses.map((a) => ({ ...a })),
})

function IntakeForm({ view, departments, onSaved }: { view: InboxSettingsView; departments: Department[]; onSaved: (next: InboxSettingsView) => void }) {
  const { companyId } = useCompany()
  const [draft, setDraft] = useState<IntakeSettings>(() => copy(view.settings))
  const [domains, setDomains] = useState(view.settings.internalDomains.join('\n'))
  const [busy, setBusy] = useState(false)
  const change = (fn: (d: IntakeSettings) => void) =>
    setDraft((prev) => {
      const next = copy(prev)
      fn(next)
      return next
    })
  const toSave = (): IntakeSettings => ({
    ...draft,
    internalDomains: domains.split(/[\s,]+/).map((d) => d.trim()).filter((d) => d !== ''),
    sharedAddresses: draft.sharedAddresses.filter((a) => a.address.trim() !== ''),
  })
  const dirty = JSON.stringify(toSave()) !== JSON.stringify(view.settings)

  const save = async () => {
    setBusy(true)
    try {
      const next = await inboxSettingsApi.update(companyId, toSave())
      toast.success('来た連絡の決まりを保存しました')
      onSaved(next)
    } catch (err) {
      toast.error('保存できませんでした', { description: describeError(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <EnvelopeSimple size={16} />
          届いたメールやチャットを、誰の仕事にしますか？
        </CardTitle>
        <CardDescription>
          宛先（To）の人の仕事になり、その人だけが見られます。AI が返事が要るかを見て、要るものだけをやることにします。
        </CardDescription>
      </CardHeader>

      <Question label="宛先（To）に社内の人が何人もいるとき">
        <RadioCard checked={draft.multipleTo === 'first'} onSelect={() => change((d) => { d.multipleTo = 'first' })}
          label="最初の人の仕事にする" help="AI が宛名を読んで、別の人あてなら確かめてもらいます。" />
        <RadioCard checked={draft.multipleTo === 'unsure'} onSelect={() => change((d) => { d.multipleTo = 'unsure' })}
          label="最初の人に確かめてもらう" help="「確認待ち」として、誰が受け持つかを決めてもらいます。" />
      </Question>

      <Question label="CC に入っているだけのとき">
        <RadioCard checked={draft.ccOnly === 'nothing'} onSelect={() => change((d) => { d.ccOnly = 'nothing' })}
          label="何もしない" help="CC の人には出しません。" />
        <RadioCard checked={draft.ccOnly === 'unsure'} onSelect={() => change((d) => { d.ccOnly = 'unsure' })}
          label="確かめてもらう" help="宛先に社内の人がいないときだけ、CC の人に「確認待ち」で出します。" />
      </Question>

      <Question label="社内の誰かが返信したとき">
        <RadioCard checked={draft.memberReply === 'ai_checks'} onSelect={() => change((d) => { d.memberReply = 'ai_checks' })}
          label="AI が返信を読んで決める" help="答えたなら終わり、質問を返したなら相手の返事待ちにします。" />
        <RadioCard checked={draft.memberReply === 'close'} onSelect={() => change((d) => { d.memberReply = 'close' })}
          label="すぐ終わりにする" help="返信したら終わりにします（あとでやり直せます）。" />
      </Question>

      <Question label="メルマガ・自動で送られたメール">
        <RadioCard checked={draft.excludeBulk} onSelect={() => change((d) => { d.excludeBulk = true })}
          label="やることにしない" help="「やることにしなかった一覧」で、本人があとから確かめられます。" />
        <RadioCard checked={!draft.excludeBulk} onSelect={() => change((d) => { d.excludeBulk = false })}
          label="ほかのメールと同じに扱う" help="AI が返事が要るかを見ます。" />
      </Question>

      <Question label="社内の人どうしのメール">
        <RadioCard checked={draft.excludeInternal} onSelect={() => change((d) => { d.excludeInternal = true })}
          label="やることにしない" help="メンバーのアドレスと、下のドメインからのものは扱いません。" />
        <RadioCard checked={!draft.excludeInternal} onSelect={() => change((d) => { d.excludeInternal = false })}
          label="社外からと同じに扱う" help="グループ会社などとのやりとりも、やることにします。" />
      </Question>

      <div className="space-y-1.5 border-t px-5 py-4 text-sm">
        <Label htmlFor="intake-domains">社内として扱うドメイン（メンバーのアドレスのドメインは自動で入ります）</Label>
        <textarea
          id="intake-domains"
          rows={2}
          className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
          placeholder="group-company.co.jp"
          value={domains}
          onChange={(e) => setDomains(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">1行に1つ。Gmail などのフリーメールは入れられません。</p>
      </div>

      <div className="space-y-3 border-t px-5 py-4 text-sm">
        <p className="font-medium">共有の受付アドレス（info@ など）</p>
        <p className="text-xs text-muted-foreground">届いたものは選んだ部署の番になり、部署の誰かが「引き受ける」と、その人の仕事になります。</p>
        {draft.sharedAddresses.map((a, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="受付アドレス"
              className="w-64"
              placeholder="info@example.co.jp"
              value={a.address}
              onChange={(e) => change((d) => { d.sharedAddresses[i].address = e.target.value })}
            />
            <select
              aria-label="部署"
              className="h-9 rounded-md border bg-transparent px-2 text-sm"
              value={a.folder}
              onChange={(e) => change((d) => { d.sharedAddresses[i].folder = e.target.value })}
            >
              <option value="">部署を選ぶ</option>
              {departments.map((dep) => (
                <option key={dep.id} value={dep.folder}>{dep.name}</option>
              ))}
            </select>
            <Button variant="ghost" size="icon" aria-label="消す" onClick={() => change((d) => { d.sharedAddresses.splice(i, 1) })}>
              <Trash size={16} />
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={() => change((d) => { d.sharedAddresses.push({ address: '', folder: '' }) })}>
          <Plus size={14} /> 受付アドレスを足す
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-4">
        <p className="text-xs text-muted-foreground">
          {view.updatedAt ? `最後に変えた日時: ${formatDateTime(view.updatedAt)}` : 'まだ変えていません（はじめの決まりのままです）'}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" disabled={busy || !dirty} onClick={() => { setDraft(copy(view.settings)); setDomains(view.settings.internalDomains.join('\n')) }}>
            取り消す
          </Button>
          <Button disabled={busy || !dirty} onClick={save}>
            {busy ? '保存しています…' : '保存'}
          </Button>
        </div>
      </div>
    </Card>
  )
}

function Question({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="radiogroup" aria-label={label} className="space-y-2 border-t px-5 py-4">
      <p className="text-sm font-medium">{label}</p>
      <div className="grid gap-3 md:grid-cols-2">{children}</div>
    </div>
  )
}
