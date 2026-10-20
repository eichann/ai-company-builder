import { createAnthropic } from '@ai-sdk/anthropic'
import { wrapLanguageModel, extractReasoningMiddleware } from 'ai'
import type { AgentConnection } from './connection'

export function createApiConnection(config: { getApiKey: () => string | undefined }): AgentConnection {
  return {
    id: 'anthropic-api',
    ownsConversation: false,
    authenticationError: () => config.getApiKey() ? undefined : 'APIキーが設定されていません。',
    createChatModel() {
      return wrapLanguageModel({
        model: createAnthropic({ apiKey: config.getApiKey() })('claude-sonnet-4-20250514'),
        middleware: extractReasoningMiddleware({ tagName: 'think' }),
      })
    },
    createTitleModel: () => createAnthropic({ apiKey: config.getApiKey() })('claude-haiku-4-5-20251001'),
    readMetadata: () => ({}),
  }
}
