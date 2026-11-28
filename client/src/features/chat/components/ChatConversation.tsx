import type { PluginPersonStep, PluginRunStep } from '../../../../shared/ai-turn-steps/plugin'
import type { JobRunStep } from '../../../../shared/ai-turn-steps/job'
import type { AiTurnStep } from '../../../../shared/ai-turn-steps/registry'
import { HandoffControl, type HandoffControlHandle } from './HandoffControl'
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
import { ChatFollowContext } from '../chatFollow'
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
import { readImages, useAttachToLatestUserMessage, useMessageAttachments } from '../hooks/useMessageAttachments'
import { useChatRequestContext, useChatTransport } from '../hooks/useChatTransport'
import { useAgentInteractions, useToolApprovals } from '../hooks/useAgentInteractions'
import { returnToInput, useQueuedSendFlush, useSteering } from '../hooks/useSteering'
import { usePromptSuggestion } from '../hooks/usePromptSuggestion'
import { useChatAutoScroll } from '../hooks/useChatAutoScroll'
import { useConsultationStatus } from '../hooks/useConsultationStatus'
import { useDiscardBlankOnLeave } from '../hooks/useDiscardBlankOnLeave'
import { useAgentModelSelection } from '../hooks/useAgentModelSelection'
import { useRateLimitsRefresh, useStreamingChat } from '../hooks/useStreamingChat'
import { ChatHeader } from './ChatHeader'
import { ModelMenu } from './ModelMenu'
import type { ReplyStyle } from '../../../../shared/reply-style'
import { RateLimitMeter } from './RateLimitMeter'
import { hasRateLimits } from '../../../../shared/rate-limits'
import { MessageList } from './ChatMessageList'
import { ToolApprovalBanner } from './ToolApprovalBanner'
import { ChatInput } from './ChatComposer'
import { QueuedSendList } from './QueuedSendList'
import { AppInstructionChip } from './AppInstructionChip'
import { TopicChip } from './TopicChip'
import { patchChatSession } from '../api'
import { appInstructionOf, type AppInstruction } from '../../../../shared/app-instruction'
import { chatErrorText } from '../chatErrorText'
import { replyAsksTheMember } from '../aiTurns'

// One chat tab: a conversation with the agent. A composition of hooks
// (hooks/, one concern each, in the order useChat needs them) and
// presentational parts (ChatHeader, MessageList, ChatInput, banners).
// Over 300 lines on purpose: the hook order is one sequence (chat-ui-and-history.md), read in one place.

const IMAGE_READ_FAILED = '添付した画像を読み込めなかったため、送信しませんでした。入力した文は残してあります。画像を添付し直してから、もう一度送信してください。'
const SEND_OUTLIVED_CONVERSATION = '画像の準備中に新しい相談を始めたため、前の相談へのメッセージは送りませんでした。入力した文と画像は入力欄に戻してあります。'

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
  /** A new conversation's topic from the start (ChatPanel's 「AIに相談する」 while a record is open). */
  initialTopicRecordId?: string
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
  | { kind: 'newConsultation'; message?: string; title?: string; minutesId?: string; topicRecordId?: string; pluginStep?: PluginPersonStep; instruction?: AppInstruction
    /** The app's first message went out (its id) in this tab's new conversation (「この作業をする」 closes it by itself once done). */
    onSent?: (sent: { tabId: string; conversationId: string; messageId: string }) => void }
  | { kind: 'insertText'; text: string }
  /**
   * 「AI の番」 run automatically (ai-turns.md), for a fresh tab behind the shown one: claim the
   * record with this tab's conversation id; only when that wins, send the first message.
   */
  | { kind: 'aiTurn'; step: AiTurnStep | PluginRunStep | JobRunStep; title: string; minutesId?: string; claim: (conversationId: string) => Promise<{ message: string } | null>; onSent?: (messageId: string) => void }

