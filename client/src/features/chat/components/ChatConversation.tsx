import type { PluginPersonStep, PluginRunStep } from '../../../../shared/ai-turn-steps/plugin'
import type { AiTurnStep } from '../../../../shared/ai-turn-steps/registry'
import { HandoffControl } from './HandoffControl'
import { AgentInteractionCard } from './AgentInteractionCard'
import type { AuthMode, CodexStatus } from '../../../../shared/agent'
import { agentCan } from '../../../../shared/agents/registry'
import { promptSuggestionSetting } from '../../../shared/lib/promptSuggestionSetting'
import { useEffect, useCallback, useMemo, useRef, useState, memo } from 'react'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import type { DroppedRecordRef } from '../../../../shared/record-drop'
import { topicOnDrop, withPendingRecord } from '../recordDrop'
import { TopicSwitchAsk } from './TopicSwitchAsk'
import { REVIEW_CONFIRM_MESSAGE } from '../../../../shared/review-request'
import { MINUTES_NEEDS_CLAUDE_TEXT } from '../../../../shared/minutes-app'
import { pendingReviewOf } from '../reviewRequest'
import { ReviewActionsContext, type ReviewActions } from '../review-context'
import { useTranslation } from 'react-i18next'
import type { UIMessage } from 'ai'
import { CircleNotch } from '@phosphor-icons/react'
import { useAppStore } from '../../../stores/appStore'
import { perfMark } from '../../../shared/lib/perfDiagnostics'
import { type SlashCommandItem } from './SlashCommandDropdown'
import { markChatInputActivity } from '../../../shared/lib/chatInputActivity'
import type { ChatServerClient } from '../chatServerClient'
import { useChatDraft } from '../hooks/useChatDraft'
import { completeHandoffTurn, persistAgentSession, stampNewMessages, useConversation } from '../hooks/useConversation'
import { useChatHistory } from '../hooks/useChatHistory'
import { useTitleGeneration } from '../hooks/useTitleGeneration'
import { useAttachToLatestUserMessage, useMessageAttachments } from '../hooks/useMessageAttachments'
import { useChatRequestContext, useChatTransport } from '../hooks/useChatTransport'
import { useAgentInteractions, useToolApprovals } from '../hooks/useAgentInteractions'
import { useQueuedSendFlush, useSteering } from '../hooks/useSteering'
import { usePromptSuggestion } from '../hooks/usePromptSuggestion'
import { useChatAutoScroll } from '../hooks/useChatAutoScroll'
import { useConsultationStatus } from '../hooks/useConsultationStatus'
import { useDiscardBlankOnLeave } from '../hooks/useDiscardBlankOnLeave'
import { useAgentModelSelection } from '../hooks/useAgentModelSelection'
import { useRateLimitsRefresh, useStreamingChat } from '../hooks/useStreamingChat'
import { ChatHeader } from './ChatHeader'
import { MessageList } from './ChatMessageList'
import { ToolApprovalBanner } from './ToolApprovalBanner'
import { ChatInput } from './ChatComposer'
import { QueuedSendList } from './QueuedSendList'
import { AppInstructionChip } from './AppInstructionChip'
import { TopicChip } from './TopicChip'
import { patchChatSession } from '../api'
import { appInstructionOf, type AppInstruction } from '../../../../shared/app-instruction'

// One chat tab: a conversation with the agent. A composition of hooks
// (hooks/, one concern each, in the order useChat needs them) and
// presentational parts (ChatHeader, MessageList, ChatInput, banners).
// Over 300 lines on purpose: the hook order is one sequence (chat-ui-and-history.md), read in one place.

const IMAGE_READ_FAILED = '添付した画像を読み込めなかったため、送信しませんでした。入力した文は残してあります。画像を添付し直してから、もう一度送信してください。'

