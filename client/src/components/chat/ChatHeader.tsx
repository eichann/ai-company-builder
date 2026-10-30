import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkle, GearSix, CircleNotch, Plus, SidebarSimple, X, MarkdownLogo, ArrowSquareOut } from '@phosphor-icons/react'
import type { AuthMode, CodexStatus } from '../../../shared/agent'
import { agentShortLabel } from '../../../shared/agents/registry'
import { hasRateLimits } from '../../../shared/rate-limits'
import { useAppStore, MODEL_EFFORT_OPTIONS, CLAUDE_MODELS, type AIModel, type AIEffort } from '../../stores/appStore'
import { RateLimitMeter } from './RateLimitMeter'
import type { AgentModelSelection } from './hooks/useAgentModelSelection'

interface ChatHeaderProps {
  authMode: AuthMode
  status: string
  codexStatus: CodexStatus
  models: AgentModelSelection
  /** A turn is in flight: the model cannot change. */
  modelLocked: boolean
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
}

/**
 * The conversation's header: agent label and usage meter, turn status, the
 * agent's model pickers (per agent on purpose — Claude Code's static list +
 * effort, Codex's live catalog), stop, markdown toggle, new chat, sidebar,
 * settings. It owns its width observation, so a resize re-renders only the
 * header, not the conversation.
 */
