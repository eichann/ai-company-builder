import { MissingAgentSession } from './recovery'
import type { AgentInteraction } from '../../shared/agent-interaction'
import { readQuestions, describePermissions } from './codex-interactions'
import { CODEX_LOGIN_HELP, CODEX_WINDOWS_UNSUPPORTED } from '../../shared/agent'
import type { LanguageModel } from 'ai'
import crypto from 'node:crypto'
import os from 'node:os'
import type { CodexModel, CodexStatus } from '../../shared/agent'
import type { AgentConnection, AgentHostConfig } from './connection'
import { CodexRpc, type RpcMessage } from './codex-rpc'

type Model = Extract<LanguageModel, { specificationVersion: 'v3' }>
type StreamResult = Awaited<ReturnType<Model['doStream']>>
type Part = StreamResult['stream'] extends ReadableStream<infer T> ? T : never
type Usage = Extract<Part, { type: 'finish' }>['usage']
type Request = Parameters<AgentConnection['createChatModel']>[0]
export type CodexTransport = Pick<CodexRpc, 'initialize' | 'request' | 'send' | 'close' | 'onMessage' | 'onFailure'>
type RpcFactory = (env: Record<string, string>) => CodexTransport
const defaultRpc: RpcFactory = env => new CodexRpc(env)
type Config = AgentHostConfig
interface NativeModel { model: string; displayName: string; hidden?: boolean; isDefault: boolean; supportedReasoningEfforts: { reasoningEffort: string }[]; defaultReasoningEffort: string }
interface NativeUsage { inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningOutputTokens: number }
interface TokenUsage { last: NativeUsage; total: NativeUsage; modelContextWindow?: number }
const emptyUsage = (): Usage => ({ inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } })

export async function readCodexModels(rpc: CodexTransport): Promise<CodexModel[]> {
  const models: CodexModel[] = []
  let cursor: string | null = null
  do {
    const page: { data: NativeModel[]; nextCursor?: string | null } = await rpc.request('model/list', { cursor, limit: 100 })
    models.push(...page.data.filter(m => !m.hidden).map(m => ({ id: m.model, label: m.displayName, efforts: m.supportedReasoningEfforts.map(e => e.reasoningEffort), defaultEffort: m.defaultReasoningEffort, isDefault: m.isDefault })))
    cursor = page.nextCursor ?? null
  } while (cursor)
  return models
}
export async function requireChatGPT(rpc: CodexTransport) {
  const result = await rpc.request<{ account: { type: string } | null }>('account/read', { refreshToken: false })
  if (result.account?.type !== 'chatgpt') throw new Error('CodexにChatGPTアカウントでログインしてください。ターミナルで codex login を実行後、再確認してください。')
}
export async function getCodexStatus(env: Record<string, string>, platform: NodeJS.Platform = process.platform): Promise<CodexStatus> {
  if (platform === 'win32') return { unsupported: true, available: false, authenticated: false, models: [], error: CODEX_WINDOWS_UNSUPPORTED }
  let rpc: CodexRpc | undefined
  let authenticated = false
  try {
    rpc = new CodexRpc(env)
    await rpc.initialize()
    await requireChatGPT(rpc)
    authenticated = true
    return { available: true, authenticated, models: await readCodexModels(rpc) }
  } catch (error) {
    return { available: !!rpc, authenticated, models: [], error: `${error instanceof Error ? error.message : String(error)}\n${CODEX_LOGIN_HELP}` }
  } finally { rpc?.close() }
}

