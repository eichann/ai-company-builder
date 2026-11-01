import { createAnthropic } from '@ai-sdk/anthropic'
import { wrapLanguageModel, extractReasoningMiddleware } from 'ai'
import type { AgentConnection } from './connection'
import { AGENTS } from '../../shared/agents/registry'

const API_KEY_TASKS = AGENTS['api-key'].tasks

export function createApiConnection(config: { getApiKey: () => string | undefined }): AgentConnection {
  return {
    id: 'anthropic-api',
    ownsConversation: false,
    authenticationError: () => config.getApiKey() ? undefined : 'APIキーが設定されていません。',
    createChatModel(request) {
      // An unattended step needs the restrictions it names; this mode has none of them built (ai-turns.md).
      if (request.unattended) throw new Error('API key: unattended AI turns are not supported')
      return wrapLanguageModel({
        model: createAnthropic({ apiKey: config.getApiKey() })(API_KEY_TASKS.chat!),
        middleware: extractReasoningMiddleware({ tagName: 'think' }),
      })
    },
    createTitleModel: () => createAnthropic({ apiKey: config.getApiKey() })(API_KEY_TASKS.title!),
    readMetadata: () => ({}),
  }
}