export function ChatHeader({ authMode, status, codexStatus, models, modelLocked, onStop, onNewChat, onToggleSidebar, sidebarOpen, onShowSettings, onOpenInWindow, openInWindowBlocked }: ChatHeaderProps) {
  const { t } = useTranslation()
  const { aiModel, setAIModel, aiEffort, setAIEffort, codexModel, selectedCodexEffort } = models
  const chatMarkdownRender = useAppStore((state) => state.chatMarkdownRender)
  const setChatMarkdownRender = useAppStore((state) => state.setChatMarkdownRender)

  // The usage meter shows only its fullest window when the header is narrow.
  const headerRef = useRef<HTMLElement>(null)
  const [narrowHeader, setNarrowHeader] = useState(false)
  useEffect(() => {
    const header = headerRef.current
    if (!header) return
    const observer = new ResizeObserver(([entry]) => setNarrowHeader(entry.contentRect.width < 600))
    observer.observe(header)
    return () => observer.disconnect()
  }, [])

  return (
    <header ref={headerRef} className="flex-shrink-0 h-12 flex items-center justify-between gap-2 px-4 border-b border-gray-200 dark:border-zinc-800">
      <div className="flex items-center gap-3 flex-shrink-0">
        <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-accent to-accent/70 flex items-center justify-center">
          <Sparkle size={12} weight="fill" className="text-white" />
        </div>
        <div className="flex items-center gap-2">
          {/* The model selector already names the agent when space is short. */}
          {(!narrowHeader || !hasRateLimits(authMode)) && (
            <span className="text-[10px] font-medium tracking-wider uppercase px-1.5 py-0.5 rounded-md bg-accent/15 text-accent">
              {agentShortLabel(authMode)}
            </span>
          )}
          {hasRateLimits(authMode) && <RateLimitMeter provider={authMode} compact={narrowHeader} />}
          {/* Status indicator */}
          {status === 'submitted' && (
            <span className="flex items-center gap-1 text-[10px] text-accent animate-fade-in whitespace-nowrap" title={t('chat.statusSubmitted')}>
              <CircleNotch size={10} className="animate-spin" />
              {!narrowHeader && t('chat.statusSubmitted')}
            </span>
          )}
          {status === 'streaming' && (
            <span className="flex items-center gap-1 text-[10px] text-green-500 dark:text-green-400 animate-fade-in whitespace-nowrap" title={t('chat.statusStreaming')}>
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 dark:bg-green-400 animate-pulse-soft" />
              {!narrowHeader && t('chat.statusStreaming')}
            </span>
          )}
          {status === 'error' && (
            <span className="flex items-center gap-1 text-[10px] text-red-500 dark:text-red-400 animate-fade-in whitespace-nowrap" title={t('chat.statusError')}>
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 dark:bg-red-400" />
              {!narrowHeader && t('chat.statusError')}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-1 min-w-0">
        {authMode === 'codex' && <>
          <select aria-label="Codexモデル" value={codexModel?.id || ''} disabled={modelLocked || !codexModel}
            onChange={e => models.chooseCodexModel(e.target.value)}
            className="h-7 max-w-44 min-w-0 shrink text-[11px] rounded-md border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-1.5 disabled:opacity-50">
            {codexStatus.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <select aria-label="Codex思考の強さ" value={selectedCodexEffort} disabled={modelLocked || !codexModel}
            onChange={e => models.chooseCodexEffort(e.target.value)}
            className="h-7 min-w-0 shrink text-[11px] rounded-md border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-1.5 disabled:opacity-50">
            {codexModel?.efforts.map(e => <option key={e} value={e}>{e}</option>)}
          </select>
        </>}
        {/* Model selection is locked only while a turn is in flight. */}
        {authMode === 'claude-code' && (
          <select
            value={aiModel}
            disabled={modelLocked}
            title={modelLocked ? '応答中はモデルを変更できません' : undefined}
            onChange={(e) => setAIModel(e.target.value as AIModel)}
            className="h-7 min-w-[5.5rem] shrink text-[11px] font-medium rounded-md border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-gray-700 dark:text-zinc-300 px-1.5 pr-6 appearance-none cursor-pointer hover:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:border-gray-200 dark:disabled:hover:border-zinc-700"
            style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 5l3 3 3-3' fill='none' stroke='%239CA3AF' stroke-width='1.5'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 4px center' }}
          >
            {CLAUDE_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        )}

        {/* Effort Level Selector (Claude Code mode only). Options depend on the model. */}
        {authMode === 'claude-code' && (
          <select
            value={aiEffort}
            onChange={(e) => setAIEffort(e.target.value as AIEffort)}
            className="h-7 min-w-[4.75rem] shrink text-[11px] font-medium rounded-md border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-gray-700 dark:text-zinc-300 px-1.5 pr-6 appearance-none cursor-pointer hover:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/50 transition-colors"
            style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 5l3 3 3-3' fill='none' stroke='%239CA3AF' stroke-width='1.5'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 4px center' }}
          >
            {MODEL_EFFORT_OPTIONS[aiModel].map((eff) => (
              <option key={eff} value={eff}>
                {eff === 'xhigh' ? 'xHigh' : eff.charAt(0).toUpperCase() + eff.slice(1)}
              </option>
            ))}
          </select>
        )}

        {/* Stop Button (visible during streaming) */}
        {(status === 'submitted' || status === 'streaming') && (
          <button
            onClick={() => onStop()}
            className="w-8 h-8 flex-shrink-0 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 flex items-center justify-center transition-colors"
            title={t('chat.stop')}
          >
            <X size={16} className="text-red-500" />
          </button>
        )}

        {/* Markdown Render Toggle: ON = decorated rendering, OFF = raw text */}
        <button
          onClick={() => setChatMarkdownRender(!chatMarkdownRender)}
          className={`w-8 h-8 flex-shrink-0 rounded-lg flex items-center justify-center transition-colors ${
            chatMarkdownRender
              ? 'bg-accent/15 text-accent hover:bg-accent/20'
              : 'hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-500 dark:text-zinc-400'
          }`}
          title={chatMarkdownRender ? '装飾表示中（クリックでプレーン表示に切替）' : 'プレーン表示中（クリックで装飾表示に切替）'}
        >
          <MarkdownLogo size={16} weight={chatMarkdownRender ? 'fill' : 'regular'} />
        </button>

        {onOpenInWindow && (
          <button
            onClick={onOpenInWindow}
            disabled={openInWindowBlocked}
            aria-label="別ウィンドウで開く"
            title={openInWindowBlocked ? 'AIの作業が終わってから別ウィンドウで開けます' : '別ウィンドウで開く'}
            className="w-8 h-8 flex-shrink-0 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ArrowSquareOut size={16} className="text-gray-500 dark:text-zinc-400" />
          </button>
        )}

        {/* New Chat/Tab Button */}
        {onNewChat && (
          <button
            onClick={onNewChat}
            className="w-8 h-8 flex-shrink-0 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 flex items-center justify-center transition-colors"
            title={t('chat.newChat')}
          >
            <Plus size={16} className="text-gray-500 dark:text-zinc-400" />
          </button>
        )}

        {onToggleSidebar && (
          <button onClick={onToggleSidebar} aria-label="AIへの相談の一覧を開閉" aria-expanded={sidebarOpen} title="AIへの相談の一覧" className="w-8 h-8 flex-shrink-0 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 flex items-center justify-center">
            <SidebarSimple size={16} />
          </button>
        )}

        {/* Settings Button */}
        <button
          onClick={onShowSettings}
          className="w-8 h-8 flex-shrink-0 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 flex items-center justify-center transition-colors"
        >
          <GearSix size={16} className="text-gray-500 dark:text-zinc-400" />
        </button>
      </div>
    </header>
  )
}
