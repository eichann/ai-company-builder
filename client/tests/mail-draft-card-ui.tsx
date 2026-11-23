/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the chat's mail card (outbound-mail.md): a reply whose data parts are mail
// drafts the AI made. The fake main answers a send with `sent` and writes the hash and the
// 「返事を待つ」 choice it received into lines of their own, so the spec can check what the send carried.
// `?manual=1`: the user manual's story (client/tests/manual/scenes.ts, chapter 30): 山田さん of 検証A社 and the mails
// after the meeting with A社 — the thank-you (the calendar's attendee, 返事を待つ offered), the proposal with two PDFs,
// a second thank-you 高橋さん already sent, one nobody knows arrived, and a Slack reply. Fictional data only.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { UIMessage } from 'ai'
import '../src/i18n'
import '../src/index.css'
import { AssistantMessageParts } from '../src/features/chat/components/MessageParts'
import { useAppStore } from '../src/stores/appStore'
import { MAIL_DRAFT_PART_TYPE, type MailDraftCard } from '../shared/outbound-mail'
import type { OutboundMailView } from '../../shared/types/outbound-mail'
import { installElectronAPI } from './ui/fixtures/electron-api'

useAppStore.setState({ currentCompany: { id: 'co-preview', name: 'プレビュー株式会社', rootPath: '/preview', departments: [], createdAt: new Date() } })

const SHOWN_HASH = `sha256:${'a1'.repeat(32)}`
const draft: OutboundMailView = {
  id: 'outbound_message-0123456789abcdef', state: 'draft', version: 2, hash: SHOWN_HASH, channel: 'email', interactionId: null, from: 'sato@div.example',
  to: [
    { ref: `r${'1'.repeat(24)}`, email: 'suzuki@a-corp.example', name: '鈴木 一郎', source: 'calendar', firstTime: true },
    { ref: `r${'2'.repeat(24)}`, email: 'yamaguchi@a-corp.example', name: '山口 花子', source: 'hubspot', firstTime: true },
  ],
  cc: [
    { ref: `r${'3'.repeat(24)}`, email: 'tanaka@div.example', name: '田中', source: 'member', firstTime: false },
    { ref: `r${'4'.repeat(24)}`, email: 'partner@third.example', name: null, source: 'typed', firstTime: true },
  ],
  subject: '本日はありがとうございました', body: '鈴木様\n\n本日はありがとうございました。\n資料: https://example.com/doc\n',
  bodyDeleted: false, linkCount: 1, meetingId: 'meeting-0123456789abcdef', bundleId: null, sentAt: null, providerMessageId: null,
  lastChangedBy: 'ai', updatedAt: '2026-11-05T06:50:00Z',
  // A draft made before the AI marked drafts: 「返事を待つ」 is offered, unticked.
  awaitReply: { expected: false, defaultUntil: '2099-01-07', chosenUntil: null },
}
const card: MailDraftCard = { id: 'card-1', companyId: 'co-preview', conversationId: 'conv-1', draft, byAi: true, at: '2026-11-05T06:50:00Z' }
// A new mail the AI marked as needing their answer: pre-ticked.
const asking: OutboundMailView = {
  ...draft, id: 'outbound_message-fedcba9876543210', subject: 'お見積りのご送付', body: '鈴木様\n\nお見積りをお送りします。ご確認のうえ、ご都合をお知らせください。\n',
  linkCount: 0, cc: [], to: [draft.to[0]], awaitReply: { expected: true, defaultUntil: '2099-01-07', chosenUntil: null },
}
const askingCard: MailDraftCard = { ...card, id: 'card-2', draft: asking }
// A proposal with two PDFs the AI attached (outbound-mail.md "Attachments").
const PROPOSAL = 'c'.repeat(64)
const ESTIMATE = 'd'.repeat(64)
const withFiles: OutboundMailView = {
  ...draft, id: 'outbound_message-0a1b2c3d4e5f6789', subject: '提案書のご送付', body: '鈴木様\n\n提案書をお送りします。\n', linkCount: 0, cc: [], to: [draft.to[0]],
  version: 3, hash: `sha256:${'f0'.repeat(32)}`, awaitReply: undefined,
  attachments: [
    { name: '提案書（株式会社サンプル様）.pdf', size: 1_250_000, sha256: PROPOSAL, bytesDeleted: false },
    { name: '別紙_見積.pdf', size: 52_000, sha256: ESTIMATE, bytesDeleted: false },
  ],
}
const filesCard: MailDraftCard = { ...card, id: 'card-3', draft: withFiles }
const afterRemoval: OutboundMailView = { ...withFiles, version: 4, hash: `sha256:${'f1'.repeat(32)}`, attachments: [withFiles.attachments![0]] }
// A colleague already sent this meeting's thank-you (outbound-mail.md "One send per source").
const second: OutboundMailView = { ...draft, id: 'outbound_message-5e5e5e5e5e5e5e5e', subject: '商談のお礼（2通目）', cc: [], to: [draft.to[0]], linkCount: 0, awaitReply: undefined }
const secondCard: MailDraftCard = { ...card, id: 'card-4', draft: second }
const EARLIER = {
  messageId: 'outbound_message-0f0f0f0f0f0f0f0f', by: 'm-sato', byName: '佐藤', at: '2026-11-05T06:30:00Z', kind: 'meeting' as const,
  message: 'この会議のお礼メールは佐藤さんが 11/05 15:30 に送りました',
}