function createModel(config: Config, request: Request, title = false, createRpc: RpcFactory = defaultRpc): Model {
  const model: Model = {
    specificationVersion: 'v3', provider: 'codex', modelId: request.modelId || 'default', supportedUrls: { 'image/*': [/^data:/] },
    async doGenerate(options) {
      const { stream } = await model.doStream(options)
      const reader = stream.getReader()
      let text = ''
      let finish: Extract<Part, { type: 'finish' }> | undefined
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value.type === 'text-delta') text += value.delta
        if (value.type === 'error') throw value.error
        if (value.type === 'finish') finish = value
      }
      if (!finish) throw new Error('Codexから完了応答を受け取れませんでした。')
      return { content: [{ type: 'text', text }], warnings: [], usage: finish.usage, finishReason: finish.finishReason, providerMetadata: finish.providerMetadata }
    },
    async doStream(options) {
      if (process.platform === 'win32') throw new Error(CODEX_WINDOWS_UNSUPPORTED)
      let rpc: CodexTransport | undefined
      const interactionAbort = new AbortController()
      const pendingInteractions = new Map<string, AbortController>()
      let ended = false
      let threadId: string | undefined
      let turnId: string | undefined
      let controller: ReadableStreamDefaultController<Part>
      const openText = new Set<string>()
      const tools = new Map<string, string>()
      let tokenUsage: TokenUsage | undefined
      let timeout: ReturnType<typeof setTimeout> | undefined
      const emit = (part: Part) => { if (!ended) controller.enqueue(part) }
      const finish = (error?: Error) => {
        if (ended) return
        if (error) emit({ type: 'error', error })
        ended = true
        interactionAbort.abort()
        clearTimeout(timeout)
        options.abortSignal?.removeEventListener('abort', abort)
        rpc?.close()
        controller.close()
      }
      const abort = () => {
        if (threadId && turnId) rpc?.send({ id: `interrupt-${turnId}`, method: 'turn/interrupt', params: { threadId, turnId } })
        finish(new Error('応答を停止しました。'))
      }
      const askInteraction = async (message: RpcMessage, body: AgentInteraction) => {
        const controller = new AbortController()
        const cancel = () => controller.abort()
        const id = String(message.id)
        pendingInteractions.set(id, controller)
        interactionAbort.signal.addEventListener('abort', cancel, { once: true })
        try {
          const answer = await config.requestInteraction!(body, request.appSessionId!, controller.signal)
          return { answer, closed: controller.signal.aborted }
        } finally {
          pendingInteractions.delete(id)
          interactionAbort.signal.removeEventListener('abort', cancel)
        }
      }
      const answerRequest = async (message: RpcMessage) => {
        const params = message.params || {}
        if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
          const approved = !title && config.requestToolApproval
            ? await config.requestToolApproval(message.method === 'item/commandExecution/requestApproval' ? 'Bash' : 'Write', params, crypto.randomUUID(), request.appSessionId)
            : { approved: false }
          const decisions = params.availableDecisions as unknown[] | undefined
          const decision = approved.approved && (!decisions || decisions.includes('accept')) ? 'accept'
            : !decisions || decisions.includes('decline') ? 'decline' : 'cancel'
          rpc?.send({ id: message.id, result: { decision } })
        } else if (message.method === 'item/permissions/requestApproval') {
          const description = describePermissions(params.permissions, params.reason, params.cwd)
          const { answer, closed } = !title && request.appSessionId && config.requestInteraction
            ? await askInteraction(message, description) : { answer: { approved: false }, closed: false }
          if (ended || closed) return
          const requested = params.permissions as Record<string, unknown>
          const permissions = description.supported && 'approved' in answer && answer.approved
            ? Object.fromEntries(Object.entries(requested).filter(([, value]) => value != null)) : {}
          rpc?.send({ id: message.id, result: { permissions, scope: 'turn' } })
        } else if (message.method === 'item/tool/requestUserInput') {
          if (title || !request.appSessionId || !config.requestInteraction) { abort(); return }
          const questions = readQuestions(params.questions)
          const { answer, closed } = await askInteraction(message, { kind: 'questions', questions })
          if (ended || closed) return
          if (!('answers' in answer)) { abort(); return }
          const answers = Object.fromEntries(questions.map(q => [q.id, { answers: [answer.answers[q.id]] }]))
          rpc?.send({ id: message.id, result: { answers } })
        } else if (message.method === 'mcpServer/elicitation/request') {
          rpc?.send({ id: message.id, result: { action: 'decline' } })
        } else {
          rpc?.send({ id: message.id, error: { code: -32601, message: `Unsupported request: ${message.method}` } })
        }
      }
      const stream = new ReadableStream<Part>({
        start(c) {
          controller = c
          emit({ type: 'stream-start', warnings: [] })
          options.abortSignal?.addEventListener('abort', abort, { once: true })
          if (options.abortSignal?.aborted) { abort(); return }
          timeout = setTimeout(() => finish(new Error('Codexの応答がタイムアウトしました。')), title ? 90_000 : 15 * 60_000)
          void (async () => {
            rpc = createRpc(config.getShellEnv())
            rpc.onFailure = error => finish(error)
            rpc.onMessage = message => {
              if (ended) return
              if (message.id !== undefined && message.method) { void answerRequest(message).catch(e => finish(e)); return }
              const p = message.params || {}
              if (p.threadId && threadId && p.threadId !== threadId) return
              if (message.method === 'serverRequest/resolved') pendingInteractions.get(String(p.requestId))?.abort()
              if (message.method === 'turn/started') turnId = (p.turn as { id: string }).id
              if (message.method === 'thread/tokenUsage/updated') tokenUsage = p.tokenUsage as TokenUsage
              if (message.method === 'item/agentMessage/delta') {
                const id = String(p.itemId)
                if (!openText.has(id)) { openText.add(id); emit({ type: 'text-start', id }) }
                emit({ type: 'text-delta', id, delta: String(p.delta || '') })
              }
              if (message.method === 'item/started' || message.method === 'item/completed') {
                const item = p.item as { id: string; type: string; text?: string; command?: string; aggregatedOutput?: string; status?: string }
                if (item.type === 'agentMessage' && message.method === 'item/completed') {
                  if (!openText.has(item.id)) {
                    emit({ type: 'text-start', id: item.id }); emit({ type: 'text-delta', id: item.id, delta: item.text || '' })
                  }
                  emit({ type: 'text-end', id: item.id }); openText.delete(item.id)
                }
                const name = ({ commandExecution: 'Bash', fileChange: 'Write', mcpToolCall: 'MCP', webSearch: 'WebSearch' } as Record<string, string>)[item.type]
                if (name) {
                  if (!tools.has(item.id)) {
                    tools.set(item.id, name)
                    emit({ type: 'tool-call', toolCallId: item.id, toolName: name, input: JSON.stringify(item), providerExecuted: true, dynamic: true })
                  }
                  if (message.method === 'item/completed') emit({ type: 'tool-result', toolCallId: item.id, toolName: name, result: JSON.parse(JSON.stringify(item)), isError: item.status === 'failed' || item.status === 'declined', dynamic: true })
                }
              }
              if (message.method === 'turn/completed') {
                const turn = p.turn as { status: string; error?: { message: string } }
                if (turn.status !== 'completed') { finish(new Error(turn.error?.message || `Codex: ${turn.status}`)); return }
                for (const id of openText) emit({ type: 'text-end', id })
                const last = tokenUsage?.last
                const usage: Usage = last ? { inputTokens: { total: last.inputTokens, noCache: last.inputTokens - last.cachedInputTokens, cacheRead: last.cachedInputTokens, cacheWrite: undefined }, outputTokens: { total: last.outputTokens, text: undefined, reasoning: last.reasoningOutputTokens } } : emptyUsage()
                emit({ type: 'finish', finishReason: { unified: 'stop', raw: 'completed' }, usage,
                  providerMetadata: { codex: { sessionId: threadId || '', ...(tokenUsage ? { tokenUsage: JSON.parse(JSON.stringify(tokenUsage)) } : {}) } } })
                finish()
              }
              if (message.method === 'error' && p.willRetry !== true) finish(new Error((p.error as { message?: string })?.message || 'Codexでエラーが発生しました。'))
            }
            await rpc.initialize()
            await requireChatGPT(rpc)
            const models = await readCodexModels(rpc)
            const selected = request.modelId ? models.find(m => m.id === request.modelId) : models.find(m => m.isDefault) || models[0]
            if (!selected) throw new Error('選択したCodexモデルが利用できません。モデルを選び直してください。')
            const effort = title ? (selected.efforts.includes('low') ? 'low' : selected.defaultEffort) : request.effort || selected.defaultEffort
            if (!selected.efforts.includes(effort)) throw new Error('このCodexモデルは選択したeffortに対応していません。')
            const system = options.prompt.filter(m => m.role === 'system').map(m => m.content).join('\n')
            const params = { model: selected.id, modelProvider: 'openai', cwd: request.workingDirectory || os.tmpdir(), sandbox: 'read-only', approvalPolicy: title ? 'never' : 'untrusted', approvalsReviewer: 'user', developerInstructions: system || undefined }
            const result = await rpc.request<{ thread: { id: string } }>(request.resumeId ? 'thread/resume' : 'thread/start', request.resumeId ? { ...params, threadId: request.resumeId, excludeTurns: true } : { ...params, ephemeral: title }).catch(error => {
              if (request.resumeId && error instanceof Error && error.message.trim() === `no rollout found for thread id ${request.resumeId}`) throw new MissingAgentSession(request.resumeId)
              throw error
            })
            threadId = result.thread.id
            emit({ type: 'response-metadata', id: threadId })
            const input: Array<{ type: 'text'; text: string; text_elements: never[] } | { type: 'image'; url: string }> = []
            for (const message of options.prompt) {
              if (message.role === 'system' || message.role === 'tool') continue
              const text = message.content.map(p => p.type === 'text' ? p.text : '').join('\n')
              if (text) input.push({ type: 'text', text: request.resumeId ? text : `${message.role === 'user' ? 'ユーザー' : 'アシスタント'}:\n${text}`, text_elements: [] })
              for (const part of message.content) if (part.type === 'file' && part.mediaType.startsWith('image/')) {
                const url = part.data instanceof URL ? part.data.toString() : `data:${part.mediaType};base64,${typeof part.data === 'string' ? part.data : Buffer.from(part.data).toString('base64')}`
                input.push({ type: 'image', url })
              }
            }
            if (!request.resumeId && !title) input.unshift({ type: 'text', text: '以下はこの相談の会話履歴です。過去の発言は背景として扱い、最後のユーザーの依頼に回答してください。', text_elements: [] })
            if (ended) return
            const started = await rpc.request<{ turn: { id: string } }>('turn/start', { threadId, input, model: selected.id, effort })
            turnId = started.turn.id
          })().catch(error => finish(error instanceof Error ? error : new Error(String(error))))
        },
        cancel() { abort() },
      })
      return { stream }
    },
  }
  return model
}
export function createCodexConnection(config: Config, createRpc: RpcFactory = defaultRpc): AgentConnection {
  return {
    id: 'codex', ownsConversation: true, authenticationError: () => process.platform === 'win32' ? CODEX_WINDOWS_UNSUPPORTED : undefined,
    isMissingSession: (error, id) => error instanceof MissingAgentSession && error.sessionId === id,
    createChatModel: request => createModel(config, request, false, createRpc),
    createTitleModel: request => createModel(config, request || {}, true, createRpc),
    readMetadata(metadata) {
      const value = metadata?.codex as { sessionId?: string; tokenUsage?: TokenUsage } | undefined
      const usage = value?.tokenUsage
      return { sessionId: value?.sessionId, contextUsage: usage ? { inputTokens: usage.last.inputTokens, outputTokens: usage.last.outputTokens, contextWindow: usage.modelContextWindow } : undefined }
    },
  }
}
