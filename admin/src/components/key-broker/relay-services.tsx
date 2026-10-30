'use client'

// 「登録したサービス」 on the 「API キー」 page (K9): a header-type API the
// company names once — where its requests go and how the key travels — so
// skills can use it through the key broker without any code. The host is
// fixed here; keys registered for the service can only go there.
import { useId, useState } from 'react'
import { Plugs, Plus } from '@phosphor-icons/react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { BrokerRelayServiceSave, BrokerServiceCategory, BrokerServiceView, BrokerView } from '@/lib/api'
import {
  BROKER_KEY_SLOT,
  CATEGORY_HELP,
  CATEGORY_LABELS,
  brokerServiceEnvNames,
  relayBaseUrl,
  relayDraftComplete,
  relayDraftErrors,
  type RelayDraft,
} from '@/lib/key-broker'

/** The usual ways an API wants its key (header and value shape). */
const PRESETS: Array<{ id: string; label: string; header: string; format: string }> = [
  { id: 'bearer', label: 'Authorization: Bearer キー', header: 'authorization', format: `Bearer ${BROKER_KEY_SLOT}` },
  { id: 'x-api-key', label: 'X-API-Key: キー', header: 'x-api-key', format: BROKER_KEY_SLOT },
  { id: 'custom', label: 'その他（ヘッダ名と値の形を書く）', header: '', format: BROKER_KEY_SLOT },
]

type Editing = { kind: 'new' } | { kind: 'edit'; service: BrokerServiceView } | { kind: 'remove'; service: BrokerServiceView } | null

