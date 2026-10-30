import type { AuthMode } from '../shared/agent'
import { isAgentId, type AgentId } from '../shared/agents/registry'
import { oneShotUnavailable, runOneShotText, type OneShotTextRequest } from './agents/registry'
import { VOICE_MESSAGES, VOICE_SYSTEM_PROMPT } from './voice-polisher'

export type VoiceFormatter = (text: string, signal: AbortSignal) => Promise<string>
export interface VoiceFormatterConfig {
  authMode: AuthMode
  apiKey?: string
  getCli: () => string
  cwd: string
  env: Record<string, string>
  /** Fixed part + the member's 「整え方の指示」, read when recording starts. Default: the built-in prompt. */
  systemPrompt?: string
  /** False while an administrator has stopped the AI (agent-stop.md): the transcript is used as is, no AI is asked. */
  aiAllowed?: () => boolean
}
/** Runs one agent's one-shot job (agents/registry.ts); tests inject their own. */
export type VoiceAdapter = (agent: AgentId, request: OneShotTextRequest) => Promise<string>

// Capture routing/credentials when recording starts, not when recognition finishes.
export function createVoiceFormatter(config: VoiceFormatterConfig, adapter: VoiceAdapter = runOneShotText): VoiceFormatter {
  const snapshot = { ...config, env: { ...config.env }, systemPrompt: config.systemPrompt ?? VOICE_SYSTEM_PROMPT }
  return async (text, signal) => {
    if (signal.aborted) throw new Error('キャンセルしました')
    if (snapshot.aiAllowed && !snapshot.aiAllowed()) {
      console.info('[voice] the AI is stopped by an administrator; using the transcript as is')
      return text
    }
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal.addEventListener('abort', cancel, { once: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, 60_000)
    const startedAt = Date.now()
    let success = false
    try {
      // A stored value the app does not know runs Claude Code, as it always did.
      const agent: AgentId = isAgentId(snapshot.authMode) ? snapshot.authMode : 'claude-code'
      const host = { getCli: snapshot.getCli, cwd: snapshot.cwd, env: snapshot.env, apiKey: snapshot.apiKey }
      const unavailable = oneShotUnavailable(agent, host)
      if (unavailable) throw new Error(unavailable)
      // The member's own agent only: a failure never falls back to another one.
      const result = await adapter(agent, {
        job: 'voice', system: snapshot.systemPrompt, input: { transcript: text }, signal: controller.signal, host,
        timeoutMs: 60_000, maxOutputTokens: 4096, cliMessages: VOICE_MESSAGES,
        truncatedMessage: '整形結果が長すぎます。原文をご確認ください',
        onMetrics: metrics => console.info(`[voice] ${agent} formatting`, metrics),
      })
      if (controller.signal.aborted) throw new Error('キャンセルしました')
      if (!result.trim() || result.length > 100_000) throw new Error('有効な整形結果を取得できませんでした。原文をご確認ください')
      success = true
      return result.trim()
    } catch (error) {
      if (timedOut) throw new Error('文章の整形がタイムアウトしました。原文をご確認ください')
      throw error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      // Never log dictation content, results or credentials.
      console.info('[voice] formatting finished', { provider: snapshot.authMode, durationMs: Date.now() - startedAt, success })
    }
  }
}