const MANUAL = new URLSearchParams(location.search).get('manual') === '1'
const r = (n: string) => `r${n.repeat(24)}`
const TAMURA = { ref: r('5'), email: 'tamura@a-sha.example', name: '田村 様', source: 'calendar' as const, firstTime: false }
const mDraft: OutboundMailView = {
  id: 'outbound_message-a1a1a1a1a1a1a1a1', state: 'draft', version: 1, hash: `sha256:${'b1'.repeat(32)}`, channel: 'email', interactionId: null, from: 'yamada@kensho-a.example',
  to: [TAMURA], cc: [{ ref: r('6'), email: 'takahashi@kensho-a.example', name: '高橋', source: 'member', firstTime: false }],
  subject: '本日の打ち合わせのお礼', body: 'A社 田村様\n\n本日はお時間をいただき、ありがとうございました。\nご相談いただいた研修の進め方は、来週中に見積とあわせてお送りします。\n\n引き続きよろしくお願いいたします。\n\n検証A社 営業部 山田\n',
  bodyDeleted: false, linkCount: 0, meetingId: 'meeting-a1a1a1a1a1a1a1a1', bundleId: null, sentAt: null, providerMessageId: null,
  lastChangedBy: 'ai', updatedAt: '2026-11-20T01:10:00Z', awaitReply: { expected: true, defaultUntil: '2026-11-25', chosenUntil: null },
}
const mFiles: OutboundMailView = {
  ...mDraft, id: 'outbound_message-a2a2a2a2a2a2a2a2', hash: `sha256:${'b2'.repeat(32)}`, subject: '研修のご提案書をお送りします', meetingId: null,
  body: 'A社 田村様\n\n先日お話しした研修のご提案書と見積をお送りします。\nご確認のうえ、ご不明な点があればお知らせください。\n\n検証A社 営業部 山田\n', cc: [], awaitReply: undefined,
  attachments: [
    { name: '提案書（A社様）.pdf', size: 1_250_000, sha256: 'e'.repeat(64), bytesDeleted: false },
    { name: '別紙_見積.pdf', size: 52_000, sha256: 'f'.repeat(64), bytesDeleted: false },
  ],
}
const mSecond: OutboundMailView = { ...mDraft, id: 'outbound_message-a3a3a3a3a3a3a3a3', hash: `sha256:${'b3'.repeat(32)}`, subject: '打ち合わせのお礼（山田より）', cc: [], awaitReply: undefined }
const mUnknown: OutboundMailView = { ...mDraft, id: 'outbound_message-a4a4a4a4a4a4a4a4', state: 'unknown', subject: '日程のご連絡', body: 'A社 田村様\n\n次回の打ち合わせは 12月1日（月）10時からでお願いいたします。\n\n検証A社 営業部 山田\n', cc: [], awaitReply: undefined, lastChangedBy: 'human' }
const mSlack: OutboundMailView = {
  ...mDraft, id: 'outbound_message-a5a5a5a5a5a5a5a5', channel: 'slack', subject: '', to: [], cc: [], interactionId: 'interaction-a5a5a5a5a5a5a5a5', meetingId: null, awaitReply: undefined,
  body: '佐藤さん、ありがとうございます。A社の件は今日中に見積の案をお送りします。',
}
const mCard = (id: string, draft: OutboundMailView): MailDraftCard => ({ id, companyId: 'co-preview', conversationId: 'conv-1', draft, byAi: true, at: '2026-11-20T01:10:00Z' })
const M_EARLIER = {
  messageId: 'outbound_message-0e0e0e0e0e0e0e0e', by: 'u-takahashi', byName: '高橋', at: '2026-11-20T01:05:00Z', kind: 'meeting' as const,
  message: 'この会議のお礼メールは高橋さんが 11/20 10:05 に送りました',
}
const manualMessage: UIMessage = {
  id: 'm', role: 'assistant',
  parts: [
    { type: 'text', text: '打ち合わせのお礼メールの下書きを作りました。まだ送っていません。' }, { type: MAIL_DRAFT_PART_TYPE, id: 'mail-draft-manual-1', data: mCard('card-m1', mDraft) },
    { type: 'text', text: '提案書と見積を付けたメールです。' }, { type: MAIL_DRAFT_PART_TYPE, id: 'mail-draft-manual-2', data: mCard('card-m2', mFiles) },
    { type: 'text', text: 'お礼メールをもう1通作りました。' }, { type: MAIL_DRAFT_PART_TYPE, id: 'mail-draft-manual-3', data: mCard('card-m3', mSecond) },
    { type: 'text', text: '先ほどのメールです。' }, { type: MAIL_DRAFT_PART_TYPE, id: 'mail-draft-manual-4', data: mCard('card-m4', mUnknown) },
    { type: 'text', text: 'Slack の返事の下書きです。' }, { type: MAIL_DRAFT_PART_TYPE, id: 'mail-draft-manual-5', data: mCard('card-m5', mSlack) },
  ] as UIMessage['parts'],
}
const manualRecipients = [TAMURA, mDraft.cc[0], { ref: r('7'), email: 'suzuki@a-sha.example', name: '鈴木 様', source: 'calendar' as const, firstTime: false }]