export function RelayServicesCard({
  view,
  busy,
  onSave,
  onRemove,
}: {
  view: BrokerView
  busy: boolean
  /** Resolves true when saved (the dialog then closes). */
  onSave: (service: string, definition: BrokerRelayServiceSave) => Promise<boolean>
  onRemove: (service: string) => Promise<boolean>
}) {
  const [editing, setEditing] = useState<Editing>(null)
  const registered = view.services.filter((s) => s.relay)
  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <Plugs size={16} />
              登録したサービス
            </CardTitle>
            <CardDescription>
              Gemini・OpenAI・Anthropic 以外の API も、送り先と「鍵をどのヘッダに入れるか」を登録すれば、ACB を通して使えます（プログラムの追加は要りません）。
              送り先はここで決まり、AI やスクリプトが変えることはできません。
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing({ kind: 'new' })}>
            <Plus size={14} />
            サービスを登録
          </Button>
        </div>
      </CardHeader>
      <div className="border-t px-5 py-2">
        {registered.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">まだ登録されていません。</p>
        ) : (
          <ul className="divide-y">
            {registered.map((s) => {
              const env = brokerServiceEnvNames(s.service)
              const hasKeys = s.companyKeys + s.userKeys > 0
              return (
                <li key={s.service} className="space-y-1 py-3" aria-label={s.label}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{s.label}</span>
                    <Badge variant="outline">{s.service}</Badge>
                    <span className="text-xs text-muted-foreground">
                      会社の鍵 {s.companyKeys}・自分の鍵 {s.userKeys}
                    </span>
                  </div>
                  <dl className="grid gap-x-4 text-xs text-muted-foreground sm:grid-cols-[auto_1fr]">
                    <dt>送り先</dt>
                    <dd className="font-mono">{relayBaseUrl(s.relay!)}</dd>
                    <dt>鍵の渡し方</dt>
                    <dd className="font-mono">
                      {s.relay!.header}: {s.relay!.format.replace(BROKER_KEY_SLOT, '（キー）')}
                    </dd>
                    <dt>鍵の確かめ方</dt>
                    <dd>{s.relay!.checkPath ? <span className="font-mono">GET {s.relay!.checkPath}</span> : '登録のときには確かめません'}</dd>
                    <dt>スクリプトでの名前</dt>
                    <dd className="font-mono">
                      {env.baseUrl}・{env.key}
                    </dd>
                  </dl>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => setEditing({ kind: 'edit', service: s })}>
                      変更
                    </Button>
                    <Button variant="ghost" size="sm" className="text-destructive" disabled={busy || hasKeys} onClick={() => setEditing({ kind: 'remove', service: s })}>
                      削除
                    </Button>
                    {hasKeys && <span className="text-xs text-muted-foreground">鍵が登録されているあいだは、削除と送り先の変更はできません。</span>}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <Dialog open={editing?.kind === 'new' || editing?.kind === 'edit'} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          {(editing?.kind === 'new' || editing?.kind === 'edit') && (
            <RelayForm
              existing={editing.kind === 'edit' ? editing.service : undefined}
              taken={view.services.map((s) => s.service)}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSubmit={async (service, definition) => {
                if (await onSave(service, definition)) setEditing(null)
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={editing?.kind === 'remove'} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          {editing?.kind === 'remove' && (
            <>
              <DialogHeader>
                <DialogTitle>「{editing.service.label}」を削除しますか？</DialogTitle>
                <DialogDescription>このサービスは ACB を通して使えなくなります。あとで同じ名前で登録し直せます。</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setEditing(null)} disabled={busy}>
                  キャンセル
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={async () => {
                    if (await onRemove(editing.service.service)) setEditing(null)
                  }}
                >
                  削除
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function presetOf(header: string, format: string): string {
  return PRESETS.find((p) => p.id !== 'custom' && p.header === header && p.format === format)?.id ?? 'custom'
}

export function RelayForm({
  existing,
  taken,
  busy,
  onSubmit,
  onCancel,
}: {
  existing?: BrokerServiceView
  /** Service names already in use (a new service cannot take one). */
  taken: string[]
  busy: boolean
  onSubmit: (service: string, definition: BrokerRelayServiceSave) => void
  onCancel: () => void
}) {
  const id = useId()
  const relay = existing?.relay ?? null
  const [service, setService] = useState(existing?.service ?? '')
  const [label, setLabel] = useState(relay?.label ?? '')
  const [baseUrl, setBaseUrl] = useState(relay ? relayBaseUrl(relay) : 'https://')
  const [preset, setPreset] = useState(relay ? presetOf(relay.header, relay.format) : 'bearer')
  const [header, setHeader] = useState(relay?.header ?? '')
  const [format, setFormat] = useState(relay?.format ?? BROKER_KEY_SLOT)
  const [category, setCategory] = useState<BrokerServiceCategory>(existing?.category ?? 'tool')
  const [checkPath, setCheckPath] = useState(relay?.checkPath ?? '')
  const chosen = PRESETS.find((p) => p.id === preset)!
  const draft: RelayDraft = {
    service: service.trim(),
    label,
    baseUrl: baseUrl === 'https://' ? '' : baseUrl,
    header: preset === 'custom' ? header : chosen.header,
    format: preset === 'custom' ? format : chosen.format,
    checkPath,
  }
  const errors = relayDraftErrors(draft, { existing: !!existing })
  if (!existing && draft.service && taken.includes(draft.service)) errors.push('この名前のサービスはもうあります。別の名前にしてください。')
  const hostLocked = !!existing && existing.companyKeys + existing.userKeys > 0

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (errors.length || !relayDraftComplete(draft)) return
        onSubmit(draft.service, {
          label: draft.label.trim(),
          baseUrl: draft.baseUrl.trim(),
          header: draft.header.trim(),
          format: draft.format.trim(),
          // Left out = none (the definition is replaced whole, so clearing the field removes it).
          ...(checkPath.trim() ? { checkPath: checkPath.trim() } : {}),
          ...(existing ? {} : { category }),
        })
      }}
    >
      <DialogHeader>
        <DialogTitle>{existing ? `「${existing.label}」を変更` : 'サービスを登録'}</DialogTitle>
        <DialogDescription>
          API の説明書にある「ベース URL」と「API キーの渡し方（ヘッダ）」を写します。キーそのものは、登録のあと「API キーを登録」で預けます。
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor={`${id}-service`}>サービス名（英字）</Label>
          <Input id={`${id}-service`} placeholder="例: crm" value={service} disabled={!!existing} onChange={(e) => setService(e.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-label`}>表示名</Label>
          <Input id={`${id}-label`} placeholder="例: 顧客管理" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-url`}>送り先（ベース URL）</Label>
        <Input id={`${id}-url`} className="font-mono" placeholder="https://api.example.com/v2" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        <p className="text-xs text-muted-foreground">
          {hostLocked ? '鍵が登録されているので、ホスト名は変えられません（パスは変えられます）。' : 'このホストにだけ送ります。https だけが使えます。'}
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-preset`}>鍵の渡し方</Label>
        <select id={`${id}-preset`} className="h-9 rounded-md border bg-transparent px-2 text-sm" value={preset} onChange={(e) => setPreset(e.target.value)}>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        {preset === 'custom' && (
          <div className="grid gap-2 sm:grid-cols-2">
            <Input aria-label="鍵を入れるヘッダの名前" className="font-mono" placeholder="例: X-ChatWorkToken" value={header} onChange={(e) => setHeader(e.target.value)} />
            <Input aria-label="値の形" className="font-mono" placeholder="例: Token token={key}" value={format} onChange={(e) => setFormat(e.target.value)} />
          </div>
        )}
        <p className="text-xs text-muted-foreground">「{BROKER_KEY_SLOT}」のところに、ACB が預かったキーを入れて送ります。AI には見えません。</p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-check`}>鍵を確かめる住所（なくてもよい）</Label>
        <Input id={`${id}-check`} className="font-mono" placeholder="例: /me" value={checkPath} onChange={(e) => setCheckPath(e.target.value)} />
        <p className="text-xs text-muted-foreground">
          鍵を登録したときに、この住所へ1回だけ読み取りの問い合わせ（GET）をして、使える鍵か確かめます。料金がかからず、何も変更しない住所を書いてください（説明書の「自分の情報を見る」などのもの）。書かないときは、実際に使うまで確かめられません。
        </p>
      </div>
      {!existing && (
        <div className="grid gap-2">
          <Label htmlFor={`${id}-category`}>種類</Label>
          <select id={`${id}-category`} className="h-9 rounded-md border bg-transparent px-2 text-sm" value={category} onChange={(e) => setCategory(e.target.value as BrokerServiceCategory)}>
            {(Object.keys(CATEGORY_LABELS) as BrokerServiceCategory[]).map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">{CATEGORY_HELP[category]}</p>
        </div>
      )}
      {errors.length > 0 && (
        <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-destructive">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          キャンセル
        </Button>
        <Button type="submit" disabled={busy || errors.length > 0 || !relayDraftComplete(draft)}>
          {existing ? '保存' : '登録'}
        </Button>
      </DialogFooter>
    </form>
  )
}
