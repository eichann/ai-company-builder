import { useCallback, useEffect, useState, type MutableRefObject } from 'react'
import type { AuthMode } from '../../../../shared/agent'
import { normalizeSuggestion } from '../../../../shared/prompt-suggestion'
import type { ChatServerClient } from '../chatServerClient'
import { canOfferSuggestion, shouldRequestSuggestion } from '../promptSuggestion'
import { promptSuggestionSetting } from '../../../lib/promptSuggestionSetting'
import type { ChatInputApi } from './useChatDraft'

export interface PromptSuggestionOptions {
  chatServer: ChatServerClient
  authModeRef: MutableRefObject<AuthMode>
  appSessionIdRef: MutableRefObject<string | null>
  inputApiRef: MutableRefObject<ChatInputApi | null>
  currentSessionId: string | null
}

/**
 * The next-prompt suggestion (promptSuggestion.ts rules; registry capability
 * `promptSuggestions`). After a finished turn the chat server is asked for it
 * (it follows the reply by about a second) and it is kept if the member has
 * not started typing. Called before useChat: onFinish reports the turn
 * through `onTurnFinished`. Whether it is shown right now (not while a turn
 * runs or a question waits) is the panel's call.
 */
export function usePromptSuggestion({ chatServer, authModeRef, appSessionIdRef, inputApiRef, currentSessionId }: PromptSuggestionOptions) {
  const [promptSuggestion, setPromptSuggestion] = useState<string | null>(null)
  const [finishedTurn, setFinishedTurn] = useState<{ n: number; suggest: boolean } | null>(null)

  /** From useChat's onFinish. */
  const onTurnFinished = useCallback((aborted: boolean) => {
    setFinishedTurn(turn => ({ n: (turn?.n ?? 0) + 1, suggest: shouldRequestSuggestion({ aborted, authMode: authModeRef.current, enabled: promptSuggestionSetting.getSnapshot() }) }))
  }, [authModeRef])

  /** A new message is sent: the offered suggestion and the pending request are dropped. */
  const resetSuggestion = useCallback(() => {
    setPromptSuggestion(null)
    setFinishedTurn(null)
  }, [])

  // After a reply: ask the chat server for Claude Code's next-prompt
  // suggestion (it follows the reply by about a second) and offer it in the
  // input if the member has not started typing.
  useEffect(() => {
    if (!finishedTurn?.suggest) return
    const sessionId = appSessionIdRef.current
    if (!sessionId) return
    let cancelled = false
    chatServer.promptSuggestion(sessionId)
      .then(data => {
        if (cancelled || appSessionIdRef.current !== sessionId) return
        const suggestion = normalizeSuggestion(data?.suggestion)
        if (suggestion && canOfferSuggestion({ running: false, waitingForMember: false, draft: inputApiRef.current?.getValue() ?? '' })) setPromptSuggestion(suggestion)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [finishedTurn, chatServer, appSessionIdRef, inputApiRef])

  useEffect(() => { setPromptSuggestion(null) }, [currentSessionId])
  const clearPromptSuggestion = useCallback(() => setPromptSuggestion(null), [])

  return { promptSuggestion, clearPromptSuggestion, onTurnFinished, resetSuggestion }
}
