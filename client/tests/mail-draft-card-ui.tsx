/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the chat's mail card (outbound-mail.md): a reply whose data part is a mail
// draft the AI made. The fake main answers a send with `sent` and writes the hash it received
// into the 「受け取った印」 line, so the spec can check the send carried the hash shown.
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
  id: 'outbound_message-0123456789abcdef', state: 'draft', version: 2, hash: SHOWN_HASH, from: 'sato@div.example',
  to: [
    { ref: `r${'1'.repeat(24)}`, email: 'suzuki@a-corp.example', name: '鈴木 一郎', source: 'calendar', firstTime: true },
    { ref: `r${'2'.repeat(24)}`, email: 'yamaguchi@a-corp.example', name: '山口 花子', source: 'hubspot', firstTime: true },
  ],
  cc: [
    { ref: `r${'3'.repeat(24)}`, email: 'tanaka@div.example', name: '田中', source: 'member', firstTime: false },
    { ref: `r${'4'.repeat(24)}`, email: 'partner@third.example', name: null, source: 'typed', firstTime: true },
  ],
  subject: '本日はありがとうございました', body: '鈴木様\n\n本日はありがとうございました。\n資料: https://example.com/doc\n',
  bodyDeleted: false, linkCount: 1, minutesId: 'minutes-0123456789abcdef', dealId: null, sentAt: null, providerMessageId: null,
  lastChangedBy: 'ai', updatedAt: '2026-11-05T06:50:00Z',
}
const card: MailDraftCard = { id: 'card-1', companyId: 'co-preview', conversationId: 'conv-1', draft, byAi: true, at: '2026-11-05T06:50:00Z' }

let reportHash: (hash: string) => void = () => {}
installElectronAPI({
  sendOutboundMail: async (_companyId, _messageId, hash) => {
    reportHash(hash)
    return { success: true, outcome: 'sent', draft: { ...draft, state: 'sent', sentAt: '2026-11-05T06:52:00Z', providerMessageId: 'gm-1' } }
  },
})

const message: UIMessage = {
  id: 'm', role: 'assistant',
  parts: [{ type: 'text', text: 'お礼メールの下書きを作りました。' }, { type: MAIL_DRAFT_PART_TYPE, id: 'mail-draft-card-1', data: card }] as UIMessage['parts'],
}

function Preview() {
  const [received, setReceived] = useState<string | null>(null)
  reportHash = setReceived
  return (
    <main className="min-h-screen bg-white p-8 text-gray-900">
      <p className="mb-4 text-xs text-gray-500">表示確認用の人工データ。本番のメールは送りません。</p>
      <section className="mx-auto max-w-xl"><AssistantMessageParts parts={message.parts} isStreaming={false} markdown /></section>
      {received !== null && <p aria-label="受け取った印">{received}</p>}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
