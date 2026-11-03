// Tag suggestions for a task (tasks-ui.md "Tag suggestions", owner 2026-11-02): asked here, in
// the member's app, of a Claude Haiku model through the company's key — the key broker's relay
// with a short-lived token, so the key the admin chose for anthropic is used and the relay records
// it. Text only: no tools, no files, no commands. Sent: the task's title and the tags in use,
// nothing else. No usable key, the AI stopped, offline, a refusal or no answer within the time
// → the app's own matching, without a word to the member. Suggestions are only offered.
import { createAnthropic } from '@ai-sdk/anthropic'
import { generateText } from 'ai'
import { looksLikeBrokerToken, brokerServiceEnvNames } from '../../../../shared/core/key-broker'
import { COMPANY_KEY_MODELS } from '../../../shared/agents/registry'
import {
  localTagSuggestions, parseTagSuggestions, TAG_SUGGEST_SYSTEM, tagSuggestInput, tagSuggestMessage,
  type TagSuggestions,
} from '../../../shared/tag-suggest'

/** The one text call: the relay's base URL (`…/api/broker/anthropic`) and the token stand in for the key. */
export interface TagSuggestCall {
  baseUrl: string
  token: string
  model: string
  system: string
  message: string
  signal: AbortSignal
}

export interface TagSuggestDeps {
  /** The broker's variables for one job (`BrokerTokenStore.envFor`; {} when off or unreachable). */
  brokerEnv: (request: { companyId: string; conversationId: string }) => Promise<Record<string, string>>
  /** False while an administrator has stopped the AI (agent-stop.md). */
  aiAllowed?: () => boolean
  generate?: (call: TagSuggestCall) => Promise<string>
  timeoutMs?: number
  log?: Pick<Console, 'warn'>
}

/** The broker token's name for this job (one token per company, reused while it lasts). */
export const TAG_SUGGEST_JOB = 'app:tag-suggest'
export const TAG_SUGGEST_TIMEOUT_MS = 5000
const COMPANY = /^[A-Za-z0-9_-]{1,100}$/
const ANTHROPIC = brokerServiceEnvNames('anthropic')

async function generateWithAiSdk(call: TagSuggestCall): Promise<string> {
  const result = await generateText({
    model: createAnthropic({ apiKey: call.token, baseURL: `${call.baseUrl.replace(/\/+$/, '')}/v1` })(call.model),
    system: call.system, prompt: call.message,
    abortSignal: call.signal, maxRetries: 0, maxOutputTokens: 200,
  })
  return result.text
}

export function createTagSuggester(deps: TagSuggestDeps) {
  const generate = deps.generate ?? generateWithAiSdk
  const log = deps.log ?? console
  return {
    async suggest(companyId: string, title: unknown, tags: unknown): Promise<TagSuggestions> {
      const input = tagSuggestInput(title, tags)
      if (!input || !COMPANY.test(companyId)) return { source: 'local', tags: [] }
      const local: TagSuggestions = { source: 'local', tags: localTagSuggestions(input.title, input.tags) }
      if (input.tags.length === 0 || deps.aiAllowed?.() === false) return local
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? TAG_SUGGEST_TIMEOUT_MS)
      try {
        const env = await deps.brokerEnv({ companyId, conversationId: TAG_SUGGEST_JOB })
        const token = env[ANTHROPIC.key]
        const baseUrl = env[ANTHROPIC.baseUrl]
        // The placeholder (no key for this member) is not a token: nothing is sent.
        if (!looksLikeBrokerToken(token) || !baseUrl) return local
        const text = await generate({
          baseUrl, token, model: COMPANY_KEY_MODELS.tagSuggest,
          system: TAG_SUGGEST_SYSTEM, message: tagSuggestMessage(input), signal: controller.signal,
        })
        return { source: 'ai', tags: parseTagSuggestions(text, input.tags) }
      } catch (error) {
        // Never the title, the tags or the token: only that it fell back.
        log.warn(`[tasks] tag suggestion: ${controller.signal.aborted ? 'no answer in time' : (error as Error)?.name ?? 'failed'}; the app's own matching instead`)
        return local
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
