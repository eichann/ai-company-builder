import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import type { UIMessage } from 'ai'
import type { ChatSession } from '../../../../shared/chat-history'
import type { ChatServerClient } from '../chatServerClient'
import { AUTOSAVE_INTERVAL_MS, greetingMessages, messageText, sameSaveInputs, sessionMessageFor, sessionMessageToUIMessage } from '../chatSessionMessages'
import type { ChatInputApi } from './useChatDraft'
import type { Conversation } from './useConversation'
import { flushChatSession, getChatSession, getChatSessionSummaries, onChatHistoryChanged, saveChatSession } from '../api'

export interface ChatHistoryOptions {
  conversation: Conversation
  /** The conversation this tab was opened with (null: a new chat). */
  initialSessionId: string | null | undefined
  companyId: string | undefined
  /** The greeting of a new conversation, and the title of one without a user message yet. */
  greeting: string
  newChatTitle: string
  isActive: boolean
  messages: UIMessage[]
  setMessages: (messages: UIMessage[]) => void
  status: string
  stop: () => void
  chatServer: ChatServerClient
  draftRef: MutableRefObject<string>
  inputApiRef: MutableRefObject<ChatInputApi | null>
  messageImages: Map<string, string[]>
  messageReferenceFiles: Map<string, string[]>
  setMessageImages: (images: Map<string, string[]>) => void
  setMessageReferenceFiles: (files: Map<string, string[]>) => void
  onTitleChange?: (title: string) => void
  onSessionIdChange?: (sessionId: string | null) => void
}

/**
 * The tab's conversation in the history store (shared/chat-history.ts):
 * restored once on mount, saved on every finished turn, every
 * AUTOSAVE_INTERVAL_MS while anything changed, synchronously when the tab is
 * left, the window unloads or the tab closes; and replaced by a fresh one in
 * startNewChat.
 *
 * Save bookkeeping (revision, writer, write sequence, fingerprints) lives in
 * refs: it changes on every save, and saves run from timers and unload
 * handlers that must see the latest values without re-rendering the chat.
 * `saveCurrentSession` is a plain function of the latest render (it reads that
 * render's attachments and title); everything outside the render calls it
 * through `conversation.saveRef`.
 */
