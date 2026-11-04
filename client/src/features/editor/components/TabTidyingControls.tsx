import { Broom, PushPin, Tray } from '@phosphor-icons/react'
import { runCommand } from '../../../shared/commands/commands'
import { MoreMenu } from '../../../shared/ui/MoreMenu'
import type { useTabTidying } from '../hooks/useTabTidying'
import { TidiedTabsDialog } from './TidiedTabsDialog'
import { TidyNoticeBar } from './TidyNoticeBar'

type Tidying = ReturnType<typeof useTabTidying>

/** The tabs' 「…」: ［タブを片づける］ (tabs.tidy), 「片づけたタブ」 and pinning the shown tab. */
export function TabTidyingMenu({ tidying, activeKey }: { tidying: Tidying; activeKey: string | null }) {
  return (
    <MoreMenu compact label="タブの操作" items={[
      { label: 'タブを片づける', icon: <Broom size={14} />, hint: '固定したタブ以外を閉じて「片づけたタブ」にしまいます', onClick: () => { void runCommand('tabs.tidy') } },
      { label: '片づけたタブ', icon: <Tray size={14} />, hint: 'しまったタブを開き直せます', onClick: tidying.openList },
      ...(activeKey ? [{
        label: tidying.pinned.has(activeKey) ? 'このタブの固定をやめる' : 'このタブを固定する', icon: <PushPin size={14} />,
        hint: '固定したタブは片づけても残ります', onClick: () => tidying.togglePinned(activeKey),
      }] : []),
    ]} />
  )
}

/** What the last tidy did (or the daily tidy explained), above the tabs. */
export function TabTidyingNotice({ tidying }: { tidying: Tidying }) {
  if (!tidying.notice) return null
  return <TidyNoticeBar key={tidying.notice.at} text={tidying.notice.text} onOpenList={() => { tidying.dismissNotice(); tidying.openList() }} onDismiss={tidying.dismissNotice} />
}

/** 「片づけたタブ」 while it is open. */
export function TabTidyingList({ tidying }: { tidying: Tidying }) {
  if (!tidying.listOpen) return null
  return <TidiedTabsDialog groups={tidying.groups} onClose={tidying.closeList} onRestore={tidying.restore}
    onRemoveItems={tidying.removeItems} onRemoveDay={tidying.removeDay} checkMissing={tidying.checkMissing} />
}
