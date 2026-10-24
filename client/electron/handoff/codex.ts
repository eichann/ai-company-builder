import { CodexRpc } from '../agents/codex-rpc'
import { readCodexModels, requireChatGPT, type CodexTransport } from '../agents/codex'
import { CODEX_TEXT_OVERRIDES } from '../agents/codex-text'
import { CODEX_WINDOWS_UNSUPPORTED } from '../../shared/agent'
import { AGENTS } from '../../shared/agents/registry'
import { HANDOFF_SYSTEM, HANDOFF_TOOL, HANDOFF_TOOL_DESCRIPTION, HANDOFF_TIMEOUT_MS, handoffInputText, saveHandoffArguments, type HandoffRequest, type HandoffMetrics } from './contract'

type Factory = (env: Record<string, string>, overrides: string[]) => CodexTransport
export function writeCodexHandoff(request: HandoffRequest, createRpc: Factory = (env, overrides) => new CodexRpc(env, overrides)): Promise<HandoffMetrics> {
  if (process.platform === 'win32') return Promise.reject(new Error(CODEX_WINDOWS_UNSUPPORTED))
  const input = handoffInputText(request.input)
  request.signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const metrics: HandoffMetrics = { provider: 'codex', model: '', setupMs: 0, saveMs: 0, totalMs: 0, toolCalls: 0 }
    let rpc: CodexTransport | undefined
    let threadId: string | undefined
    let turnId: string | undefined
    let done = false
    let saved = false
    let textItems = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      request.signal.removeEventListener('abort', cancel)
      if (error && threadId && turnId) rpc?.send({ id: 'stop-handoff', method: 'turn/interrupt', params: { threadId, turnId } })
      rpc?.close()
      if (error) reject(error)
      else if (!saved) reject(new Error('専用ツールによる保存を確認できませんでした'))
      else resolve({ ...metrics, totalMs: Date.now() - startedAt })
    }
    function cancel() { finish(new Error('引き継ぎメモの生成を中止しました')) }
    timer = setTimeout(() => finish(new Error('引き継ぎメモの生成がタイムアウトしました')), HANDOFF_TIMEOUT_MS)
    request.signal.addEventListener('abort', cancel, { once: true })
    void (async () => {
      rpc = createRpc(request.env, CODEX_TEXT_OVERRIDES)
      rpc.onFailure = finish
      rpc.onMessage = message => {
        if (done) return
        try {
          const p = message.params || {}
          if (p.threadId && threadId && p.threadId !== threadId) throw new Error('異なる相談への要求です')
          if (message.id !== undefined && message.method) {
            if (message.method !== 'item/tool/call' || p.tool !== HANDOFF_TOOL || (p.namespace != null && p.namespace !== '') || !threadId || p.threadId !== threadId || (turnId && p.turnId !== turnId)) {
              rpc!.send({ id: message.id, error: { code: -32601, message: 'Only save_handoff is allowed' } })
              throw new Error('引き継ぎ以外の操作が要求されました')
            }
            if (++metrics.toolCalls > 1) throw new Error('メモ保存は1回だけ許可されています')
            request.signal.throwIfAborted()
            saveHandoffArguments(p.arguments, request.save)
            saved = true
            metrics.saveMs = Date.now() - startedAt
            rpc!.send({ id: message.id, result: { contentItems: [{ type: 'inputText', text: '保存しました。終了してください。' }], success: true } })
            return
          }
          if (message.method === 'turn/started') turnId = (p.turn as { id: string }).id
          if (message.method === 'thread/tokenUsage/updated') {
            // Cumulative total includes the tool-call response and the final response, unlike `last`.
            const usage = (p.tokenUsage as { total: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; reasoningOutputTokens: number } }).total
            Object.assign(metrics, usage)
          }
          if (message.method === 'item/started' || message.method === 'item/completed') {
            const item = p.item as { type: string }
            if (!['userMessage', 'agentMessage', 'reasoning', 'dynamicToolCall'].includes(item.type)) throw new Error('引き継ぎ以外のツールが実行されました')
            if (message.method === 'item/started' && item.type === 'agentMessage' && ++textItems > 2) throw new Error('応答回数が上限を超えました')
          }
          if (message.method === 'turn/completed') {
            const turn = p.turn as { status: string; error?: { message: string } }
            finish(turn.status === 'completed' ? undefined : new Error(turn.error?.message || '引き継ぎ生成に失敗しました'))
          }
          if (message.method === 'error' && p.willRetry !== true) finish(new Error((p.error as { message?: string })?.message || '引き継ぎ生成に失敗しました'))
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
      }
      await rpc.initialize(true)
      if (done) return
      await requireChatGPT(rpc)
      if (done) return
      const models = await readCodexModels(rpc)
      const modelId = request.modelId || AGENTS.codex.tasks.handoff!
      const model = models.find(m => m.id === modelId)
      if (!model) throw new Error(`検証用モデル ${modelId} を利用できません`)
      metrics.model = model.id
      if (done) return
      const { config } = await rpc.request<{ config: { mcp_servers?: Record<string, unknown> } }>('config/read', { includeLayers: false })
      if (done) return
      const mcpServers = Object.fromEntries(Object.keys(config.mcp_servers || {}).map(name => [name, { enabled: false }]))
      const start = await rpc.request<{ thread: { id: string } }>('thread/start', {
        model: model.id, modelProvider: 'openai', cwd: request.cwd, ephemeral: true,
        sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user',
        baseInstructions: HANDOFF_SYSTEM, developerInstructions: 'save_handoffだけを1回呼び出して終了してください。',
        config: { mcp_servers: mcpServers },
        dynamicTools: [{ type: 'function', name: HANDOFF_TOOL, description: HANDOFF_TOOL_DESCRIPTION, inputSchema: {
          type: 'object', properties: { markdown: { type: 'string' } }, required: ['markdown'], additionalProperties: false,
        } }],
      })
      threadId = start.thread.id
      metrics.nativeSessionId = threadId
      metrics.setupMs = Date.now() - startedAt
      if (done) return
      const turn = await rpc.request<{ turn: { id: string } }>('turn/start', {
        threadId, model: model.id, effort: model.efforts.includes('low') ? 'low' : model.defaultEffort,
        input: [{ type: 'text', text: input, text_elements: [] }],
      })
      turnId = turn.turn.id
    })().catch(error => finish(error instanceof Error ? error : new Error(String(error))))
  })
}
