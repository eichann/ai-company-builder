// The mail card keeps its view / edit / confirm steps in one component: they share the draft
// shown and the hash the send carries, and splitting them would pass that state around.
import { memo, useState } from 'react'
import { CheckCircle, EnvelopeSimple, LinkSimple, Robot, Warning } from '@phosphor-icons/react'
import {
  MAIL_STATE_LABELS, MAIL_WORDS, recipientLine, type MailDraftCard as Card, type OutboundMailResult,
} from '../../../../shared/outbound-mail'
import type { MailRecipientView, OutboundMailView } from '../../../../../shared/types/outbound-mail'
import { mailOutbound, type MailOutbound } from '../api'

type Step = 'view' | 'edit' | 'confirm'
interface Notice { tone: 'ok' | 'warn' | 'error'; text: string }

const NOTICE_CLASS = {
  ok: 'border-emerald-500/40 bg-emerald-500/5',
  warn: 'border-amber-500/40 bg-amber-500/5',
  error: 'border-red-500/40 bg-red-500/5',
} as const
const BUTTON = 'rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800'
const PRIMARY = 'rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50'

function RecipientList({ label, list }: { label: string; list: MailRecipientView[] }) {
  if (list.length === 0) return null
  return (
    <div className="mt-1 text-xs">
      <span className="text-gray-500 dark:text-zinc-400">{label}：</span>
      <ul aria-label={label} className="inline">
        {list.map(r => <li key={r.ref} className="ml-1 inline-block text-gray-800 dark:text-zinc-200">
          {recipientLine(r)}
          {r.firstTime && <span className="ml-1 rounded bg-amber-100 px-1 text-[11px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">{MAIL_WORDS.firstTime}</span>}
        </li>)}
      </ul>
    </div>
  )
}

/** From, To / CC with where each address came from, the subject and the whole body. */
function MailContent({ draft }: { draft: OutboundMailView }) {
  return (
    <div className="mt-2">
      <p className="text-xs"><span className="text-gray-500 dark:text-zinc-400">差出人：</span>{draft.from}</p>
      <RecipientList label="宛先" list={draft.to} />
      <RecipientList label="CC" list={draft.cc} />
      <p className="mt-1 text-xs"><span className="text-gray-500 dark:text-zinc-400">件名：</span><span className="font-medium">{draft.subject}</span></p>
      {draft.body !== null
        ? <pre aria-label="本文" className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-2 font-sans text-xs text-gray-800 dark:bg-zinc-900 dark:text-zinc-200">{draft.body}</pre>
        : <p className="mt-1 text-[11px] text-gray-500 dark:text-zinc-400">{MAIL_WORDS.bodyDeleted}</p>}
      {draft.linkCount > 0 && <p className="mt-1 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400"><LinkSimple size={12} aria-hidden />{MAIL_WORDS.links(draft.linkCount)}</p>}
    </div>
  )
}

/**
 * A mail draft the member's AI made (client/shared/outbound-mail.ts), drawn by the app. Every
 * button is the person's own, sent with their session; 「確かめて送る」 shows everything once more
 * and sends the hash of exactly what was shown, so a changed draft is never sent unseen.
 */