let report: (hash: string, awaitReply: string, shown?: string, reason?: string) => void = () => {}
let opened: (sha256: string) => void = () => {}
if (MANUAL) installElectronAPI({
  getOutboundMailRecipients: async (_companyId, messageId) => ({ success: true, draft: messageId === mDraft.id ? mDraft : mSecond, recipients: { recipients: manualRecipients, unreadable: [] } }),
  openOutboundMailAttachment: async () => ({ success: true }),
  sendOutboundMail: async (_companyId, messageId, _hash, _awaitReply, _shown, resendReason) => (messageId === mSecond.id && !resendReason
    ? { success: false, offline: false, code: 'ALREADY_SENT_FOR_SOURCE', error: M_EARLIER.message, alreadySent: M_EARLIER }
    : { success: true, outcome: 'sent', draft: { ...mDraft, state: 'sent', sentAt: '2026-11-20T01:30:00Z', providerMessageId: 'gm-m' } }),
})
else installElectronAPI({
  openOutboundMailAttachment: async (_companyId, _messageId, sha256) => { opened(sha256); return { success: true } },
  removeOutboundMailAttachment: async (_companyId, _messageId, sha256, expectedVersion) => (
    sha256 === ESTIMATE && expectedVersion === withFiles.version
      ? { success: true, draft: afterRemoval }
      : { success: false, offline: false, code: 'VERSION_CONFLICT', error: 'ほかの変更が先にありました。' }),
  sendOutboundMail: async (_companyId, messageId, hash, awaitReply, attachmentsShown, resendReason) => {
    report(hash, JSON.stringify(awaitReply ?? null), JSON.stringify(attachmentsShown ?? null), resendReason ?? undefined)
    if (messageId === second.id && !resendReason) {
      return { success: false, offline: false, code: 'ALREADY_SENT_FOR_SOURCE', error: `${EARLIER.message}。それでも送るときは、アプリを新しくしてから…`, alreadySent: EARLIER }
    }
    if (messageId === second.id) return { success: true, outcome: 'sent', draft: { ...second, state: 'sent', sentAt: '2026-11-05T06:52:00Z', providerMessageId: 'gm-3' } }
    if (messageId === withFiles.id) return { success: true, outcome: 'sent', draft: { ...afterRemoval, state: 'sent', sentAt: '2026-11-05T06:52:00Z', providerMessageId: 'gm-2' } }
    const shown = messageId === asking.id ? asking : draft
    return {
      success: true, outcome: 'sent',
      draft: { ...shown, state: 'sent', sentAt: '2026-11-05T06:52:00Z', providerMessageId: 'gm-1', awaitReply: { ...shown.awaitReply!, chosenUntil: awaitReply?.until ?? null } },
    }
  },
})

