import { generateText } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import type { AuthMode } from '../shared/agent'
import { AGENTS } from '../shared/agents/registry'
import { generateCodexText } from './agents/codex-text'
import { polishVoice, VOICE_SYSTEM_PROMPT } from './voice-polisher'

export type VoiceFormatter = (text: string, signal: AbortSignal) => Promise<string>
export interface VoiceFormatterConfig {
  authMode: AuthMode
  apiKey?: string
  getCli: () => string
  cwd: string
  env: Record<string, string>
  /** Fixed part + the member's 「整え方の指示」, read when recording starts. Default: the built-in prompt. */
  systemPrompt?: string
}
const defaultAdapters = {
  claude: polishVoice,
  codex: generateCodexText,
  api: async (apiKey: string, text: string, signal: AbortSignal, system: string) => {
    const result = await generateText({
      model: createAnthropic({ apiKey })(AGENTS['api-key'].tasks.voice!),
      system, prompt: JSON.stringify({ transcript: text }),
      abortSignal: signal, maxRetries: 0, maxOutputTokens: 4096,
    })
    if (result.finishReason === 'length') throw new Error('整形結果が長すぎます。原文をご確認ください')
    return result.text
  },
}

// Capture routing/credentials when recording starts, not when recognition finishes.
export function createVoiceFormatter(config: VoiceFormatterConfig, adapters = defaultAdapters): VoiceFormatter {
  const snapshot = { ...config, env: { ...config.env }, systemPrompt: config.systemPrompt ?? VOICE_SYSTEM_PROMPT }
  return async (text, signal) => {
    if (signal.aborted) throw new Error('キャンセルしました')
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal.addEventListener('abort', cancel, { once: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, 60_000)
    const startedAt = Date.now()
    let success = false
    try {
      let result: string
      if (snapshot.authMode === 'codex') {
        result = await adapters.codex({
          env: snapshot.env, cwd: snapshot.cwd, system: snapshot.systemPrompt,
          text: JSON.stringify({ transcript: text }), signal: controller.signal,
          onMetrics: metrics => console.info('[voice] codex formatting', metrics),
        })
      } else if (snapshot.authMode === 'api-key') {
        if (!snapshot.apiKey) throw new Error('APIキーが設定されていません。設定からAPIキーを登録してください')
        result = await adapters.api(snapshot.apiKey, text, controller.signal, snapshot.systemPrompt)
      } else {
        result = await adapters.claude(snapshot.getCli(), snapshot.cwd, text, controller.signal, snapshot.env, snapshot.systemPrompt)
      }
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