export const MailDraftCard = memo(function MailDraftCard({ card, outbound = mailOutbound() }: { card: Card; outbound?: MailOutbound }) {
  const [draft, setDraft] = useState(card.draft)
  const [step, setStep] = useState<Step>('view')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [needsConsent, setNeedsConsent] = useState(false)
  // Edit step.
  const [subject, setSubject] = useState(draft.subject)
  const [body, setBody] = useState(draft.body ?? '')
  const [choices, setChoices] = useState<MailRecipientView[]>([])
  const [to, setTo] = useState<string[]>([])
  const [cc, setCc] = useState<string[]>([])
  const [typed, setTyped] = useState('')

  const run = async (fn: () => Promise<OutboundMailResult>, onOk: (r: Extract<OutboundMailResult, { success: true }>) => void) => {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      const r = await fn()
      if (r.success) { onOk(r); return }
      if (r.draft) setDraft(r.draft)
      if (r.needsGoogleConsent === 'mail') setNeedsConsent(true)
      if (r.code === 'CONTENT_CHANGED') setStep('view')
      setNotice({ tone: r.offline ? 'warn' : 'error', text: r.error })
    } finally {
      setBusy(false)
    }
  }

  const startEdit = () => run(() => outbound.getOutboundMailRecipients(card.companyId, draft.id), r => {
    setChoices(r.recipients?.recipients ?? [])
    setTo(draft.to.map(x => x.ref))
    setCc(draft.cc.map(x => x.ref))
    setSubject(draft.subject)
    setBody(draft.body ?? '')
    setStep('edit')
  })
  const addTyped = () => run(() => outbound.addOutboundMailRecipient(card.companyId, draft.id, typed.trim()), r => {
    if (r.recipient) {
      const added = r.recipient
      setChoices(c => (c.some(x => x.ref === added.ref) ? c : [...c, added]))
      setTo(t => (t.includes(added.ref) ? t : [...t, added.ref]))
    }
    setTyped('')
  })
  const save = () => run(() => outbound.updateOutboundMail(card.companyId, draft.id, { expectedVersion: draft.version, toRefs: to, ccRefs: cc, subject, body }, card.conversationId ?? undefined), r => {
    setDraft(r.draft)
    setStep('view')
    setNotice({ tone: 'ok', text: '下書きを保存しました。' })
  })
  const send = () => run(() => outbound.sendOutboundMail(card.companyId, draft.id, draft.hash), r => {
    setDraft(r.draft)
    setStep('view')
    setNotice(r.outcome === 'unknown' ? { tone: 'warn', text: r.message ?? MAIL_WORDS.unknown } : { tone: 'ok', text: 'メールを送りました。' })
  })
  const resolve = (sent: boolean) => run(() => outbound.resolveOutboundMail(card.companyId, draft.id, sent), r => {
    setDraft(r.draft)
    setNotice(sent ? { tone: 'ok', text: '送られていたと記録しました。' } : { tone: 'ok', text: '下書きに戻しました。送るときは、もう一度「確かめて送る」を押してください。' })
  })
  const discard = () => run(() => outbound.discardOutboundMail(card.companyId, draft.id), r => setDraft(r.draft))
  const consent = async () => {
    setBusy(true)
    try {
      await outbound.connectGoogle(card.companyId, ['mail'])
      setNotice({ tone: 'warn', text: 'ブラウザで Google の画面を開きました。許可したら、もう一度「確かめて送る」を押してください。' })
      setNeedsConsent(false)
    } finally {
      setBusy(false)
    }
  }

  const toggle = (list: string[], set: (v: string[]) => void, ref: string) => set(list.includes(ref) ? list.filter(r => r !== ref) : [...list, ref])
  const heading = draft.state === 'draft' ? 'メールの下書き' : MAIL_STATE_LABELS[draft.state]

  return (
    <div role="group" aria-label={`メール：${draft.subject}`} data-state={draft.state} className="my-2 rounded-xl border border-gray-200 p-3 dark:border-zinc-700">
      <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-zinc-100">
        {draft.state === 'sent' ? <CheckCircle size={15} weight="bold" aria-hidden className="text-emerald-600" />
          : draft.state === 'unknown' ? <Warning size={15} weight="bold" aria-hidden className="text-amber-500" />
            : <EnvelopeSimple size={15} aria-hidden className="text-gray-500" />}
        {heading}
        {draft.lastChangedBy === 'ai' && <span className="ml-auto flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-normal text-gray-600 dark:bg-zinc-800 dark:text-zinc-300">
          <Robot size={12} aria-hidden />{MAIL_WORDS.byAi}
        </span>}
      </div>

      {step === 'edit' ? (
        <div className="mt-2 space-y-2 text-xs">
          <fieldset>
            <legend className="text-gray-500 dark:text-zinc-400">宛先・CC（確かめた宛先から選びます）</legend>
            <ul className="mt-1 space-y-1">
              {choices.map(r => <li key={r.ref} className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1"><input type="checkbox" checked={to.includes(r.ref)} onChange={() => toggle(to, setTo, r.ref)} />宛先</label>
                <label className="flex items-center gap-1"><input type="checkbox" checked={cc.includes(r.ref)} onChange={() => toggle(cc, setCc, r.ref)} />CC</label>
                <span>{recipientLine(r)}</span>
              </li>)}
            </ul>
            <div className="mt-1 flex gap-1">
              <input aria-label="宛先を入力" type="email" value={typed} onChange={e => setTyped(e.target.value)} placeholder="name@example.com"
                className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 dark:border-zinc-600 dark:bg-zinc-900" />
              <button type="button" className={BUTTON} disabled={busy || typed.trim() === ''} onClick={() => void addTyped()}>入力した宛先を足す</button>
            </div>
          </fieldset>
          <label className="block">件名<input value={subject} onChange={e => setSubject(e.target.value)} className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 dark:border-zinc-600 dark:bg-zinc-900" /></label>
          <label className="block">本文<textarea value={body} onChange={e => setBody(e.target.value)} rows={10} className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 font-sans dark:border-zinc-600 dark:bg-zinc-900" /></label>
          <div className="flex gap-2">
            <button type="button" className={PRIMARY} disabled={busy} onClick={() => void save()}>{MAIL_WORDS.save}</button>
            <button type="button" className={BUTTON} disabled={busy} onClick={() => setStep('view')}>やめる</button>
          </div>
        </div>
      ) : (
        <>
          {step === 'confirm' && <p className="mt-2 text-xs font-medium text-gray-900 dark:text-zinc-100">{MAIL_WORDS.confirmTitle}</p>}
          <MailContent draft={draft} />
        </>
      )}

      {notice && <div role="status" className={`mt-2 rounded-lg border px-2 py-1.5 text-xs ${NOTICE_CLASS[notice.tone]}`}>{notice.text}</div>}
      {draft.state === 'unknown' && !notice && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{MAIL_WORDS.unknown}</p>}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {needsConsent && <>
          <span className="text-xs text-gray-700 dark:text-zinc-300">{MAIL_WORDS.consentNote}</span>
          <button type="button" className={PRIMARY} disabled={busy} onClick={() => void consent()}>{MAIL_WORDS.consent}</button>
        </>}
        {draft.state === 'draft' && step === 'view' && <>
          <button type="button" className={PRIMARY} disabled={busy} onClick={() => { setNotice(null); setStep('confirm') }}>{MAIL_WORDS.sendButton}</button>
          <button type="button" className={BUTTON} disabled={busy} onClick={() => void startEdit()}>{MAIL_WORDS.edit}</button>
          <button type="button" className={BUTTON} disabled={busy} onClick={() => void discard()}>{MAIL_WORDS.discard}</button>
        </>}
        {draft.state === 'draft' && step === 'confirm' && <>
          <span className="w-full text-[11px] text-gray-600 dark:text-zinc-400">{MAIL_WORDS.confirmNote}</span>
          <button type="button" className={PRIMARY} disabled={busy} onClick={() => void send()}>{busy ? '送っています…' : MAIL_WORDS.confirmSend}</button>
          <button type="button" className={BUTTON} disabled={busy} onClick={() => setStep('view')}>やめる</button>
        </>}
        {draft.state === 'unknown' && <>
          <button type="button" className={BUTTON} disabled={busy} onClick={() => void resolve(true)}>{MAIL_WORDS.wasSent}</button>
          <button type="button" className={BUTTON} disabled={busy} onClick={() => void resolve(false)}>{MAIL_WORDS.wasNotSent}</button>
        </>}
      </div>
    </div>
  )
}, (prev, next) => prev.card.id === next.card.id)