export interface ChatPanelChatProps {
  /** The tab this conversation is shown in (its status in the 「AIへの相談」 list). */
  tabId: string
  /**
   * The tab its pane shows (several panes may each show one): what scrolling,
   * the save on leaving, 「新着」 and chat commands go by. Which pane takes
   * the voice key is the chat pane the member used last (`paneId`, the
   * command registry), not this flag.
   */
  isShown: boolean
  /** The chat pane this tab is in (the layout leaf id; `chat` for the main one and a consultation's own window). */
  paneId?: string
  departmentPath?: string
  activeDepartment?: { name: string; folder: string }
  chatServer: ChatServerClient
  authMode: AuthMode
  codexStatus: CodexStatus
  slashCommands?: SlashCommandItem[]
  onShowSettings: () => void
  onTitleChange?: (title: string) => void
  onNewTab?: () => void
  onToggleSidebar: () => void
  sidebarOpen: boolean
  initialSessionId?: string | null
  onSessionIdChange?: (sessionId: string | null) => void
  /** Closes this tab: the member left it for another conversation with nothing typed (useDiscardBlankOnLeave). */
  onLeftBlank?: () => void
  /** A chat command waiting for this tab (only the shown tab of the named pane gets one); consumed once acted on. */
  inputRequest?: ChatInputRequest | null
  onInputRequestConsumed?: () => void
  /** 「別ウィンドウで開く」 for this conversation (the main window's chat). */
  onOpenInWindow?: (sessionId: string) => void
  /** Shown alone in a window of its own: no new-chat or list buttons (that window shows this one conversation). */
  standalone?: boolean
  /** The member's 今日のフォルダ now (company path), sent with each request; absent = none. */
  todayFolder?: () => string | null
}

/** What chat.newConsultation / chat.insertText asked the pane to do (ChatPanel holds it until a tab can). */
export type ChatInputRequest =
  /** `instruction`: `message` is the app's instruction to the AI, sent but shown only as a chip (app-instruction.ts). */
  | { kind: 'newConsultation'; message?: string; title?: string; minutesId?: string; topicRecordId?: string; pluginStep?: PluginPersonStep; instruction?: AppInstruction }
  | { kind: 'insertText'; text: string }
  /**
   * 「AI の番」 run automatically (ai-turns.md), for a fresh tab behind the shown one: claim the
   * record with this tab's conversation id; only when that wins, send the first message.
   */
  | { kind: 'aiTurn'; step: AiTurnStep | PluginRunStep; title: string; minutesId?: string; claim: (conversationId: string) => Promise<{ message: string } | null> }

