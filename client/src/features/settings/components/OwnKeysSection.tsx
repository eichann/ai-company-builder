// Settings → 「自分の鍵」: which services the AI may use, with which key, and
// the member's own keys (register / replace / delete). A key is typed into a
// password field, sent once and never shown again — only its last 4.
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import type { UnsavedChanges } from '../../../shared/lib/unsavedChanges'
import { SpinnerGap } from '@phosphor-icons/react'
import { Button, Callout, Card, SectionHeader, StatusBadge, type StatusBadgeVariant } from '../../../shared/ui/primitives'
import type { MyBrokerService } from '../../../../shared/broker-keys'
import { useOwnKeys } from '../hooks/useOwnKeys'
import { ownKeyRow, type OwnKeyTone } from '../own-keys'

const INPUT = 'h-9 w-full rounded-control border border-zinc-200 bg-white px-3 font-mono text-body text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-100 dark:placeholder:text-zinc-500'
const TONE: Record<OwnKeyTone, StatusBadgeVariant> = { ok: 'success', warn: 'warning', paused: 'paused', none: 'neutral' }

/** `unsavedRef`: the settings ask before closing while a typed key is not saved (the key itself is never kept elsewhere). */
export function OwnKeysSection({ companyId, focusService, unsavedRef }: { companyId: string; focusService?: string; unsavedRef?: Ref<UnsavedChanges> }) {
  const { data, error, loading, busy, save, remove } = useOwnKeys(companyId)
  // Each service's typed key until it is saved (memory only; gone when the settings close).
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const typed = Object.entries(secrets).filter(([, v]) => v.trim())
  const setSecret = (service: string, value: string) => setSecrets(prev => ({ ...prev, [service]: value }))
  useImperativeHandle(unsavedRef, () => ({
    pending: () => typed.length === 0 ? null
      : `自分の鍵（${typed.map(([service]) => data?.services.find(x => x.service === service)?.label ?? service).join('、')}）の入力`,
    save: async () => {
      for (const [service, secret] of typed) {
        const result = await save(service, secret)
        if ('error' in result) return result.error
        setSecret(service, '')
      }
      return null
    },
  }))

  return (
    <div className="space-y-5 px-8 pb-8 pt-7">
      <SectionHeader
        title="自分の鍵"
        description="AI が Skill の中で外部サービス（Gemini・OpenAI など）を使うときの鍵です。鍵は会社のサーバーで暗号化して預かり、このPCにも AI にも渡しません。AI には短い時間だけ使える通行証が渡されます。"
      />
      {loading && !data ? (
        <div className="flex items-center gap-2 py-10 text-body text-zinc-500"><SpinnerGap size={16} className="animate-spin" />読み込み中…</div>
      ) : error && !data ? (
        <Callout tone="danger" role="alert">{error}</Callout>
      ) : data ? (
        <>
          {!data.enabled && (
            <Callout tone="warning" title="サーバーで鍵を預かる機能が、まだ使えるようになっていません">
              管理者がサーバーの設定を済ませると、ここから鍵を登録できるようになります。
            </Callout>
          )}
          {data.enabled && !data.memberKeysAllowed && (
            <Callout tone="info">この会社では、メンバーが自分の鍵を登録することは許可されていません。会社の鍵が使えるサービスは、そのまま使えます。</Callout>
          )}
          <Card className="divide-y divide-zinc-100 dark:divide-white/[0.06]">
            {data.services.map(s => (
              <ServiceRow key={s.service} s={s} secret={secrets[s.service] ?? ''} onSecret={v => setSecret(s.service, v)} enabled={data.enabled} busy={busy === s.service} focused={s.service === focusService} onSave={save} onRemove={remove} />
            ))}
          </Card>
        </>
      ) : null}
    </div>
  )
}

function ServiceRow({ s, secret, onSecret, enabled, busy, focused, onSave, onRemove }: {
  s: MyBrokerService
  /** The key typed here, held by the section so the settings can ask before it is lost. */
  secret: string
  onSecret: (value: string) => void
  enabled: boolean
  busy: boolean
  /** Opened from the chat's "no key" card for this service: shown, and its form open when one can register. */
  focused: boolean
  onSave: (service: string, secret: string, displayName?: string) => Promise<{ error: string } | { checked: string | null }>
  onRemove: (service: string) => Promise<string | null>
}) {
  const row = ownKeyRow(s)
  const [open, setOpen] = useState(focused && enabled && row.canRegister)
  const [message, setMessage] = useState<string | null>(null)
  const [checked, setChecked] = useState<string | null>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const inputId = `own-key-${s.service}`

  useEffect(() => {
    if (!focused) return
    sectionRef.current?.scrollIntoView({ block: 'center' })
    document.getElementById(inputId)?.focus()
  }, [focused, inputId])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!secret.trim()) return
    const result = await onSave(s.service, secret)
    if ('error' in result) { setMessage(result.error); setChecked(null); return }
    onSecret('')
    setOpen(false)
    setMessage(null)
    setChecked(result.checked)
  }

  return (
    <section ref={sectionRef} className={`space-y-2 p-5 ${focused ? 'bg-indigo-50/60 dark:bg-indigo-500/[0.06]' : ''}`} aria-label={s.label}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-medium">{s.label}</span>
        <StatusBadge variant={TONE[row.tone]}>{row.status}</StatusBadge>
        <span className="ml-auto flex gap-2">
          {enabled && row.canRegister && !open && (
            <Button size="sm" onClick={() => { setOpen(true); setMessage(null) }} disabled={busy}>
              {s.key ? '鍵を差し替える' : '自分の鍵を登録'}
            </Button>
          )}
          {s.key && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={async () => { setChecked(null); setMessage(await onRemove(s.service)) }}>
              削除
            </Button>
          )}
        </span>
      </div>
      {row.detail && <p className="text-small text-zinc-500 dark:text-zinc-400">{row.detail}</p>}
      {s.ownKey.allowed && <p className="text-caption font-normal text-zinc-400">送り先: <span className="font-mono">{s.ownKey.hosts.join('、')}</span></p>}
      {open && (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2 pt-1">
          <label htmlFor={inputId} className="grid min-w-64 flex-1 gap-1 text-small text-zinc-500">
            鍵（発行元の画面からコピーして貼り付け）
            <input id={inputId} className={INPUT} type="password" autoComplete="off" spellCheck={false} value={secret} onChange={e => onSecret(e.target.value)} />
          </label>
          <Button size="sm" variant="primary" type="submit" disabled={busy || !secret.trim()}>{busy ? '保存しています…' : '保存'}</Button>
          <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => { setOpen(false); onSecret('') }}>やめる</Button>
        </form>
      )}
      {open && secret.trim() && <p className="text-small text-warning-text">まだ保存していません。</p>}
      {message && <p role="alert" className="text-small text-red-600 dark:text-red-400">{message}</p>}
      {checked && <p role="status" className="text-small text-zinc-600 dark:text-zinc-300">{checked}</p>}
    </section>
  )
}
