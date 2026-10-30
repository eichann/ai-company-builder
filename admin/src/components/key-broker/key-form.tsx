'use client'

// The form that registers a company API key or edits its settings. The key's
// value is a password field that is sent once and never shown again; editing
// never asks for it (replacing is its own dialog).
import { useId, useState } from 'react'

import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { BrokerAudience, BrokerCaps, BrokerKeyCreate, BrokerKeySummary, BrokerServiceView, BrokerView, Member } from '@/lib/api'
import {
  CAP_KEYS,
  CAP_LABELS,
  capOf,
  checkBrokerSecret,
  hostsOf,
  invalidHosts,
  invalidModels,
  invalidPathPrefixes,
  isValidBrokerServiceName,
  modelsOf,
  pathPrefixesOf,
} from '@/lib/key-broker'

const OTHER = '__other__'
/** Per person: as dial ② says, always allowed (added), or never (removed). */
type PersonChoice = 'follow' | 'add' | 'remove'

export interface KeyFormValues {
  service: string
  displayName: string
  secret: string
  destinations: { hosts: string[]; pathPrefixes: string[]; models: string[] }
  audience: BrokerAudience
  caps: BrokerCaps
  allowPrivateContent: boolean
}

export function KeyForm({
  view,
  members,
  editing,
  busy,
  onSubmit,
  onCancel,
}: {
  view: BrokerView
  members: Member[]
  /** The key being edited; undefined = registering a new one. */
  editing?: BrokerKeySummary
  busy: boolean
  onSubmit: (values: KeyFormValues) => void
  onCancel: () => void
}) {
  const id = useId()
  const services: BrokerServiceView[] = view.services
  const [serviceChoice, setServiceChoice] = useState(editing ? editing.service : services[0]?.service ?? OTHER)
  const [customService, setCustomService] = useState('')
  const service = serviceChoice === OTHER ? customService.trim() : serviceChoice
  const builtin = services.find((s) => s.service === service && (s.builtin || s.relay))
  /** A registered service (K9): its keys go to its one host, nowhere else. */
  const relay = services.find((s) => s.service === service)?.relay ?? null
  const [displayName, setDisplayName] = useState(editing?.displayName ?? '')
  const [secret, setSecret] = useState('')
  const [hosts, setHosts] = useState((editing?.destinations.hosts ?? builtin?.defaultHosts ?? []).join('\n'))
  const [paths, setPaths] = useState((editing?.destinations.pathPrefixes ?? []).join('\n'))
  const [models, setModels] = useState((editing?.destinations.models ?? []).join('\n'))
  const [allDepartments, setAllDepartments] = useState(editing?.audience.allDepartments ?? true)
  const [departmentIds, setDepartmentIds] = useState<string[]>(editing?.audience.departmentIds ?? [])
  const [everyone, setEveryone] = useState(editing?.audience.everyone ?? true)
  const [people, setPeople] = useState<Record<string, PersonChoice>>(() => {
    const out: Record<string, PersonChoice> = {}
    for (const u of editing?.audience.addUserIds ?? []) out[u] = 'add'
    for (const u of editing?.audience.removeUserIds ?? []) out[u] = 'remove'
    return out
  })
  const [caps, setCaps] = useState<Record<keyof BrokerCaps, string>>(() =>
    Object.fromEntries(CAP_KEYS.map((k) => [k, editing?.caps[k] != null ? String(editing.caps[k]) : ''])) as Record<keyof BrokerCaps, string>
  )
  const [allowPrivate, setAllowPrivate] = useState(editing?.allowPrivateContent ?? false)

  const chooseService = (value: string) => {
    setServiceChoice(value)
    const s = services.find((x) => x.service === value && (x.builtin || x.relay))
    if (!editing && s) setHosts(s.defaultHosts.join('\n'))
  }

  // Shown: what is written wrongly. Not shown, but blocking: what is still missing.
  const errors: string[] = []
  if (service && !isValidBrokerServiceName(service)) errors.push('サービス名は半角の小文字・数字・「-」「_」で書いてください')
  const secretCheck = editing || !secret ? null : checkBrokerSecret(secret)
  if (secretCheck && 'error' in secretCheck) errors.push('キーは8文字以上、空白なしで貼り付けてください')
  const badHosts = invalidHosts(relay ? relay.host : hosts)
  if (badHosts.length) errors.push(`送り先に使えない書き方があります: ${badHosts.join('、')}（「*」・IP アドレス・localhost・https:// やパスは書けません）`)
  const missing = !service || !displayName.trim() || (!editing && !secret.trim()) || hostsOf(relay ? relay.host : hosts).length === 0
    || (!allDepartments && departmentIds.length === 0)
  const badPaths = invalidPathPrefixes(paths)
  if (badPaths.length) errors.push(`パスに使えない書き方があります: ${badPaths.join('、')}`)
  const badModels = invalidModels(models)
  if (badModels.length) errors.push(`モデル名に使えない書き方があります: ${badModels.join('、')}`)
  const capValues = Object.fromEntries(CAP_KEYS.map((k) => [k, capOf(caps[k])])) as Record<keyof BrokerCaps, number | null | undefined>
  if (CAP_KEYS.some((k) => capValues[k] === undefined)) errors.push('上限は 1 以上の整数で書いてください（空欄 = 上限なし）')

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (errors.length || missing) return
    onSubmit({
      service,
      displayName: displayName.trim(),
      secret: secret.trim(),
      destinations: { hosts: relay ? [relay.host] : hostsOf(hosts), pathPrefixes: pathPrefixesOf(paths), models: modelsOf(models) },
      audience: {
        allDepartments,
        departmentIds: allDepartments ? [] : departmentIds,
        everyone,
        // Under 全員 only removals mean anything; under 指定した人 only additions.
        addUserIds: everyone ? [] : Object.entries(people).filter(([, v]) => v === 'add').map(([u]) => u),
        removeUserIds: everyone ? Object.entries(people).filter(([, v]) => v === 'remove').map(([u]) => u) : [],
      },
      caps: capValues as BrokerCaps,
      allowPrivateContent: allowPrivate,
    })
  }

  return (
    <form onSubmit={submit} className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{editing ? 'API キーの設定を変更' : '会社の API キーを登録'}</DialogTitle>
        <DialogDescription>
          キーはサーバーで暗号化して保管し、登録したあとは誰にも（管理者にも）表示されません。AI には短い時間だけ使える通行証が渡されます。
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor={`${id}-service`}>サービス</Label>
          <select
            id={`${id}-service`}
            className="h-9 rounded-md border bg-transparent px-2 text-sm"
            value={serviceChoice}
            disabled={!!editing}
            onChange={(e) => chooseService(e.target.value)}
          >
            {services.map((s) => (
              <option key={s.service} value={s.service}>
                {s.label}
              </option>
            ))}
            {!editing && <option value={OTHER}>その他（名前を入力）</option>}
          </select>
          {serviceChoice === OTHER && (
            <Input aria-label="サービス名" placeholder="例: hubspot" value={customService} onChange={(e) => setCustomService(e.target.value)} />
          )}
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-name`}>名前</Label>
          <Input id={`${id}-name`} placeholder="例: 営業部の Gemini" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
      </div>

      {!editing && (
        <div className="grid gap-2">
          <Label htmlFor={`${id}-secret`}>キー</Label>
          <Input
            id={`${id}-secret`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">発行元の画面からコピーして貼り付けます。保存後は末尾4文字だけが表示されます。</p>
        </div>
      )}

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">送ってよい宛先</legend>
        <Textarea aria-label="送ってよいホスト" className="min-h-16 font-mono" readOnly={!!relay} value={relay ? relay.host : hosts} onChange={(e) => setHosts(e.target.value)} />
        <p className="text-xs text-muted-foreground">
          {relay
            ? `このサービスの送り先は、登録したときの ${relay.host} に決まっています（「登録したサービス」で変えられます）。`
            : '1行に1つ、ホスト名をそのまま書きます（例: generativelanguage.googleapis.com）。'}
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Textarea aria-label="使ってよいパス" placeholder="パスを絞る場合（例: /v1beta/models/）" className="min-h-16 font-mono" value={paths} onChange={(e) => setPaths(e.target.value)} />
          <Textarea aria-label="使ってよいモデル" placeholder="モデルを絞る場合（例: gemini-2.5-flash）" className="min-h-16 font-mono" value={models} onChange={(e) => setModels(e.target.value)} />
        </div>
      </fieldset>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">どの部署の仕事で使えるか</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={`${id}-work`} checked={allDepartments} onChange={() => setAllDepartments(true)} />
            全社
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={`${id}-work`} checked={!allDepartments} onChange={() => setAllDepartments(false)} />
            選んだ部署だけ
          </label>
        </div>
        {!allDepartments && (
          <div className="flex flex-wrap gap-x-4 gap-y-1" role="group" aria-label="使える部署">
            {view.departments.map((d) => (
              <label key={d.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={departmentIds.includes(d.id)}
                  onChange={(e) => setDepartmentIds((ids) => (e.target.checked ? [...ids, d.id] : ids.filter((x) => x !== d.id)))}
                />
                {d.name}
              </label>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          AI への相談がどの部署のフォルダで行われているかで決まります。部署を選ぶと、それ以外の部署や部署の外での相談では使えません。
        </p>
      </fieldset>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">使える人</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={`${id}-who`} checked={everyone} onChange={() => setEveryone(true)} />
            全員
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name={`${id}-who`} checked={!everyone} onChange={() => setEveryone(false)} />
            指定した人だけ
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          {everyone ? '使わせたくない人だけ「使えない」にします。' : '使ってよい人を「使える」にします。'}
        </p>
        <ul className="divide-y rounded-md border">
          {members.map((m) => {
            const name = m.name || m.email || '名前未設定'
            const choice = people[m.userId] ?? 'follow'
            const value = everyone ? (choice === 'remove' ? 'remove' : 'follow') : choice === 'add' ? 'add' : 'follow'
            return (
              <li key={m.userId} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <select
                  aria-label={`${name}の扱い`}
                  className="h-8 rounded-md border bg-transparent px-2 text-sm"
                  value={value}
                  onChange={(e) => setPeople((p) => ({ ...p, [m.userId]: e.target.value as PersonChoice }))}
                >
                  {everyone ? (
                    <>
                      <option value="follow">使える</option>
                      <option value="remove">使えない（除外）</option>
                    </>
                  ) : (
                    <>
                      <option value="follow">使えない</option>
                      <option value="add">使える</option>
                    </>
                  )}
                </select>
              </li>
            )
          })}
        </ul>
      </fieldset>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">1日の上限（空欄 = 上限なし）</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {CAP_KEYS.map((k) => (
            <label key={k} className="grid gap-1 text-xs text-muted-foreground">
              {CAP_LABELS[k]}
              <Input inputMode="numeric" aria-label={CAP_LABELS[k]} value={caps[k]} onChange={(e) => setCaps((c) => ({ ...c, [k]: e.target.value }))} />
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={allowPrivate} onChange={(e) => setAllowPrivate(e.target.checked)} />
        <span>
          非公開の内容を送ってよい
          <span className="block text-xs text-muted-foreground">オンにすると、非公開フォルダの内容をこのサービスに送るときの確認を省きます。</span>
        </span>
      </label>

      {errors.length > 0 && (
        <ul className="text-sm text-destructive" role="alert">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          キャンセル
        </Button>
        <Button type="submit" disabled={busy || missing || errors.length > 0}>
          {busy ? '保存しています…' : editing ? '保存' : '登録'}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** The create body from the form (the value is sent once, here). */
export function createBody(v: KeyFormValues): BrokerKeyCreate {
  return {
    service: v.service,
    displayName: v.displayName,
    secret: v.secret,
    destinations: v.destinations,
    audience: v.audience,
    caps: v.caps,
    allowPrivateContent: v.allowPrivateContent,
  }
}