export function useChatHistory(o: ChatHistoryOptions) {
  const { conversation, initialSessionId, companyId, isActive, messages, setMessages, status, stop, chatServer, draftRef, inputApiRef, messageImages, messageReferenceFiles, onTitleChange, onSessionIdChange } = o
  const { appSessionIdRef, claudeSessionIdRef, agentSessionRef, setHistoryError, currentSessionId, setCurrentSessionId, timestampsRef, saveRef } = conversation

  const lastNotifiedTitleRef = useRef<string | null>(null)
  const revisionRef = useRef(0)
  const writerIdRef = useRef(crypto.randomUUID())
  const writeSequenceRef = useRef(0)
  const createdAtRef = useRef(new Date().toISOString())
  const historyReadyRef = useRef(false)
  const deletedRef = useRef(false)
  const savedFingerprintRef = useRef('')
  // The objects the last acknowledged save was built from (sameSaveInputs).
  const savedInputsRef = useRef<unknown[] | null>(null)
  const pendingFingerprintRef = useRef('')
  const acknowledgedSequenceRef = useRef(0)
  const syncSaveFailedRef = useRef(false)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  // Tracks whether title auto-generation has been attempted/completed for the current session
  const titleGenerationDoneRef = useRef(false)
  // Holds an explicit title (auto-generated or user-edited) for the current session.
  // When null, saveCurrentSession falls back to deriving from the first user message.
  const customTitleRef = useRef<{ title: string; auto: boolean } | null>(null)

  // Shows a spinner over the message list while the persisted session for
  // this tab is being loaded — replaces the brief greeting→messages flicker.
  const [isRestoringSession, setIsRestoringSession] = useState(true)

  // Restore once. The stable ID is retained throughout restoration.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await loadSessions()
        const session = initialSessionId && companyId
          ? await getChatSession(companyId, initialSessionId) : null
        if (cancelled) return
        if (session) {
          revisionRef.current = session.revision ?? 0
          createdAtRef.current = session.createdAt
          claudeSessionIdRef.current = session.claudeSessionId ?? null
          agentSessionRef.current = session.agentSession
          for (const msg of session.messages) timestampsRef.current.set(msg.id, new Date(msg.timestamp))
          setMessages(session.messages.map(sessionMessageToUIMessage))
          o.setMessageImages(new Map(session.messages.filter(m => m.images).map(m => [m.id, m.images!])))
          o.setMessageReferenceFiles(new Map(session.messages.filter(m => m.referenceFiles).map(m => [m.id, m.referenceFiles!])))
          draftRef.current = session.draftInput ?? ''
          inputApiRef.current?.setValue(draftRef.current)
          titleGenerationDoneRef.current = session.titleAutoGenerated !== undefined
          customTitleRef.current = session.titleAutoGenerated !== undefined || session.messages.some(m => m.role === 'user')
            ? { title: session.title, auto: session.titleAutoGenerated ?? false } : null
          onTitleChange?.(session.title)
        } else {
          // Missing/deleted history must never reuse an old tombstoned ID.
          if (initialSessionId) {
            appSessionIdRef.current = crypto.randomUUID()
            setCurrentSessionId(appSessionIdRef.current)
          }
          setMessages(greetingMessages(o.greeting))
        }
        historyReadyRef.current = true
      } catch (e) {
        setHistoryError(e instanceof Error ? e.message : '相談の復元に失敗しました。')
      } finally {
        if (!cancelled) setIsRestoringSession(false)
      }
    })()
    return () => { cancelled = true }
    // This instance owns one conversation; opening history is handled by the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (currentSessionId) onSessionIdChange?.(currentSessionId)
  }, [currentSessionId, onSessionIdChange])

  // Persist drafts immediately when leaving a conversation, including clearing an old draft.
  useEffect(() => {
    if (!isActive) void saveRef.current(undefined, true)
  }, [isActive, saveRef])

  // Checkpoint during streaming too. A trailing debounce alone would never fire
  // while tokens keep arriving. Unload and leaving the tab flush synchronously,
  // so the interval only bounds what a crash can lose; typing in the input is
  // picked up by the next tick, not saved per keystroke.
  useEffect(() => {
    const interval = window.setInterval(() => { void saveRef.current() }, AUTOSAVE_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [saveRef])
  useEffect(() => {
    if (status === 'ready' || status === 'error') void saveRef.current()
  }, [status, messages, saveRef])

  // Subscribe to cross-tab chat history changes so each tab keeps its sessions cache in sync.
  // Without this, an action in one tab (pin toggle, rename, delete, auto-save) would not
  // be reflected in another tab's history dropdown until that tab triggers its own reload.
  useEffect(() => {
    if (!companyId) return
    const unsubscribe = onChatHistoryChanged((data) => {
      if (data.companyId === companyId) {
        if (data.deletedSessionId === appSessionIdRef.current) {
          deletedRef.current = true
          stop()
        }
        // Only a metadata change of this tab's own conversation (title from the
        // sidebar or the AI) concerns it; saves come from the tab itself.
        if (data.sessionId && (data.sessionId !== appSessionIdRef.current || data.kind !== 'patch')) return
        void loadSessions().catch(() => {})
      }
    })
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one subscription per company: `stop` and `loadSessions` are new on every render
  }, [companyId])

  // Session functions
  async function loadSessions() {
    if (!companyId) return
    try {
      // Summaries only: this tab needs its own title, never the other conversations' bodies.
      const loadedSessions = await getChatSessionSummaries(companyId)
      const current = loadedSessions.find(session => session.id === appSessionIdRef.current)
      if (current && historyReadyRef.current && current.titleAutoGenerated !== undefined) {
        customTitleRef.current = { title: current.title, auto: current.titleAutoGenerated }
        onTitleChange?.(current.title)
      }
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : '相談一覧を読み込めません。')
      throw e
    }
  }

  async function saveCurrentSession(override?: UIMessage[], sync = false, clearDraft = false): Promise<boolean> {
    if (sync) syncSaveFailedRef.current = false
    if (!companyId || !historyReadyRef.current || deletedRef.current) return false
    const snapshot = override ?? messagesRef.current
    const draftInput = clearDraft ? '' : draftRef.current
    if (!snapshot.some(m => m.role === 'user') && !draftInput.trim() && !initialSessionId && revisionRef.current === 0 && !pendingFingerprintRef.current) return true
    const sessionId = appSessionIdRef.current!
    // Nothing the fingerprint is built from changed since the last acknowledged
    // save (same objects): skip converting and serialising the whole
    // conversation. Every open tab runs the autosave, idle ones included.
    const inputs = [sessionId, snapshot, draftInput, messageImages, messageReferenceFiles, claudeSessionIdRef.current, agentSessionRef.current]
    if (!override && !pendingFingerprintRef.current && savedFingerprintRef.current && sameSaveInputs(savedInputsRef.current, inputs)) return true
    const firstUser = snapshot.find(m => m.role === 'user')
    const title = customTitleRef.current?.title || (firstUser ? messageText(firstUser).slice(0, 60) : o.newChatTitle)
    const session: ChatSession = {
      id: sessionId, companyId, title,
      messages: snapshot.map(m => sessionMessageFor(m, timestampsRef.current.get(m.id) || new Date(), messageImages.get(m.id), messageReferenceFiles.get(m.id))),
      draftInput,
      createdAt: createdAtRef.current, updatedAt: new Date().toISOString(),
      revision: revisionRef.current,
      writerId: writerIdRef.current,
      writeSequence: ++writeSequenceRef.current,
      ...(agentSessionRef.current !== undefined ? { agentSession: agentSessionRef.current } : {}),
      ...(claudeSessionIdRef.current ? { claudeSessionId: claudeSessionIdRef.current } : {}),
      ...(customTitleRef.current ? { titleAutoGenerated: customTitleRef.current.auto } : {}),
    }
    const fingerprint = JSON.stringify([sessionId, session.messages, draftInput, session.claudeSessionId, session.agentSession])
    if (!override && fingerprint === savedFingerprintRef.current && !pendingFingerprintRef.current) return true
    if (!sync && !override && fingerprint === pendingFingerprintRef.current) return true
    pendingFingerprintRef.current = fingerprint
    try {
      const result = sync
        ? flushChatSession(companyId, session)
        : await saveChatSession(companyId, session)
      if (appSessionIdRef.current !== sessionId) return true
      if (result.status === 'deleted') {
        deletedRef.current = true
        return false
      }
      if (result.status === 'conflict') throw new Error('別の画面で相談が更新されました。上書きを止めています。未保存の文章をコピーしてから開き直してください。')
      revisionRef.current = Math.max(revisionRef.current, result.revision)
      if (session.writeSequence! >= acknowledgedSequenceRef.current) {
        acknowledgedSequenceRef.current = session.writeSequence!
        savedFingerprintRef.current = fingerprint
        savedInputsRef.current = inputs
      }
      if (pendingFingerprintRef.current === fingerprint) pendingFingerprintRef.current = ''
      setHistoryError(null)
      if (title !== lastNotifiedTitleRef.current) {
        lastNotifiedTitleRef.current = title
        onTitleChange?.(title)
      }
      return true
    } catch (e) {
      if (sync) syncSaveFailedRef.current = true
      if (appSessionIdRef.current === sessionId) {
        savedFingerprintRef.current = ''
        pendingFingerprintRef.current = ''
        setHistoryError(e instanceof Error ? e.message : '相談を保存できませんでした。')
      }
      return false
    }
  }
  saveRef.current = saveCurrentSession

  async function startNewChat(options?: { skipSave?: boolean }) {
    // Stop any in-flight stream so a partial assistant response is captured before saving
    if (status === 'streaming' || status === 'submitted') {
      stop()
      await new Promise(r => setTimeout(r, 150))
    }
    // Save current session (including draft input) before starting a new one.
    // Skipped when invoked right after deleting the active session, so the
    // deleted session is not re-persisted from the still-populated state.
    if (!options?.skipSave) {
      if (!await saveCurrentSession()) return false
    }
    // Clear Claude CLI session mapping on the server
    if (appSessionIdRef.current) chatServer.forgetSession(appSessionIdRef.current)
    appSessionIdRef.current = crypto.randomUUID()
    writerIdRef.current = crypto.randomUUID()
    writeSequenceRef.current = 0
    revisionRef.current = 0
    createdAtRef.current = new Date().toISOString()
    savedFingerprintRef.current = ''
    pendingFingerprintRef.current = ''
    acknowledgedSequenceRef.current = 0
    deletedRef.current = false
    claudeSessionIdRef.current = null
    agentSessionRef.current = null
    timestampsRef.current.clear()
    const greeting = greetingMessages(o.greeting)
    messagesRef.current = greeting
    setMessages(greeting)
    setCurrentSessionId(appSessionIdRef.current)
    // Clear the input for the fresh chat (per-session draft is empty by default)
    inputApiRef.current?.setValue('')
    // Allow auto-title generation for the new session
    titleGenerationDoneRef.current = false
    customTitleRef.current = null
    return true
  }

  // Flush before window reload/close and before an editor is detached on tab close.
  useLayoutEffect(() => {
    const flush = (event?: BeforeUnloadEvent) => {
      // The sync branch finishes before its returned Promise settles.
      void saveRef.current(undefined, true)
      if (event && syncSaveFailedRef.current) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
      stop()
      // Clean up Claude CLI session on the server when tab is closed
      if (appSessionIdRef.current) chatServer.forgetSession(appSessionIdRef.current)
    }
  }, [chatServer, stop, saveRef, appSessionIdRef])

  return { isRestoringSession, historyReadyRef, deletedRef, messagesRef, titleGenerationDoneRef, customTitleRef, startNewChat }
}