const message: UIMessage = {
  id: 'm', role: 'assistant',
  parts: [
    { type: 'text', text: 'お礼メールの下書きを作りました。' }, { type: MAIL_DRAFT_PART_TYPE, id: 'mail-draft-card-1', data: card },
    { type: 'text', text: 'お見積りのメールも用意しました。' }, { type: MAIL_DRAFT_PART_TYPE, id: 'mail-draft-card-2', data: askingCard },
    { type: 'text', text: '提案書を付けたメールです。' }, { type: MAIL_DRAFT_PART_TYPE, id: 'mail-draft-card-3', data: filesCard },
    { type: 'text', text: 'お礼メールをもう1通作りました。' }, { type: MAIL_DRAFT_PART_TYPE, id: 'mail-draft-card-4', data: secondCard },
  ] as UIMessage['parts'],
}

// `?theme=dark` for dark mode (the primary-action spec reads the buttons in both themes).
if (new URLSearchParams(location.search).get('theme') === 'dark') document.documentElement.classList.add('dark')

function Preview() {
  const [received, setReceived] = useState<string | null>(null)
  const [awaited, setAwaited] = useState<string | null>(null)
  const [files, setFiles] = useState<string | null>(null)
  const [openedFile, setOpenedFile] = useState<string | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  report = (hash, awaitReply, shown, why) => { setReceived(hash); setAwaited(awaitReply); setFiles(shown ?? null); setReason(why ?? null) }
  opened = setOpenedFile
  return (
    <main className="min-h-screen bg-white p-8 text-gray-900 dark:bg-zinc-900 dark:text-zinc-100">
      <p className="mb-4 text-xs text-gray-500">表示確認用の人工データ。本番のメールは送りません。</p>
      <section className="mx-auto max-w-xl"><AssistantMessageParts parts={(MANUAL ? manualMessage : message).parts} isStreaming={false} markdown /></section>
      {received !== null && <p aria-label="受け取った印">{received}</p>}
      {awaited !== null && <p aria-label="受け取った返事待ち">{awaited}</p>}
      {files !== null && <p aria-label="受け取ったファイル">{files}</p>}
      {openedFile !== null && <p aria-label="開いたファイル">{openedFile}</p>}
      {reason !== null && <p aria-label="受け取った理由">{reason}</p>}

    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
