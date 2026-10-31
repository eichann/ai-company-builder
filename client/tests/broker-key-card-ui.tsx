/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the chat's 「<サービス> の鍵がありません」 card: a finished reply whose
// tool output carries the key broker's "no key" answers (Gemini: own keys allowed;
// OpenAI: 会社の鍵だけ). `?handler=0` = a consultation's own window (no settings there).
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { UIMessage } from 'ai'
import '../src/i18n'
import '../src/index.css'
import { AssistantMessageParts } from '../src/features/chat/components/MessageParts'
import { useCommandHandler } from '../src/shared/commands/commands'
import { useAppStore } from '../src/stores/appStore'
import { brokerNoKeyMessage } from '../../shared/core/key-broker'
import type { MyBrokerKeys } from '../shared/broker-keys'
import { installElectronAPI } from './ui/fixtures/electron-api'

const params = new URLSearchParams(location.search)
useAppStore.setState({ currentCompany: { id: 'co-preview', name: 'プレビュー株式会社', rootPath: '/preview', departments: [], createdAt: new Date() } })

const data: MyBrokerKeys = {
  enabled: true,
  memberKeysAllowed: true,
  services: [
    { service: 'gemini', label: 'Google Gemini', category: 'tool', rule: 'company-first', ownKey: { allowed: true, hosts: ['generativelanguage.googleapis.com'] }, companyKeys: [], key: null },
    { service: 'openai', label: 'OpenAI', category: 'tool', rule: 'company-only', ownKey: { allowed: false, reason: 'company-only' }, companyKeys: [], key: null },
  ],
}
installElectronAPI({ listOwnBrokerKeys: async () => ({ success: true, data }) })

// What a script printed: the relay's answers, plus text around them the card must never show.
const printed = [
  'Traceback (most recent call last):',
  `google.genai.errors.ClientError: 403 PERMISSION_DENIED. {'error': {'code': 'ACB_NO_KEY', 'message': '${brokerNoKeyMessage('Google Gemini', 'gemini')}'}}`,
  `openai.PermissionDeniedError: Error code: 403 - {'error': {'message': '${brokerNoKeyMessage('OpenAI', 'openai')}'}} secret-looking-NOT-REAL-text`,
].join('\n')

const message: UIMessage = {
  id: 'm',
  role: 'assistant',
  parts: [
    { type: 'text', text: '画像を作るスクリプトを動かします。' },
    { type: 'dynamic-tool', toolCallId: 't1', toolName: 'Bash', state: 'output-available', input: { command: 'python make_image.py' }, output: printed },
    { type: 'text', text: '鍵がないため、画像を作れませんでした。' },
  ] as UIMessage['parts'],
}

function OpensSettings({ onOpen }: { onOpen: (service: string) => void }) {
  useCommandHandler('settings.openOwnKey', ({ service }) => onOpen(service ?? ''))
  return null
}

function Preview() {
  const [opened, setOpened] = useState<string | null>(null)
  return (
    <main className="min-h-screen bg-white p-8 text-gray-900">
      <p className="mb-4 text-xs text-gray-500">表示確認用の人工データ。本番の相談には接続しません。</p>
      {params.get('handler') !== '0' && <OpensSettings onOpen={setOpened} />}
      <section className="mx-auto max-w-xl">
        <AssistantMessageParts parts={message.parts} isStreaming={false} markdown />
      </section>
      {opened !== null && <p role="status">設定を開きました: {opened}</p>}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