// Memoised: every tab stays mounted, and the parent re-renders on any tab's
// title change or tab switch. Its props are stable (see CompanyChatPanel).
export const ChatPanelChat = memo(function ChatPanelChat({ tabId, isShown, departmentPath, activeDepartment, chatServer, authMode, codexStatus, slashCommands, onShowSettings, onTitleChange, onNewTab, onToggleSidebar, sidebarOpen, initialSessionId, onSessionIdChange, onLeftBlank, inputRequest, onInputRequestConsumed, onOpenInWindow, standalone, paneId = 'chat', todayFolder }: ChatPanelChatProps) {
  const { t } = useTranslation()
  const currentCompany = useAppStore((state) => state.currentCompany)
  const models = useAgentModelSelection(authMode, codexStatus)

  // Which conversation this tab shows (refs read by the transport, onFinish
  // and the interaction lookup below — so this comes first).
  const conversation = useConversation(initialSessionId)
  const { appSessionIdRef, claudeSessionIdRef, agentSessionRef, handoffRequestRef, historyError, setHistoryError, currentSessionId, setCurrentSessionId, timestampsRef, saveRef } = conversation
  // Imperative handle to read/write the chat input value for per-session draft persistence
  const { draftRef: draftInputRef, onDraftChange: handleDraftChange, inputApiRef: chatInputApiRef } = useChatDraft()

  // The agent's questions for this conversation (looked up during render).
  const { currentInteraction, respondToInteraction } = useAgentInteractions(appSessionIdRef)

  // What each request carries (refs: the transport reads them per request).
  const { authModeRef, workingDirRef, activeDepartmentRef, modelIdRef: aiModelRef, effortRef: aiEffortRef, companyIdRef, companyRootRef, todayFolderRef } = useChatRequestContext({
    authMode,
    workingDirectory: departmentPath || currentCompany?.rootPath,
    activeDepartment,
    companyId: currentCompany?.id,
    companyRootPath: currentCompany?.rootPath,
    modelId: models.selectedModel,
    effort: models.selectedEffort,
    todayFolder,
  })

  const attachments = useMessageAttachments()
  const { pendingImagesRef, pendingFilePathsRef, messageImages, messageReferenceFiles, stageImages, stageFilePaths } = attachments

  // The automatic 「AI の番」 send (aiTurn request below): its one request runs only that step's tools.
  const aiTurnStepRef = useRef<AiTurnStep | PluginRunStep | null>(null)
  // A business plugin's person step this consultation was started from: its first request binds it (plugin-steps.md).
  const pluginStepRef = useRef<PluginPersonStep | null>(null)
  // Records dropped on the input (recordDrop.ts): shown in the composer until sent; the request takes their ids once.
  const [pendingRecords, setPendingRecords] = useState<DroppedRecordRef[]>([])
  const pendingRecordsRef = useLatestRef(pendingRecords)
  const pendingRecordIdsRef = useRef<string[]>([])
  const transport = useChatTransport(chatServer, {
    authMode: authModeRef,
    agentSession: agentSessionRef,
    workingDirectory: workingDirRef,
    companyId: companyIdRef,
    companyRootPath: companyRootRef,
    activeDepartment: activeDepartmentRef,
    todayFolder: todayFolderRef,
    modelId: aiModelRef,
    effort: aiEffortRef,
    promptSuggestions: () => promptSuggestionSetting.getSnapshot(),
    appSessionId: appSessionIdRef,
    claudeSessionId: claudeSessionIdRef,
    pendingImages: pendingImagesRef,
    pendingFilePaths: pendingFilePathsRef,
    pendingRecordIds: pendingRecordIdsRef,
    handoffRequest: handoffRequestRef,
    aiTurnStep: aiTurnStepRef,
    pluginStep: pluginStepRef,
  })

  // Next-prompt suggestion and messages sent while the AI works. Declared
  // before useChat: its onFinish records how the turn ended.
  const suggestions = usePromptSuggestion({ chatServer, authModeRef, appSessionIdRef, inputApiRef: chatInputApiRef, currentSessionId })
  const { onTurnFinished: suggestionTurnFinished, resetSuggestion } = suggestions
  const steering = useSteering({ chatServer, authModeRef, appSessionIdRef, inputApiRef: chatInputApiRef })
  const { queuedSends, lastTurnAbortedRef, sendWhileRunning, cancelQueuedSend } = steering

  const { messages, sendMessage, status, stop, setMessages, error, regenerate } = useStreamingChat(transport, ({ messages: finishedMessages, message, isAbort, isDisconnect, isError, finishReason }) => {
    lastTurnAbortedRef.current = isAbort || isDisconnect || isError
    suggestionTurnFinished(lastTurnAbortedRef.current)
    completeHandoffTurn(conversation, companyIdRef, { finishedMessages, message, isAbort, isDisconnect, isError, finishReason })
    // Fetch and store Claude CLI session ID for resume persistence
    persistAgentSession(conversation, chatServer, currentCompany?.id)
  })
  const { pendingApproval, respondToApproval } = useToolApprovals(appSessionIdRef, status)

  useRateLimitsRefresh(chatServer, authMode, authModeRef)

  // Model/provider changes start a fresh native session with visible history.
  const modelLocked = status === 'submitted' || status === 'streaming'

  useAttachToLatestUserMessage(messages, attachments)

  // Timestamp tracking (sync during render for immediate availability)
  stampNewMessages(timestampsRef.current, messages)

  // The conversation in the history store: restore, autosave, flush, new chat.
  const { isRestoringSession, historyReadyRef, deletedRef, messagesRef, titleGenerationDoneRef, customTitleRef, minutesIdRef, topicRecordId: topicShown, setTopic, startNewChat } = useChatHistory({
    conversation,
    initialSessionId,
    companyId: currentCompany?.id,
    greeting: t('chat.greeting', { company: currentCompany?.name || '' }),
    newChatTitle: t('chat.newChat'),
    isShown,
    messages,
    setMessages,
    status,
    stop,
    chatServer,
    draftRef: draftInputRef,
    inputApiRef: chatInputApiRef,
    messageImages,
    messageReferenceFiles,
    setMessageImages: attachments.setMessageImages,
    setMessageReferenceFiles: attachments.setMessageReferenceFiles,
    onTitleChange,
    onSessionIdChange,
  })

  useTitleGeneration({
    status,
    messages,
    companyId: currentCompany?.id,
    chatServer,
    appSessionIdRef,
    authModeRef,
    modelIdRef: aiModelRef,
    titleGenerationDoneRef,
    customTitleRef,
    onTitleChange,
  })

  // Images and files attached in the input and not sent yet (the composer owns them).
  const unsentAttachmentsRef = useRef(0)
  const handleAttachmentsChange = useCallback((count: number) => { unsentAttachmentsRef.current = count }, [])

  const { messagesEndRef, messagesContainerRef, onCompositionStateChange: handleInputCompositionStateChange } = useChatAutoScroll({ isShown, isRestoringSession, messages, status })

  const handleInputActivity = useCallback(() => {
    markChatInputActivity()
  }, [])

  // Send handler. While the AI works the message goes into the running turn
  // (steering) or waits for the turn to end; it no longer stops the AI.
  // `editedMessageId`: an edited message is resent — the conversation is cut
  // just before it and the new text sent in its place, through the same steps
  // (synchronous save first, attachments staged) as any other message.
  const sendTurn = useCallback(async (text: string, files?: File[], filePaths?: string[], editedMessageId?: string, instruction?: AppInstruction) => {
    if (!text.trim() && (!files || files.length === 0)) return
    const editing = editedMessageId !== undefined
    // An edit replaces part of the conversation: only while nothing runs.
    if (editing && (status === 'streaming' || status === 'submitted')) return
    let base = messagesRef.current
    if (editing) {
      const index = base.findIndex(m => m.id === editedMessageId)
      if (index === -1) return
      base = base.slice(0, index)
    }
    perfMark('chat.send.start')

    // Ensure session ID exists before first message (don't wait for auto-save debounce)
    if (!currentSessionId && !appSessionIdRef.current) {
      const newId = crypto.randomUUID()
      setCurrentSessionId(newId)
      appSessionIdRef.current = newId
    }

    resetSuggestion()
    if (status === 'streaming' || status === 'submitted') {
      sendWhileRunning({ text, files, filePaths })
      return
    }
    lastTurnAbortedRef.current = false

    // Images (base64) and file paths for the request body and the bubble
    if (files && files.length > 0) {
      try {
        await stageImages(files)
      } catch {
        // Nothing was sent: the typed text goes back into the composer.
        if (!editing) chatInputApiRef.current?.setValue(text)
        setHistoryError(IMAGE_READ_FAILED)
        return
      }
    }
    if (filePaths && filePaths.length > 0) stageFilePaths(filePaths)
    // Dropped records go with this message once (main reads them now); its bubble says so.
    const dropped = editing || instruction ? [] : pendingRecordsRef.current
    if (dropped.length > 0) {
      pendingRecordIdsRef.current = dropped.map(r => r.id)
      setPendingRecords([])
    }

    const metadata = { ...(instruction ? { appInstruction: instruction } : {}), ...(dropped.length > 0 ? { droppedRecords: dropped } : {}) }
    const message: UIMessage = {
      id: crypto.randomUUID(), role: 'user',
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      parts: [{ type: 'text', text: text || '画像を確認してください' }],
    }
    timestampsRef.current.set(message.id, new Date())
    // An edit leaves the composer (and its saved draft) alone; a failed save
    // then keeps the conversation as it was and nothing is sent.
    if (!await saveRef.current([...base, message], true, !editing)) {
      if (!editing) chatInputApiRef.current?.setValue(text)
      if (dropped.length > 0) { pendingRecordIdsRef.current = []; setPendingRecords(dropped) }
      return
    }
    if (editing) setMessages(base)
    try { await sendMessage(message) }
    catch (e) { setHistoryError(e instanceof Error ? e.message : '送信できませんでした。相談は保存されています。') }
  }, [status, sendMessage, setMessages, currentSessionId, stageImages, stageFilePaths, appSessionIdRef, chatInputApiRef, messagesRef, saveRef, setCurrentSessionId, setHistoryError, timestampsRef, resetSuggestion, sendWhileRunning, lastTurnAbortedRef, pendingRecordsRef])
  const handleSend = useCallback((text: string, files?: File[], filePaths?: string[]) => sendTurn(text, files, filePaths), [sendTurn])

  // A record dropped on the input (owner 2026-11-03 #5): the consultation becomes one about it — asked
  // first when it is about something else — and the record waits to go to the AI with the next message.
  const [topicSwitch, setTopicSwitch] = useState<DroppedRecordRef | null>(null)
  const topicShownRef = useLatestRef(topicShown)
  const applyTopic = useCallback((recordId: string) => {
    setTopic(recordId)
    setTopicSwitch(null)
    const sessionId = appSessionIdRef.current
    // A conversation not saved yet takes the topic with its first save (useChatHistory).
    if (currentCompany?.id && sessionId) void patchChatSession(currentCompany.id, sessionId, { topicRecordId: recordId }).catch(() => {})
  }, [setTopic, appSessionIdRef, currentCompany?.id])
  const handleDropRecord = useCallback((record: DroppedRecordRef) => {
    setPendingRecords(list => withPendingRecord(list, { id: record.id, title: record.title, word: record.word }))
    const decision = topicOnDrop(topicShownRef.current, record.id)
    if (decision === 'set') applyTopic(record.id)
    else if (decision === 'ask') setTopicSwitch(record)
    chatInputApiRef.current?.focus()
  }, [applyTopic, topicShownRef, chatInputApiRef])
  const removePendingRecord = useCallback((id: string) => setPendingRecords(list => list.filter(r => r.id !== id)), [])

  // The turn ended: waiting sends go out together (or back into the input).
  useQueuedSendFlush(steering, status, handleSend, setMessages, chatInputApiRef)

  const running = status === 'submitted' || status === 'streaming'
  const offeredSuggestion = !running && !currentInteraction && !pendingApproval ? suggestions.promptSuggestion : null

  // What the tab holds, read live when an automatic run or its record ends (closing it must lose nothing).
  const readHold = () => ({
    ready: historyReadyRef.current && !deletedRef.current,
    draft: draftInputRef.current,
    attachments: unsentAttachmentsRef.current,
    // Not the hand-off receipt: every turn leaves one (its memo update goes on after a close).
    busy: running || queuedSends.length > 0 || !!pendingApproval || !!currentInteraction,
    // An automatic consultation starts with the app's one message: any other is the member's.
    memberWrote: messagesRef.current.filter(message => message.role === 'user').length > 1,
    shown: isShown,
  })
  useConsultationStatus({ tabId, isShown, status, approval: pendingApproval, interaction: currentInteraction, messages, rootPath: currentCompany?.rootPath, readHold })

  // Left for another conversation with nothing typed: the tab closes and the empty conversation goes.
  useDiscardBlankOnLeave({
    isShown,
    companyId: currentCompany?.id,
    sessionId: currentSessionId,
    readLeft: () => ({
      ready: historyReadyRef.current && !deletedRef.current,
      hasMessages: messagesRef.current.some(message => message.id !== '1' || message.role === 'user'),
      draft: draftInputRef.current,
      attachments: unsentAttachmentsRef.current,
      busy: running || queuedSends.length > 0 || !!pendingApproval || !!currentInteraction || !!handoffRequestRef.current,
    }),
    close: () => onLeftBlank?.(),
  })

  // 「確認をお願いします」 (ReviewRequestCard): the request in the latest reply waits for the member.
  const pendingReviewId = running ? undefined : pendingReviewOf(messages[messages.length - 1])?.id
  const reviewActions = useMemo<ReviewActions>(() => ({
    pendingId: pendingReviewId,
    confirm: () => { void handleSend(REVIEW_CONFIRM_MESSAGE) },
    requestChanges: () => chatInputApiRef.current?.focus(),
  }), [pendingReviewId, handleSend, chatInputApiRef])

  // chat.insertText: the text goes into the composer. chat.newConsultation (e.g. a skill's 実行):
  // a new conversation, then its message is sent; waits for the history.
  useEffect(() => {
    if (isShown && inputRequest?.kind === 'insertText') {
      if (inputRequest.text && chatInputApiRef.current?.replaceText(inputRequest.text)) onInputRequestConsumed?.()
      return
    }
    // Not shown on purpose: the tab is fresh, so its own conversation id is the one the claim names.
    if (inputRequest?.kind === 'aiTurn') {
      if (!historyReadyRef.current) return
      const { step, title, minutesId, claim } = inputRequest
      onInputRequestConsumed?.()
      const conversationId = appSessionIdRef.current
      if (!conversationId || !agentCan(authMode, 'recordActions')) { void claim(''); return }
      void claim(conversationId).then(claimed => {
        if (!claimed || appSessionIdRef.current !== conversationId) return
        const { message } = claimed
        customTitleRef.current = { title, auto: false }
        titleGenerationDoneRef.current = true
        onTitleChange?.(title)
        if (minutesId) minutesIdRef.current = minutesId
        aiTurnStepRef.current = step
        void handleSend(message)
      })
      return
    }
    if (!isShown || !historyReadyRef.current || inputRequest?.kind !== 'newConsultation') return
    const { message, title, minutesId, topicRecordId, pluginStep, instruction } = inputRequest
    onInputRequestConsumed?.()
    // Reading minutes needs the minutes' actions (registry recordActions): Codex only reads.
    if (minutesId && !agentCan(authMode, 'recordActions')) { setHistoryError(MINUTES_NEEDS_CLAUDE_TEXT); return }
    startNewChat().then(started => {
      if (!started) return
      if (title) {
        customTitleRef.current = { title, auto: false }
        titleGenerationDoneRef.current = true
        onTitleChange?.(title)
      }
      if (minutesId) minutesIdRef.current = minutesId
      if (topicRecordId) setTopic(topicRecordId)
      setPendingRecords([])
      setTopicSwitch(null)
      if (pluginStep) pluginStepRef.current = pluginStep
      if (message) void sendTurn(message, undefined, undefined, undefined, instruction)
    })
  }, [inputRequest, isRestoringSession, isShown, chatInputApiRef])

  // Edit message handler: resend from the edited message onward (sendTurn),
  // keeping the edited message's file references.
  // Reads through refs so the callback keeps its identity while streaming;
  // depending on `messages` re-rendered every MessageItem per chunk.
  const sendTurnRef = useRef(sendTurn)
  sendTurnRef.current = sendTurn
  const referenceFilesRef = useRef(messageReferenceFiles)
  referenceFilesRef.current = messageReferenceFiles
  const handleEditMessage = useCallback((messageId: string, newText: string) => {
    void sendTurnRef.current(newText, undefined, referenceFilesRef.current.get(messageId), messageId)
  }, [])

  // What the consultation is about, when the app started it with an instruction (shown instead of that
  // message). It is the first message after the greeting: only the head is looked at, per streamed chunk.
  const instructionShown = useMemo(() => {
    for (const message of messages.slice(0, 3)) {
      const found = message.role === 'user' ? appInstructionOf(message) : null
      if (found) return found
    }
    return null
  }, [messages])

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <div className="h-full flex flex-col bg-white dark:bg-zinc-900">
      {/* Header */}
      <ChatHeader
        authMode={authMode}
        status={status}
        codexStatus={codexStatus}
        models={models}
        modelLocked={modelLocked}
        onStop={stop}
        onNewChat={standalone ? undefined : onNewTab || (() => startNewChat())}
        onToggleSidebar={standalone ? undefined : onToggleSidebar}
        sidebarOpen={sidebarOpen}
        onShowSettings={onShowSettings}
        onOpenInWindow={onOpenInWindow ? () => { if (currentSessionId) onOpenInWindow(currentSessionId) } : undefined}
        openInWindowBlocked={running || !!pendingApproval || !!currentInteraction}
      />
      {currentCompany?.id && appSessionIdRef.current && <HandoffControl companyId={currentCompany.id} sessionId={appSessionIdRef.current} active={isShown} />}


      {/* The topic chip says the same as a task's instruction chip, with × (consultation-task.ts). */}
      {topicShown && currentCompany?.id
        ? <TopicChip companyId={currentCompany.id} recordId={topicShown} fallbackTitle={instructionShown?.recordId === topicShown ? instructionShown.title : undefined} onRemove={() => {
          const sessionId = appSessionIdRef.current
          setTopic(null)
          if (sessionId) void patchChatSession(currentCompany.id, sessionId, { topicRecordId: null }).catch(() => {})
        }} />
        : null}
      {instructionShown && !(topicShown && instructionShown.kind === 'task' && instructionShown.recordId === topicShown) && <AppInstructionChip instruction={instructionShown} />}

      {historyError && (
        <div role="alert" className="px-4 py-2 text-sm text-red-600 dark:text-red-400 bg-red-500/10">
          {historyError}
        </div>
      )}
      {/* Error Banner */}
      {status === 'error' && error && (
        <div className="flex-shrink-0 px-4 py-2 bg-red-500/10 border-b border-red-500/20">
          <div className="text-sm text-red-400">
            {t('chat.errorOccurred', { error: error.message })}
          </div>
        </div>
      )}

      {/* Messages Area */}
      {isRestoringSession ? (
        <div className="flex-1 flex items-center justify-center">
          <CircleNotch size={24} className="text-ink-muted animate-spin" />
        </div>
      ) : (
        <ReviewActionsContext.Provider value={reviewActions}>
          <MessageList
            messages={messages}
            status={status}
            messagesEndRef={messagesEndRef}
            containerRef={messagesContainerRef}
            timestamps={timestampsRef.current}
            messageImages={messageImages}
            messageReferenceFiles={messageReferenceFiles}
            onRegenerate={regenerate}
            onEditSubmit={handleEditMessage}
          />
        </ReviewActionsContext.Provider>
      )}

      {models.agentUnavailable && (
        <div role="alert" className="px-4 py-2 text-sm text-amber-700 dark:text-amber-300">
          {codexStatus.error || 'Codexの接続を確認してください。'}
          <button onClick={onShowSettings} className="ml-2 underline">設定を開く</button>
        </div>
      )}
      {/* Tool Approval Banner (above input) */}
      {currentInteraction && <AgentInteractionCard key={currentInteraction.id} request={currentInteraction} onRespond={response => respondToInteraction(currentInteraction.id, response)} />}
      {pendingApproval && (
        <ToolApprovalBanner
          request={pendingApproval}
          onRespond={respondToApproval}
        />
      )}

      {/* Input Area */}
      <div className="flex-shrink-0 border-t border-gray-200 dark:border-zinc-800">
        <QueuedSendList queuedSends={queuedSends} onCancel={cancelQueuedSend} />
        <div className="p-4 pb-7">
          <ChatInput
            initialDraft={draftInputRef.current}
            onDraftChange={handleDraftChange}
            voiceActive={isShown}
            voicePane={paneId}
            voiceScope={appSessionIdRef.current ?? ''}
            onSend={handleSend}
            disabled={isRestoringSession || !historyReadyRef.current || deletedRef.current || models.agentUnavailable}
            placeholder={running ? t(agentCan(authMode, 'steering') ? 'chat.inputPlaceholderWorking' : 'chat.inputPlaceholderQueued') : t('chat.inputPlaceholder')}
            hint={offeredSuggestion ? t('chat.suggestionHint') : t('chat.inputHint')}
            onCompositionStateChange={handleInputCompositionStateChange}
            onInputActivity={handleInputActivity}
            slashCommands={slashCommands}
            apiRef={chatInputApiRef}
            suggestion={offeredSuggestion}
            onSuggestionCleared={suggestions.clearPromptSuggestion}
            onAttachmentsChange={handleAttachmentsChange}
            onDropRecord={currentCompany?.id ? handleDropRecord : undefined}
            pendingRecords={pendingRecords}
            onRemoveRecord={removePendingRecord}
            above={topicSwitch && topicShown && currentCompany?.id
              ? <TopicSwitchAsk companyId={currentCompany.id} fromRecordId={topicShown} to={topicSwitch} onSwitch={() => applyTopic(topicSwitch.id)} onKeep={() => setTopicSwitch(null)} />
              : null}
          />
        </div>
      </div>
    </div>
  )
})
