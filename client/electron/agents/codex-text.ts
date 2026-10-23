import { CODEX_LOGIN_HELP, CODEX_WINDOWS_UNSUPPORTED, type CodexModel } from '../../shared/agent'
import { CodexRpc } from './codex-rpc'
import { readCodexModels, requireChatGPT, type CodexTransport } from './codex'

// Process-local overrides; never write the user's Codex configuration or copy credentials.
const disabledFeatures = ['shell_tool', 'unified_exec', 'shell_snapshot', 'apply_patch_freeform', 'apps', 'plugins', 'remote_plugin', 'hooks', 'codex_hooks', 'plugin_hooks', 'memories', 'memory_tool', 'multi_agent', 'multi_agent_v2', 'collab', 'code_mode', 'js_repl', 'browser_use', 'computer_use', 'image_generation', 'imagegenext', 'view_image', 'skill_search', 'tool_search', 'request_permissions', 'request_permissions_tool', 'goals']
export const CODEX_TEXT_OVERRIDES = [
  ...disabledFeatures.map(name => `features.${name}=false`),
  'features.skip_host_skill_discovery=true', 'skills.include_instructions=false', 'skills.bundled.enabled=false',
  'project_doc_max_bytes=0', 'web_search="disabled"', 'tools.update_plan.enabled=false',
  'tools.experimental_request_user_input.enabled=false', 'include_apps_instructions=false',
]

export function selectVoiceModel(models: CodexModel[], requested?: string) {
  // Prefer the lightweight model verified for Japanese dictation; resolve access from the live catalog.
  const model = requested ? models.find(m => m.id === requested)
    : models.find(m => m.id === 'gpt-5.6-luna') || models.find(m => m.isDefault) || models[0]
  if (!model) throw new Error('音声整形に利用できるCodexモデルがありません。接続を再確認してください。')
  return { model, effort: model.efforts.includes('low') ? 'low' : model.defaultEffort }
}

export interface CodexTextRequest {
  env: Record<string, string>
  cwd: string
  system: string
  text: string
  signal: AbortSignal
  modelId?: string
  /** Default: the voice formatter's. */
  developerInstructions?: string
  onMetrics?: (metrics: { model: string; setupMs: number; generationMs: number; inputTokens?: number; outputTokens?: number }) => void
}
export function generateCodexText(request: CodexTextRequest, createRpc: (env: Record<string, string>, overrides: string[]) => CodexTransport = (env, overrides) => new CodexRpc(env, overrides)): Promise<string> {
  if (process.platform === 'win32') return Promise.reject(new Error(CODEX_WINDOWS_UNSUPPORTED))
  if (request.signal.aborted) return Promise.reject(new Error('キャンセルしました'))
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    let rpc: CodexTransport | undefined
    let done = false
    let threadId: string | undefined
    let turnId: string | undefined
    let generationAt = 0
    let selectedModel = ''
    let output = ''
    let streamedCharacters = 0
    let usage: { inputTokens?: number; outputTokens?: number } = {}
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error) => {
      if (done) return
      if (error && /429|usage limit|rate.?limit/i.test(error.message)) error = new Error('Codexの利用上限または一時的な制限により整形できませんでした。しばらく待って再度お試しください。原文は保持されます。')
      done = true
      clearTimeout(timer)
      request.signal.removeEventListener('abort', cancel)
      if (error && threadId && turnId) rpc?.send({ id: 'stop-voice', method: 'turn/interrupt', params: { threadId, turnId } })
      rpc?.close()
      if (error) reject(error)
      else if (!output.trim()) reject(new Error('Codexから有効な整形結果を取得できませんでした'))
      else {
        request.onMetrics?.({ model: selectedModel, setupMs: generationAt - startedAt, generationMs: Date.now() - generationAt, ...usage })
        resolve(output.trim())
      }
    }
    function cancel() { finish(new Error('キャンセルしました')) }
    timer = setTimeout(() => finish(new Error('文章の整形がタイムアウトしました')), 60_000)
    request.signal.addEventListener('abort', cancel, { once: true })
    void (async () => {
      rpc = createRpc(request.env, CODEX_TEXT_OVERRIDES)
      rpc.onFailure = error => finish(new Error(`${error.message}\n${CODEX_LOGIN_HELP}`))
      rpc.onMessage = message => {
        if (done) return
        if (message.id !== undefined && message.method) {
          rpc?.send({ id: message.id, error: { code: -32601, message: 'Tools are disabled for voice formatting' } })
          finish(new Error('音声整形中に不要な操作が要求されたため停止しました'))
          return
        }
        const p = message.params || {}
        if (p.threadId && threadId && p.threadId !== threadId) return
        if (message.method === 'turn/started') turnId = (p.turn as { id: string }).id
        if (message.method === 'thread/tokenUsage/updated') {
          const last = (p.tokenUsage as { last: typeof usage }).last
          usage = { inputTokens: last.inputTokens, outputTokens: last.outputTokens }
        }
        if (message.method === 'item/started' || message.method === 'item/completed') {
          const item = p.item as { type: string; text?: string; phase?: string }
          if (!['userMessage', 'agentMessage', 'reasoning'].includes(item.type)) {
            finish(new Error('音声整形ではツールを使用できません')); return
          }
          // Only complete final text: never insert commentary or duplicate streamed deltas.
          if (message.method === 'item/completed' && item.type === 'agentMessage' && item.phase !== 'commentary') output = item.text || ''
        }
        if (message.method === 'item/agentMessage/delta') {
          streamedCharacters += String(p.delta || '').length
          if (streamedCharacters > 100_000) finish(new Error('整形結果が長すぎます'))
        }
        if (output.length > 100_000) finish(new Error('整形結果が長すぎます'))
        if (message.method === 'turn/completed') {
          const turn = p.turn as { status: string; error?: { message: string } }
          finish(turn.status === 'completed' ? undefined : new Error(turn.error?.message || 'Codexで整形できませんでした'))
        }
        if (message.method === 'error' && p.willRetry !== true) finish(new Error((p.error as { message?: string })?.message || 'Codexで整形できませんでした'))
      }
      await rpc.initialize()
      if (done) return
      await requireChatGPT(rpc)
      if (done) return
      const { model, effort } = selectVoiceModel(await readCodexModels(rpc), request.modelId)
      selectedModel = model.id
      if (done) return
      // Disable configured MCP servers individually: an empty table would merge with user configuration.
      const { config } = await rpc.request<{ config: { mcp_servers?: Record<string, unknown> } }>('config/read', { includeLayers: false })
      if (done) return
      const mcpServers = Object.fromEntries(Object.keys(config.mcp_servers || {}).map(name => [name, { enabled: false }]))
      const result = await rpc.request<{ thread: { id: string } }>('thread/start', {
        model: model.id, modelProvider: 'openai', cwd: request.cwd, ephemeral: true,
        sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user',
        baseInstructions: request.system, developerInstructions: request.developerInstructions ?? '音声整形だけを行い、ツール・スキルを使用しないでください。',
        config: { mcp_servers: mcpServers },
      })
      threadId = result.thread.id
      if (done) return
      generationAt = Date.now()
      const turn = await rpc.request<{ turn: { id: string } }>('turn/start', {
        threadId, model: model.id, effort, input: [{ type: 'text', text: request.text, text_elements: [] }],
      })
      turnId = turn.turn.id
    })().catch(error => finish(error instanceof Error ? error : new Error(String(error))))
  })
}
