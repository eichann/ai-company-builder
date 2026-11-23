/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the chat's cards about writing outside ACB, as a reply shows them, with the user manual's story
// (client/tests/manual/scenes.ts, chapters 29 and 31; 山田さん of 検証A社's 営業部, fictional data only):
// a Google Drive put into a folder people of A社 can see (google-drive.md "Asking before a put"), and the
// customer list's writes (plugins.md "The app (P7)"): an applied update with 「変更前の値を書き戻す」 and one whose
// answer was lost (「もう一度確かめる」). The buttons reach a fake main that answers nothing (no press is shown here).
import { createRoot } from 'react-dom/client'
import type { UIMessage } from 'ai'
import '../src/i18n'
import '../src/index.css'
import { AssistantMessageParts } from '../src/features/chat/components/MessageParts'
import { useAppStore } from '../src/stores/appStore'
import { DRIVE_OVERWRITE_PART_TYPE, type DriveOverwriteCard } from '../shared/drive-overwrite'
import { PLUGIN_OPERATION_PART_TYPE, outcomeMessage, type PluginOperationCard } from '../shared/plugin-operations'
import { installElectronAPI } from './ui/fixtures/electron-api'

useAppStore.setState({ currentCompany: { id: 'co-preview', name: '検証A社', rootPath: '/preview', departments: [], createdAt: new Date() } })
installElectronAPI({})

const AT = '2026-11-20T01:20:00.000Z'
const drive: DriveOverwriteCard = {
  id: 'drive-card-1', companyId: 'co-preview', confirmationId: 'drive-confirm-manual01', fileName: '研修のご提案（A社様）', editors: [], commented: false,
  expiresAt: '2026-11-20T02:20:00.000Z', at: AT, update: false, edited: false,
  audience: { anyone: false, outsideDomains: ['a-sha.example'], insideOthers: 3, privateSource: false, trustOffered: true },
}
const op = (id: string, outcome: PluginOperationCard['outcome'], fields: PluginOperationCard['fields']): PluginOperationCard => ({
  id, companyId: 'co-preview', conversationId: 'conv-1', pluginId: 'sales', systemLabel: 'HubSpot', recordId: 'deal-manual0001', recordTitle: 'A社 研修導入',
  outcome, message: outcomeMessage(outcome, 'HubSpot'), operationId: `op-${id}`, fields, reason: '11/20 の打ち合わせで、次は見積を出すことになったため', byAi: true,
  undoable: outcome === 'applied', at: AT,
})
const applied = op('applied', 'applied', [{ field: 'next_step', label: '次のアクション', before: '提案の日程を決める', after: '見積を出す' }])
const unknown = op('unknown', 'unknown', [{ field: 'next_step', label: '次のアクション', after: '見積を出す' }])

const message: UIMessage = {
  id: 'm', role: 'assistant',
  parts: [
    { type: 'text', text: '提案書を Google ドライブの「A社と共有」フォルダに置く前に、確かめてください。' }, { type: DRIVE_OVERWRITE_PART_TYPE, id: 'drive-1', data: drive },
    { type: 'text', text: '顧客台帳の「次のアクション」を更新しました。' }, { type: PLUGIN_OPERATION_PART_TYPE, id: 'op-1', data: applied },
    { type: 'text', text: '更新の結果が届きませんでした。' }, { type: PLUGIN_OPERATION_PART_TYPE, id: 'op-2', data: unknown },
  ] as UIMessage['parts'],
}

function Preview() {
  return (
    <main className="min-h-screen bg-white p-8 text-gray-900">
      <p className="mb-4 text-xs text-gray-500">表示確認用の人工データ。本番の相談や外のサービスには接続しません。</p>
      <section className="mx-auto max-w-xl"><AssistantMessageParts parts={message.parts} isStreaming={false} markdown /></section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