// Memoised: every tab stays mounted, and the parent re-renders on any tab's
// title change or tab switch. Its props are stable (see CompanyChatPanel).
export const ChatPanelChat = memo(function ChatPanelChat({ tabId, isShown, departmentPath, activeDepartment, chatServer, authMode, codexStatus, slashCommands, onShowSettings, onTitleChange: reportTitle, onNewTab, onToggleSidebar, sidebarOpen, initialSessionId, initialTopicRecordId, onSessionIdChange, onLeftBlank, inputRequest, onInputRequestConsumed, onOpenInWindow, standalone, paneId = 'chat', todayFolder }: ChatPanelChatProps) {
  const { t } = useTranslation()
  const currentCompany = useAppStore((state) => state.currentCompany)
  const models = useAgentModelSelection(authMode, codexStatus)
  // The consultation's name for the header; the tab (the list, a window's title) is told as before.
  const [title, setTitle] = useState('')
  const reportTitleRef = useLatestRef(reportTitle)
  const onTitleChange = useCallback((next: string) => { setTitle(next); reportTitleRef.current?.(next) }, [reportTitleRef])
  const handoffRef = useRef<HandoffControlHandle>(null)

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
  const aiTurnStepRef = useRef<AiTurnStep | PluginRunStep | JobRunStep | null>(null)
  // A business plugin's person step this consultation was started from: its first request binds it (plugin-steps.md).
  const pluginStepRef = useRef<PluginPersonStep | null>(null)
  // Records dropped on the input (recordDrop.ts): shown in the composer until sent; the request takes their ids once.
  const [pendingRecords, setPendingRecords] = useState<DroppedRecordRef[]>([])
  const pendingRecordsRef = useLatestRef(pendingRecords)
  // Sends between the composer emptying and the request leaving (images being read), and the
  // messages being edited in place: both hold the member's words outside the input.
  const preparingSendsRef = useRef(0)
  const editingMessagesRef = useRef(new Set<string>())
  const handleEditingChange = useCallback((messageId: string, editing: boolean) => {
    if (editing) editingMessagesRef.current.add(messageId)
    else editingMessagesRef.current.delete(messageId)
  }, [])
  const pendingRecordIdsRef = useRef<string[]>([])
  // 「返事の形」 (reply-style.ts): read by each request, restored and stored with the conversation (useChatHistory).
  const replyStyleRef = useRef<ReplyStyle>('plain')
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
    replyStyle: replyStyleRef,
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
  const { isRestoringSession, historyReadyRef, deletedRef, unmountedRef, messagesRef, titleGenerationDoneRef, customTitleRef, minutesIdRef, topicRecordId: topicShown, setTopic, replyStyle, setReplyStyle, startNewChat } = useChatHistory({
    conversation,
    initialSessionId,
    initialTopicRecordId,
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
    replyStyleRef,
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

  const { messagesEndRef, messagesContainerRef, onCompositionStateChange: handleInputCompositionStateChange, followIfFollowing } = useChatAutoScroll({ isShown, isRestoringSession, messages, status })

  const handleInputActivity = useCallback(() => {
    markChatInputActivity()
  }, [])

  // Send handler. While the AI works the message goes into the running turn
  // (steering) or waits for the turn to end; it no longer stops the AI.
  // `editedMessageId`: an edited message is resent — the conversation is cut
  // just before it and the new text sent in its place, through the same steps
  // (synchronous save first, attachments staged) as any other message.
  // `appSent`: the app sends it in the member's place (a new consultation's or an AI turn's first message: app-instruction.ts).
  const sendTurn = useCallback(async (text: string, files?: File[], filePaths?: string[], editedMessageId?: string, instruction?: AppInstruction, onCreated?: (messageId: string) => void, appSent?: boolean) => {
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
    // From here until the request is on its way the composer is already empty: the tab is busy.
    preparingSendsRef.current += 1
    // The conversation this message belongs to (a new one may start in this tab while images are read).
    const conversationId = appSessionIdRef.current
    try {
      // Images (base64) and file paths for the request body and the bubble
      if (files && files.length > 0) {
        let images
        try {
          images = await readImages(files)
        } catch {
          // Nothing was sent: the typed text goes back into the composer.
          if (!editing) chatInputApiRef.current?.setValue(text)
          setHistoryError(IMAGE_READ_FAILED)
          return
        }
        // The tab was closed meanwhile: nothing more is done for it (its save on closing already ran).
        if (unmountedRef.current) return
        // A new conversation started here meanwhile (chat.newConsultation): it does not get this
        // message; nothing is staged for its requests, and the words and images go back into the input.
        if (appSessionIdRef.current !== conversationId) {
          returnToInput(chatInputApiRef.current, [{ text, files, filePaths }])
          setHistoryError(SEND_OUTLIVED_CONVERSATION)
          return
        }
        stageImages(images)
      }
      if (filePaths && filePaths.length > 0) stageFilePaths(filePaths)
      // Dropped records go with this message once (main reads them now); its bubble says so.
      const dropped = editing || instruction ? [] : pendingRecordsRef.current
      if (dropped.length > 0) {
        pendingRecordIdsRef.current = dropped.map(r => r.id)
        setPendingRecords([])
      }

      const metadata = { ...(instruction ? { appInstruction: instruction } : {}), ...(appSent ? { appSent: true } : {}), ...(dropped.length > 0 ? { droppedRecords: dropped } : {}) }
      const message: UIMessage = {
        id: crypto.randomUUID(), role: 'user',
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        parts: [{ type: 'text', text: text || '画像を確認してください' }],
      }
      timestampsRef.current.set(message.id, new Date())
      onCreated?.(message.id)
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
    } finally {
      preparingSendsRef.current -= 1
    }
  }, [status, sendMessage, setMessages, currentSessionId, stageImages, stageFilePaths, appSessionIdRef, chatInputApiRef, messagesRef, saveRef, setCurrentSessionId, setHistoryError, timestampsRef, resetSuggestion, sendWhileRunning, lastTurnAbortedRef, pendingRecordsRef, unmountedRef])
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
  // Something of the member's is on its way or waits on them: a turn runs, a send is still reading
  // its images (the composer is already empty), messages wait for the turn, or an approval or a
  // question is open. One rule for closing an automatic run's tab and for discarding a blank tab.
  const tabBusy = () => running || preparingSendsRef.current > 0 || queuedSends.length > 0 || !!pendingApproval || !!currentInteraction
  const offeredSuggestion = !running && !currentInteraction && !pendingApproval ? suggestions.promptSuggestion : null

  // What the tab holds, read live when an automatic run or its record ends (closing it must lose nothing).
  const readHold = () => ({
    ready: historyReadyRef.current && !deletedRef.current,
    conversationId: appSessionIdRef.current,
    draft: draftInputRef.current,
    unsent: unsentAttachmentsRef.current + pendingRecordsRef.current.length + (topicSwitch ? 1 : 0) + editingMessagesRef.current.size,
    // Not the hand-off receipt: every turn leaves one (its memo update goes on after a close).
    busy: tabBusy(),
    userMessageIds: messagesRef.current.filter(message => message.role === 'user').map(message => message.id),
    shown: isShown,
    lastReplyAsks: replyAsksTheMember(messagesRef.current),
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
      busy: tabBusy() || !!handoffRequestRef.current,
    }),
    close: () => onLeftBlank?.(),
  })

  // 「確認をお願いします」 (ReviewRequestCard): the request in the latest reply waits for the member.
  const pendingReviewId = running ? undefined : pendingReviewOf(messages[messages.length - 1])?.id
  const reviewActions = useMemo<ReviewActions>(() => ({
    pendingId: pendingReviewId,
    confirm: () => { void handleSend(REVIEW_CONFIRM_MESSAGE) },
    requestChanges: () => chatInputApiRef.current?.focus(),
    say: (text: string) => { void handleSend(text) },
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
      const { step, title, minutesId, claim, onSent } = inputRequest
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
        void sendTurn(message, undefined, undefined, undefined, undefined, onSent, true)
      })
      return
    }
    if (!isShown || !historyReadyRef.current || inputRequest?.kind !== 'newConsultation') return
    const { message, title, minutesId, topicRecordId, pluginStep, instruction, onSent } = inputRequest
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
      const conversationId = appSessionIdRef.current
      if (message) void sendTurn(message, undefined, undefined, undefined, instruction, onSent && conversationId ? messageId => onSent({ tabId, conversationId, messageId }) : undefined, true)
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

  // The topic this new consultation started with (the record open in the middle), until the member's first message:
  // a proposal by the input, not yet the consultation's heading. A dropped record's topic stays under the header.
  const topicBeforeFirstMessage = !!topicShown && topicShown === initialTopicRecordId && !messages.some(message => message.role === 'user')
  const removeTopic = useCallback(() => {
    const sessionId = appSessionIdRef.current
    setTopic(null)
    if (currentCompany?.id && sessionId) void patchChatSession(currentCompany.id, sessionId, { topicRecordId: null }).catch(() => {})
  }, [setTopic, appSessionIdRef, currentCompany?.id])

  // The usage meter and the model switch in the input's row. Memoised: ChatInput is, and a streamed chunk re-renders this tab.
  const composerTools = useMemo(() => <>
    {hasRateLimits(authMode) && <RateLimitMeter provider={authMode} size="compact" />}
    <ModelMenu authMode={authMode} codexStatus={codexStatus} models={models} modelLocked={modelLocked} replyStyle={replyStyle} onReplyStyle={setReplyStyle} />
  </>, [authMode, codexStatus, models, modelLocked, replyStyle, setReplyStyle])

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <div className="h-full flex flex-col bg-white dark:bg-zinc-900">
      {/* Header */}
      <ChatHeader
        title={title || t('chat.newChat')}
        status={status}
        onStop={stop}
        onNewChat={standalone ? undefined : onNewTab || (() => { void startNewChat().then(started => { if (started) setTitle('') }) })}
        onToggleSidebar={standalone ? undefined : onToggleSidebar}
        sidebarOpen={sidebarOpen}
        onShowSettings={onShowSettings}
        onOpenInWindow={onOpenInWindow ? () => { if (currentSessionId) onOpenInWindow(currentSessionId) } : undefined}
        openInWindowBlocked={running || !!pendingApproval || !!currentInteraction}
        onShowHandoff={currentCompany?.id && appSessionIdRef.current ? () => handoffRef.current?.open() : undefined}
      />
      {currentCompany?.id && appSessionIdRef.current && <HandoffControl ref={handoffRef} companyId={currentCompany.id} sessionId={appSessionIdRef.current} active={isShown} />}


      {/* The topic chip says the same as a task's instruction chip, with × (consultation-task.ts). A new consultation's
          starting topic sits above the input instead until the first message (on by default). */}
      {topicShown && currentCompany?.id && !topicBeforeFirstMessage
        ? <TopicChip companyId={currentCompany.id} recordId={topicShown} fallbackTitle={instructionShown?.recordId === topicShown ? instructionShown.title : undefined} onRemove={removeTopic} />
        : null}
      {instructionShown && !(topicShown && instructionShown.kind === 'task' && instructionShown.recordId === topicShown) && <AppInstructionChip instruction={instructionShown} />}

      {historyError && (
        <div role="alert" className="px-4 py-2 text-sm text-danger-text bg-danger-bg">
          {historyError}
        </div>
      )}
      {/* Error Banner */}
      {status === 'error' && error && (
        <div className="flex-shrink-0 px-4 py-2 bg-danger-bg border-b border-danger-border">
          <div className="text-sm text-danger-text">
            {chatErrorText(error.message, e => t('chat.errorOccurred', { error: e }))}
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
          <ChatFollowContext.Provider value={followIfFollowing}>
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
            onEditingChange={handleEditingChange}
          />
          </ChatFollowContext.Provider>
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
          rootPath={currentCompany?.rootPath}
          onRespond={respondToApproval}
        />
      )}

      {/* Input Area */}
      <div className="flex-shrink-0">
        <QueuedSendList queuedSends={queuedSends} onCancel={cancelQueuedSend} />
        <div className="px-3 pt-1 pb-3">
          <ChatInput
            initialDraft={draftInputRef.current}
            onDraftChange={handleDraftChange}
            voiceActive={isShown}
            voicePane={paneId}
            voiceScope={appSessionIdRef.current ?? ''}
            onSend={handleSend}
            disabled={isRestoringSession || !historyReadyRef.current || deletedRef.current || models.agentUnavailable}
            placeholder={running ? t(agentCan(authMode, 'steering') ? 'chat.inputPlaceholderWorking' : 'chat.inputPlaceholderQueued') : t('chat.inputPlaceholder')}
            hint={offeredSuggestion ? t('chat.suggestionHint') : undefined}
            tools={composerTools}
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
              : topicBeforeFirstMessage && topicShown && currentCompany?.id
                ? <TopicChip place="composer" companyId={currentCompany.id} recordId={topicShown} onRemove={removeTopic} />
                : null}
          />
        </div>
      </div>
    </div>
  )
})
