import { query, createSdkMcpServer, tool, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { spawnAgentProcess } from '../agents/process'
import { HANDOFF_SYSTEM, HANDOFF_TOOL, HANDOFF_TOOL_DESCRIPTION, HANDOFF_TIMEOUT_MS, handoffInputText, saveHandoffArguments, type HandoffRequest, type HandoffMetrics } from './contract'

export async function writeClaudeHandoff(request: HandoffRequest & { cli: string }): Promise<HandoffMetrics> {
  const text = handoffInputText(request.input)
  request.signal.throwIfAborted()
  const startedAt = Date.now()
  const abortController = new AbortController()
  const cancel = () => abortController.abort()
  request.signal.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(cancel, HANDOFF_TIMEOUT_MS)
  const metrics: HandoffMetrics = { provider: 'claude-code', model: request.modelId || 'haiku', setupMs: 0, saveMs: 0, totalMs: 0, toolCalls: 0 }
  const server = createSdkMcpServer({ name: 'handoff', version: '1.0.0', tools: [
    tool(HANDOFF_TOOL, HANDOFF_TOOL_DESCRIPTION, { markdown: z.string() }, async args => {
      abortController.signal.throwIfAborted()
      if (metrics.toolCalls++) throw new Error('メモ保存は1回だけ許可されています')
      saveHandoffArguments(args, request.save)
      metrics.saveMs = Date.now() - startedAt
      return { content: [{ type: 'text' as const, text: '保存しました。終了してください。' }] }
    }),
  ] })
  const env = { ...request.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
  // Existing subscription login only; do not accidentally run this experiment against API billing.
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete (env as Record<string, string>)[key]
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' }
  }
  const response = query({ prompt: prompt(), options: {
    pathToClaudeCodeExecutable: request.cli, cwd: request.cwd, env, abortController,
    model: request.modelId || 'haiku', systemPrompt: HANDOFF_SYSTEM, tools: [],
    allowedTools: ['mcp__handoff__save_handoff'], mcpServers: { handoff: server }, strictMcpConfig: true,
    settingSources: [], persistSession: false, maxTurns: 2, thinking: { type: 'disabled' },
    extraArgs: { 'safe-mode': null, 'disable-slash-commands': null },
    canUseTool: async () => ({ behavior: 'deny', message: '引き継ぎメモ以外の操作は許可されていません' }),
    spawnClaudeCodeProcess: spawnAgentProcess,
  } })
  let completed = false
  try {
    for await (const message of response) {
      abortController.signal.throwIfAborted()
      if (message.type === 'system' && message.subtype === 'init') {
        metrics.model = message.model
        metrics.nativeSessionId = message.session_id
        metrics.setupMs = Date.now() - startedAt
        if (message.tools.some((name: string) => name !== 'mcp__handoff__save_handoff')) throw new Error('不要なツールが有効です')
      }
      if (message.type === 'result') {
        const usage = message.usage
        metrics.inputTokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
        metrics.cachedInputTokens = usage.cache_read_input_tokens
        metrics.cacheWriteInputTokens = usage.cache_creation_input_tokens
        metrics.outputTokens = usage.output_tokens
        metrics.reportedTurns = message.num_turns
        if (message.subtype !== 'success' || message.is_error) throw new Error(`引き継ぎ生成が正常終了しませんでした: ${message.subtype}`)
        completed = true
      }
    }
    if (!completed || metrics.toolCalls !== 1 || !metrics.saveMs) throw new Error('専用ツールによる保存を確認できませんでした')
    return { ...metrics, totalMs: Date.now() - startedAt }
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener('abort', cancel)
    response.close()
  }
}
