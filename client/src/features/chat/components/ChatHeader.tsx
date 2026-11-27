import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleNotch, Plus, SidebarSimple, X, MarkdownLogo, ArrowSquareOut, DotsThree, Note, GearSix } from '@phosphor-icons/react'
import { useAppStore } from '../../../stores/appStore'
import { ContextMenu, type ContextMenuItem } from '../../../shared/ui/ContextMenu'

interface ChatHeaderProps {
  /** The consultation's name (「新しい相談」 until it has one). */
  title: string
  status: string
  onStop: () => void
  /** Absent in a consultation's own window (it shows that one conversation). */
  onNewChat?: () => void
  onToggleSidebar?: () => void
  sidebarOpen: boolean
  onShowSettings: () => void
  /** 「別ウィンドウで開く」; absent where it does not apply (a new conversation, its own window). */
  onOpenInWindow?: () => void
  /** The AI works or waits for an answer: moving now would stop it. */
  openInWindowBlocked?: boolean
  /** Opens the hand-off memo (引き継ぎメモ); absent before the conversation has an id. */
  onShowHandoff?: () => void
}

const ICON_BUTTON = 'w-8 h-8 flex-shrink-0 rounded-control text-text-muted hover:bg-surface-sunken hover:text-text flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring'

/**
 * The conversation's header, kept to what a member needs every time (owner FB 2026-11-27, like the
 * Claude and ChatGPT apps): the list toggle, the consultation's name, its state while a turn runs,
 * stop, ＋ and 「…」. Everything else is in 「…」 (hand-off memo, Markdown display, 別ウィンドウ,
 * settings); the model and effort are the switch beside the input (ModelMenu), the usage meter too.
 * The name truncates first, so the buttons never move out of the pane (280 px, its minimum).
 */
export function ChatHeader({ title, status, onStop, onNewChat, onToggleSidebar, sidebarOpen, onShowSettings, onOpenInWindow, openInWindowBlocked, onShowHandoff }: ChatHeaderProps) {
  const { t } = useTranslation()
  const chatMarkdownRender = useAppStore((state) => state.chatMarkdownRender)
  const setChatMarkdownRender = useAppStore((state) => state.setChatMarkdownRender)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const running = status === 'submitted' || status === 'streaming'

  const menuItems: ContextMenuItem[] = []
  if (onShowHandoff) menuItems.push({ label: '引き継ぎメモ', icon: <Note size={16} />, onClick: onShowHandoff })
  menuItems.push({
    label: chatMarkdownRender ? 'プレーン表示に切り替える' : '装飾表示に切り替える',
    icon: <MarkdownLogo size={16} weight={chatMarkdownRender ? 'fill' : 'regular'} />,
    onClick: () => setChatMarkdownRender(!chatMarkdownRender),
  })
  if (onOpenInWindow) menuItems.push({ label: '別ウィンドウで開く', icon: <ArrowSquareOut size={16} />, disabled: openInWindowBlocked, onClick: onOpenInWindow })
  menuItems.push({ label: '', divider: true, onClick: () => {} })
  menuItems.push({ label: '相談の設定（使う AI）', icon: <GearSix size={16} />, onClick: onShowSettings })

  return (
    <header className="flex-shrink-0 h-12 flex items-center gap-1 min-w-0 px-2 border-b border-[color:var(--color-border)]">
      {onToggleSidebar && (
        <button type="button" onClick={onToggleSidebar} aria-label="AIへの相談の一覧を開閉" aria-expanded={sidebarOpen} title={sidebarOpen ? 'AIへの相談の一覧を閉じる' : 'AIへの相談の一覧を開く'} className={ICON_BUTTON}>
          <SidebarSimple size={16} />
        </button>
      )}
      <h2 className="min-w-0 truncate px-1 text-body font-strong text-text" title={title}>{title}</h2>
      {status === 'submitted' && (
        <span role="status" className="flex shrink-0 items-center gap-1 text-small text-text-muted whitespace-nowrap">
          <CircleNotch size={12} className="animate-spin text-primary" aria-hidden />
          {t('chat.statusSubmitted')}
        </span>
      )}
      {status === 'streaming' && (
        <span role="status" className="flex shrink-0 items-center gap-1 text-small text-text-muted whitespace-nowrap">
          <span className="size-[var(--size-dot)] rounded-full bg-primary animate-pulse-soft" aria-hidden />
          {t('chat.statusStreaming')}
        </span>
      )}
      {status === 'error' && (
        <span role="status" className="flex shrink-0 items-center gap-1 text-small text-danger-text whitespace-nowrap">
          <span className="size-[var(--size-dot)] rounded-full bg-danger" aria-hidden />
          {t('chat.statusError')}
        </span>
      )}
      <div className="flex-1" />

      {running && (
        <button type="button" onClick={() => onStop()} className={ICON_BUTTON} title={t('chat.stop')} aria-label={t('chat.stop')}>
          <X size={16} className="text-danger-text" />
        </button>
      )}
      {onNewChat && (
        <button type="button" onClick={onNewChat} className={ICON_BUTTON} title={t('chat.newChat')} aria-label={t('chat.newChat')}>
          <Plus size={16} />
        </button>
      )}
      <button
        type="button"
        aria-label="その他の操作"
        title="その他の操作"
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        // A press outside closes the menu; this button's own press toggles it instead.
        onMouseDown={e => e.stopPropagation()}
        onClick={e => {
          const r = e.currentTarget.getBoundingClientRect()
          // Fixed on the window, right-aligned under the button.
          setMenuAt(at => at ? null : { x: Math.max(8, r.right - 240), y: r.bottom + 4 })
        }}
        className={ICON_BUTTON}
      >
        <DotsThree size={16} weight="bold" />
      </button>
      {menuAt && <ContextMenu items={menuItems} position={menuAt} onClose={() => setMenuAt(null)} />}
    </header>
  )
}
