// 「<サービス> の鍵がありません」: a tool or the AI hit the key broker's "no key"
// answer for a service. Offers Settings → 「自分の鍵」 for it where the member may
// register one, else says to ask the admin. Shows the service's name only — never
// what was printed around the marker.
import { memo } from 'react'
import { Key } from '@phosphor-icons/react'
import { OWN_KEY_BLOCKED_TEXT } from '../../../../shared/broker-keys'
import { builtinBrokerService } from '../../../../../shared/core/key-broker'
import { runCommand, useCommandAvailable } from '../../../shared/commands/commands'
import { useAppStore } from '../../../stores/appStore'
import { useOwnKeyService } from '../hooks/useOwnKeyService'

export const BrokerKeyNeededCard = memo(function BrokerKeyNeededCard({ service }: { service: string }) {
  const companyId = useAppStore(s => s.currentCompany?.id)
  const state = useOwnKeyService(companyId, service)
  const canOpen = useCommandAvailable('settings.openOwnKey')
  const known = state.kind === 'known' ? state : null
  const label = known?.service?.label ?? builtinBrokerService(service)?.label ?? service
  const own = known?.service?.ownKey
  const registered = known?.service?.key?.status === 'active' && own?.allowed

  let text: string
  let offer = true
  if (state.kind === 'loading') text = '設定を確かめています…'
  else if (known && !known.enabled) { text = 'サーバーで鍵を預かる機能が、まだ使えるようになっていません。管理者に相談してください。'; offer = false }
  else if (registered) text = '自分の鍵を登録済みです。AI にもう一度頼んでください。'
  else if (own && !own.allowed) { text = `${OWN_KEY_BLOCKED_TEXT[own.reason]}使いたいときは、管理者に鍵を使えるようにしてもらってください。`; offer = false }
  else if (known && !known.service) { text = 'このサービスの鍵は、まだ登録できません。管理者に相談してください。'; offer = false }
  else text = '自分の鍵を登録すると、AI がこのサービスを使えるようになります。'

  return (
    <div role="group" aria-label={`${label} の鍵がありません`} className="my-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
      <div className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-zinc-100">
        <Key size={15} weight="bold" aria-hidden className="text-amber-500" />
        {label} の鍵がありません
      </div>
      <p className="mt-1 text-xs text-gray-600 dark:text-zinc-300">{text}</p>
      {offer && state.kind !== 'loading' && (canOpen
        ? (
          <button type="button" onClick={() => void runCommand('settings.openOwnKey', { service })}
            className="mt-2 rounded-lg bg-accent px-3 py-1.5 text-xs text-white hover:bg-accent/90">
            {registered ? '「自分の鍵」を開く' : '自分の鍵を登録する'}
          </button>
        )
        : <p className="mt-1 text-[11px] text-gray-500">メインの画面の「設定 → 自分の鍵」から登録できます。</p>)}
    </div>
  )
})
