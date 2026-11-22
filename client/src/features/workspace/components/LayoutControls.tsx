import { ArrowCounterClockwise, ChatCircle, SidebarSimple } from '@phosphor-icons/react'

interface Props {
  leftShown: boolean
  chatShown: boolean
  onToggleLeft: () => void
  onToggleChat: () => void
  /** 「いつもの形に戻す」: the first sizes, every pane shown. */
  onReset: () => void
}

const TOGGLE = 'p-2 rounded-control text-text-muted hover:bg-surface-sunken hover:text-text aria-pressed:text-selected-text transition-colors'

/**
 * The title bar's layout buttons: show / hide the left column and the consultation, and back to the usual look.
 * The bottom panel's button is the title bar's ［受け箱］ (I2, owner decision: no second button for one panel).
 */
export function LayoutControls({ leftShown, chatShown, onToggleLeft, onToggleChat, onReset }: Props) {
  return (
    <div role="group" aria-label="画面の形" className="flex items-center gap-1">
      <button type="button" className={TOGGLE} aria-pressed={leftShown} onClick={onToggleLeft}
        title={leftShown ? '左の欄をしまう (⌘B)' : '左の欄を出す (⌘B)'} aria-label="左の欄 (⌘B)">
        <SidebarSimple size={18} weight={leftShown ? 'fill' : 'regular'} />
      </button>
      <button type="button" className={TOGGLE} aria-pressed={chatShown} onClick={onToggleChat}
        title={chatShown ? 'AIチャットをしまう (⌘⇧C)' : 'AIチャットを表示 (⌘⇧C)'} aria-label="AIチャット (⌘⇧C)">
        <ChatCircle size={18} weight={chatShown ? 'fill' : 'regular'} />
      </button>
      <button type="button" onClick={onReset} title="大きさと表示を最初に戻す"
        className="flex items-center gap-1 px-control-sm-x py-1.5 rounded-control text-small text-text-muted hover:bg-surface-sunken hover:text-text transition-colors">
        <ArrowCounterClockwise size={16} />
        <span>いつもの形に戻す</span>
      </button>
    </div>
  )
}
