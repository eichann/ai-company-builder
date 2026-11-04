import { Broom, FolderSimpleMinus, FolderSimplePlus, PushPin, SquaresFour, Tray } from '@phosphor-icons/react'
import { runCommand } from '../../../shared/commands/commands'
import { MoreMenu, type MoreMenuItem } from '../../../shared/ui/MoreMenu'
import type { useTabTidying } from '../hooks/useTabTidying'
import type { TabArrangement } from '../hooks/useTabArrangement'
import type { RecordTabLook } from '../editorTabs'
import { tabGroupName, tabGroupOf } from '../tabArrangement'
import { TidiedTabsDialog } from './TidiedTabsDialog'
import { TidyNoticeBar } from './TidyNoticeBar'

type Tidying = ReturnType<typeof useTabTidying>

/**
 * The tabs' 「…」: ［タブを片づける］ (tabs.tidy), 「片づけたタブ」, pinning the shown tab, 「種類ごとにまとめる」
 * and, for the shown tab, its kind's tidy and its named group.
 */
export function TabTidyingMenu({ tidying, arrangement, activeKey, looks }: {
  tidying: Tidying; arrangement: TabArrangement; activeKey: string | null; looks: Readonly<Record<string, RecordTabLook>>
}) {
  const pinned = !!activeKey && tidying.pinned.has(activeKey)
  const items: MoreMenuItem[] = [
    { label: 'タブを片づける', icon: <Broom size={14} />, hint: '固定したタブ以外を閉じて「片づけたタブ」にしまいます', onClick: () => { void runCommand('tabs.tidy') } },
    { label: '片づけたタブ', icon: <Tray size={14} />, hint: 'しまったタブを開き直せます', onClick: tidying.openList },
  ]
  if (activeKey) items.push({
    label: pinned ? 'このタブの固定をやめる' : 'このタブを固定する', icon: <PushPin size={14} />,
    hint: '固定したタブは片づけても残ります', onClick: () => tidying.togglePinned(activeKey),
  })
  items.push({
    label: '種類ごとにまとめる', icon: <SquaresFour size={14} />, checked: arrangement.byKind,
    hint: 'ファイル・やること・会議の記録などに分けて並べます', onClick: () => arrangement.setByKind(!arrangement.byKind),
  })
  if (activeKey && !pinned) {
    const group = arrangement.groupOf(activeKey)
    const kind = tabGroupOf(activeKey, looks)
    if (arrangement.byKind && !group) {
      const name = tabGroupName(kind, arrangement.sections.find(s => s.kind === kind)?.keys ?? [activeKey], looks)
      items.push({ label: `この種類（${name}）を片づける`, icon: <Broom size={14} />, hint: '固定したタブは残ります', onClick: () => { void runCommand('tabs.tidy', { kind }) } })
    }
    items.push(group
      ? { label: `まとまり「${group.name}」から外す`, icon: <FolderSimpleMinus size={14} />, onClick: () => arrangement.removeFromGroup(activeKey) }
      : { label: 'このタブを新しいまとまりに入れる', icon: <FolderSimplePlus size={14} />, hint: '名前と色をつけて、タブをまとめておけます', onClick: () => arrangement.askNewGroup(activeKey) })
  }
  return <MoreMenu compact label="タブの操作" items={items} />
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
