import { CODEX_LOGIN_HELP, CODEX_WINDOWS_UNSUPPORTED, type CodexModel } from '../../shared/agent'
import { CodexRpc } from './codex-rpc'
import { readCodexModels, requireChatGPT, type CodexTransport } from './codex'
import { AGENTS } from '../../shared/agents/registry'

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
    : models.find(m => m.id === AGENTS.codex.tasks.voice) || models.find(m => m.isDefault) || models[0]
  if (!model) throw new Error('音声整形に利用できるCodexモデルがありません。接続を再確認してください。')
  return { model, effort: model.efforts.includes('low') ? 'low' : model.defaultEffort }
}

/**
 * What kind of one-shot this is: the overrides it runs with, the items it
 * may produce, its time limit and the wording of its failures. Default: voice
 * formatting (also commit messages); the Web reader has its own
 * (codex-web-reader.ts).
 */
export interface CodexTextJob {
  overrides: readonly string[]
  /** Item types the turn may produce; any other stops it. */
  allowedItems: readonly string[]
  timeoutMs: number
  /** The model from the live catalog (throws a plain message when there is none). */
  selectModel: (models: CodexModel[], requested?: string) => { model: CodexModel; effort: string }
  messages: {
    cancelled: string
    timedOut: string
    /** Codex asked the app for something (an approval, input). */
    requested: string
    /** Codex produced an item outside `allowedItems`. */
    tool: string
    empty: string
    tooLong: string
    limited: string
    failed: string
  }
  /** Each completed item (for the reader's sources); never logged. */
  onItem?: (item: Record<string, unknown>) => void
}

export const CODEX_VOICE_JOB: CodexTextJob = {
  overrides: CODEX_TEXT_OVERRIDES,
  allowedItems: ['userMessage', 'agentMessage', 'reasoning'],
  timeoutMs: 60_000,
  selectModel: selectVoiceModel,
  messages: {
    cancelled: 'キャンセルしました',
    timedOut: '文章の整形がタイムアウトしました',
    requested: '音声整形中に不要な操作が要求されたため停止しました',
    tool: '音声整形ではツールを使用できません',
    empty: 'Codexから有効な整形結果を取得できませんでした',
    tooLong: '整形結果が長すぎます',
    limited: 'Codexの利用上限または一時的な制限により整形できませんでした。しばらく待って再度お試しください。原文は保持されます。',
    failed: 'Codexで整形できませんでした',
  },
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
  /** Default CODEX_VOICE_JOB. */
  job?: CodexTextJob
}
export function generateCodexText(request: CodexTextRequest, createRpc: (env: Record<string, string>, overrides: string[]) => CodexTransport = (env, overrides) => new CodexRpc(env, overrides)): Promise<string> {
  const job = request.job ?? CODEX_VOICE_JOB
  const words = job.messages
  if (process.platform === 'win32') return Promise.reject(new Error(CODEX_WINDOWS_UNSUPPORTED))
  if (request.signal.aborted) return Promise.reject(new Error(words.cancelled))
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
      if (error && /429|usage limit|rate.?limit/i.test(error.message)) error = new Error(words.limited)
      done = true
      clearTimeout(timer)
      request.signal.removeEventListener('abort', cancel)
      if (error && threadId && turnId) rpc?.send({ id: 'stop-voice', method: 'turn/interrupt', params: { threadId, turnId } })
      rpc?.close()
      if (error) reject(error)
      else if (!output.trim()) reject(new Error(words.empty))
      else {
        request.onMetrics?.({ model: selectedModel, setupMs: generationAt - startedAt, generationMs: Date.now() - generationAt, ...usage })
        resolve(output.trim())
      }
    }
    function cancel() { finish(new Error(words.cancelled)) }
    timer = setTimeout(() => finish(new Error(words.timedOut)), job.timeoutMs)
    request.signal.addEventListener('abort', cancel, { once: true })
    void (async () => {
      rpc = createRpc(request.env, job.overrides as string[])
      rpc.onFailure = error => finish(new Error(`${error.message}\n${CODEX_LOGIN_HELP}`))
      rpc.onMessage = message => {
        if (done) return
        if (message.id !== undefined && message.method) {
          rpc?.send({ id: message.id, error: { code: -32601, message: 'Tools are disabled for voice formatting' } })
          finish(new Error(words.requested))
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
          if (!job.allowedItems.includes(item.type)) {
            finish(new Error(words.tool)); return
          }
          if (message.method === 'item/completed') job.onItem?.(p.item as Record<string, unknown>)
          // Only complete final text: never insert commentary or duplicate streamed deltas.
          if (message.method === 'item/completed' && item.type === 'agentMessage' && item.phase !== 'commentary') output = item.text || ''
        }
        if (message.method === 'item/agentMessage/delta') {
          streamedCharacters += String(p.delta || '').length
          if (streamedCharacters > 100_000) finish(new Error(words.tooLong))
        }
        if (output.length > 100_000) finish(new Error(words.tooLong))
        if (message.method === 'turn/completed') {
          const turn = p.turn as { status: string; error?: { message: string } }
          finish(turn.status === 'completed' ? undefined : new Error(turn.error?.message || words.failed))
        }
        if (message.method === 'error' && p.willRetry !== true) finish(new Error((p.error as { message?: string })?.message || words.failed))
      }
      await rpc.initialize()
      if (done) return
      await requireChatGPT(rpc)
      if (done) return
      const { model, effort } = job.selectModel(await readCodexModels(rpc), request.modelId)
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
