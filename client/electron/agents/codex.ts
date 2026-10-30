import { startReferenceMcp } from '../consultations/mcp'
import { COMPANY_FILES_SERVER, startCompanyFilesMcp } from '../company-files/tools'
import { REVIEW_SERVER, startReviewMcp } from '../review/tools'
import { WEB_RESEARCH_SERVER, startWebResearchMcp } from '../web-research/tools'
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
import { startLoopbackMcp } from './loopback-mcp'
import { CODEX_ASK_USER_INSTRUCTIONS, codexAskUserTool } from './choice-tools'
import { CHOICE_TIMEOUT_MS, CODEX_CHOICE_SERVER, CODEX_CHOICE_TOOL } from '../../shared/choice-prompt'
import { fromCodexRateLimits } from '../../shared/rate-limits'
import type { SteerTarget } from './steering'
import { turnToolEvents } from './tool-events'
import { recordCodexApproval, recordCodexItem } from './codex-tool-events'
import { checkInstalledCodex, type CodexVersionCheck } from './codex-version'
import { CODEX_SANDBOX_PROFILE, SANDBOX_MESSAGES, codexSandboxConfig } from '../../shared/agents/sandbox-policy'

type Model = Extract<LanguageModel, { specificationVersion: 'v3' }>
type StreamResult = Awaited<ReturnType<Model['doStream']>>
type Part = StreamResult['stream'] extends ReadableStream<infer T> ? T : never
type Usage = Extract<Part, { type: 'finish' }>['usage']
type Request = Parameters<AgentConnection['createChatModel']>[0]
export type CodexTransport = Pick<CodexRpc, 'initialize' | 'request' | 'send' | 'close' | 'onMessage' | 'onFailure'>
type RpcFactory = (env: Record<string, string>) => CodexTransport
const defaultRpc: RpcFactory = env => new CodexRpc(env)
// The version floor applies to the member's CLI; an injected transport (tests) has none to check.
const noVersionCheck: CodexVersionCheck = async () => ({ ok: true })
const versionCheckFor = (createRpc: RpcFactory) => createRpc === defaultRpc ? checkInstalledCodex : noVersionCheck
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
export async function getCodexStatus(env: Record<string, string>, platform: NodeJS.Platform = process.platform, checkVersion: CodexVersionCheck = checkInstalledCodex): Promise<CodexStatus> {
  if (platform === 'win32') return { unsupported: true, available: false, authenticated: false, models: [], error: CODEX_WINDOWS_UNSUPPORTED }
  let rpc: CodexRpc | undefined
  let authenticated = false
  try {
    const version = await checkVersion(env)
    if (!version.ok) return { available: false, authenticated: false, models: [], error: version.message }
    rpc = new CodexRpc(env)
    await rpc.initialize()
    await requireChatGPT(rpc)
    authenticated = true
    return { available: true, authenticated, models: await readCodexModels(rpc) }
  } catch (error) {
    return { available: !!rpc, authenticated, models: [], error: `${error instanceof Error ? error.message : String(error)}\n${CODEX_LOGIN_HELP}` }
  } finally { rpc?.close() }
}

function createModel(config: Config, request: Request, title = false, createRpc: RpcFactory = defaultRpc, checkVersion: CodexVersionCheck = versionCheckFor(createRpc)): Model {
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
      let referenceMcp: Awaited<ReturnType<typeof startReferenceMcp>> | undefined
      let companyFilesMcp: Awaited<ReturnType<typeof startCompanyFilesMcp>> | undefined
      let reviewMcp: Awaited<ReturnType<typeof startReviewMcp>> | undefined
      let webResearchMcp: Awaited<ReturnType<typeof startWebResearchMcp>> | undefined
      let askMcp: Awaited<ReturnType<typeof startLoopbackMcp>> | undefined
      // ask_user calls Codex has started and not yet asked (oldest first): links the card to its tool row.
      const askItems: string[] = []
      // While the member answers, the turn's own time limit is paused.
      let waitingForMember = 0
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
      // The AI action log for this turn (shared/agent-events.ts); titles run no tools.
      const toolEvents = title ? undefined : turnToolEvents(config, 'codex', request)
      const emit = (part: Part) => { if (!ended) controller.enqueue(part) }
      // Plan usage for the header meter (shared/rate-limits.ts). Updates are sparse.
      const reportRateLimits = (snapshot: unknown) => {
        if (!title && request.onEvent) request.onEvent({ type: 'rate-limits', update: previous => fromCodexRateLimits(snapshot, previous) })
      }
      // Extra instructions while the turn runs: `turn/steer` adds input to the
      // active turn (it fails once that turn is over → sent as a new message).
      const steerTarget: SteerTarget | undefined = !title && request.steering ? {
        async send(text, accepted) {
          if (ended || !rpc || !threadId || !turnId) return 'not-delivered'
          try {
            await rpc.request('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text, text_elements: [] }] })
          } catch (error) {
            console.warn('[codex] turn/steer failed:', error instanceof Error ? error.message : 'unknown')
            return 'not-delivered'
          }
          accepted()
          return 'delivered'
        },
      } : undefined
      const steerable = () => { if (steerTarget && turnId && !ended) request.steering!.attach(steerTarget) }
      const finish = (error?: Error) => {
        if (ended) return
        if (steerTarget) request.steering!.detach(steerTarget)
        if (error) emit({ type: 'error', error })
        ended = true
        toolEvents?.close()
        interactionAbort.abort()
        clearTimeout(timeout)
        options.abortSignal?.removeEventListener('abort', abort)
        referenceMcp?.close()
        companyFilesMcp?.close()
        reviewMcp?.close()
        webResearchMcp?.close()
        askMcp?.close()
        rpc?.close()
        controller.close()
      }
      const armTimeout = () => {
        clearTimeout(timeout)
        if (!ended && waitingForMember === 0) timeout = setTimeout(() => finish(new Error('Codexの応答がタイムアウトしました。')), title ? 90_000 : 15 * 60_000)
      }
      const whileMemberAnswers = async <T>(wait: () => Promise<T>): Promise<T> => {
        waitingForMember++; clearTimeout(timeout)
        try { return await wait() } finally { waitingForMember--; armTimeout() }
      }
      function abort() {
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
          const answer = await whileMemberAnswers(() => config.requestInteraction!(body, request.appSessionId!, controller.signal))
          return { answer, closed: controller.signal.aborted }
        } finally {
          pendingInteractions.delete(id)
          interactionAbort.signal.removeEventListener('abort', cancel)
        }
      }
      const answerRequest = async (message: RpcMessage) => {
        const params = message.params || {}
        if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
          const asked = !title && !!config.requestToolApproval
          const approved = !title && config.requestToolApproval
            ? await config.requestToolApproval(message.method === 'item/commandExecution/requestApproval' ? 'Bash' : 'Write', params, crypto.randomUUID(), request.appSessionId)
            : { approved: false }
          recordCodexApproval(toolEvents, message.method, params, { asked, approved: approved.approved })
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
          armTimeout()
          void (async () => {
            // Too old a CLI: a plain notice instead of a protocol error later.
            const version = await checkVersion(config.getShellEnv())
            if (!version.ok) throw new Error(version.message)
            if (ended) return
            rpc = createRpc(config.getShellEnv())
            rpc.onFailure = error => finish(error)
            rpc.onMessage = message => {
              if (ended) return
              if (message.id !== undefined && message.method) { void answerRequest(message).catch(e => finish(e)); return }
              const p = message.params || {}
              if (p.threadId && threadId && p.threadId !== threadId) return
              if (message.method === 'serverRequest/resolved') pendingInteractions.get(String(p.requestId))?.abort()
              if (message.method === 'turn/started') { turnId = (p.turn as { id: string }).id; steerable() }
              if (message.method === 'thread/tokenUsage/updated') tokenUsage = p.tokenUsage as TokenUsage
              if (message.method === 'account/rateLimits/updated') reportRateLimits(p.rateLimits)
              if (message.method === 'item/agentMessage/delta') {
                const id = String(p.itemId)
                if (!openText.has(id)) { openText.add(id); emit({ type: 'text-start', id }) }
                emit({ type: 'text-delta', id, delta: String(p.delta || '') })
              }
              if (message.method === 'item/started' || message.method === 'item/completed') {
                const item = p.item as { id: string; type: string; text?: string; command?: string; aggregatedOutput?: string; status?: string; server?: string; tool?: string; result?: unknown; arguments?: unknown }
                recordCodexItem(toolEvents, message.method, item)
                if (item.type === 'agentMessage' && message.method === 'item/completed') {
                  if (!openText.has(item.id)) {
                    emit({ type: 'text-start', id: item.id }); emit({ type: 'text-delta', id: item.id, delta: item.text || '' })
                  }
                  emit({ type: 'text-end', id: item.id }); openText.delete(item.id)
                }
                const appTool = item.type === 'mcpToolCall' && (item.server === 'acb_consultations' || item.server === COMPANY_FILES_SERVER || item.server === REVIEW_SERVER || item.server === WEB_RESEARCH_SERVER || item.server === CODEX_CHOICE_SERVER)
                if (appTool && item.server === CODEX_CHOICE_SERVER && item.tool === CODEX_CHOICE_TOOL) {
                  if (message.method === 'item/started' && !tools.has(item.id)) askItems.push(item.id)
                  else if (message.method === 'item/completed') { const at = askItems.indexOf(item.id); if (at >= 0) askItems.splice(at, 1) }
                }
                const name = appTool ? `mcp__${item.server}__${item.tool}` : ({ commandExecution: 'Bash', fileChange: 'Write', mcpToolCall: 'MCP', webSearch: 'WebSearch' } as Record<string, string>)[item.type]
                if (name) {
                  if (!tools.has(item.id)) {
                    tools.set(item.id, name)
                    emit({ type: 'tool-call', toolCallId: item.id, toolName: name, input: JSON.stringify(appTool ? item.arguments : item), providerExecuted: true, dynamic: true })
                  }
                  if (message.method === 'item/completed') emit({ type: 'tool-result', toolCallId: item.id, toolName: name, result: JSON.parse(JSON.stringify(appTool ? item.result : item)), isError: item.status === 'failed' || item.status === 'declined', dynamic: true })
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
            if (!title && request.references) referenceMcp = await startReferenceMcp(request.references)
            if (!title && request.companyFiles && !ended) companyFilesMcp = await startCompanyFilesMcp(request.companyFiles)
            if (!title && request.review && !ended) reviewMcp = await startReviewMcp(request.review)
            if (!title && request.webResearch && !ended) webResearchMcp = await startWebResearchMcp(request.webResearch)
            const askUser = request.askUser
            if (!title && askUser && !ended) {
              askMcp = await startLoopbackMcp(CODEX_CHOICE_SERVER, [codexAskUserTool(
                (questions, toolCallId, signal) => whileMemberAnswers(() => askUser(questions, toolCallId, signal)),
                () => askItems.shift(),
                interactionAbort.signal,
              )], { toolTimeoutSec: Math.ceil(CHOICE_TIMEOUT_MS / 1000) + 60 })
            }
            if (ended) { referenceMcp?.close(); companyFilesMcp?.close(); reviewMcp?.close(); webResearchMcp?.close(); askMcp?.close(); return }
            await rpc.initialize()
            await requireChatGPT(rpc)
            // The full snapshot once per turn; `account/rateLimits/updated` follows as usage changes.
            if (!title && request.onEvent) void rpc.request<{ rateLimits?: unknown }>('account/rateLimits/read').then(r => reportRateLimits(r?.rateLimits), () => {})
            const models = await readCodexModels(rpc)
            const selected = request.modelId ? models.find(m => m.id === request.modelId) : models.find(m => m.isDefault) || models[0]
            if (!selected) throw new Error('選択したCodexモデルが利用できません。モデルを選び直してください。')
            const effort = title ? (selected.efforts.includes('low') ? 'low' : selected.defaultEffort) : request.effort || selected.defaultEffort
            if (!selected.efforts.includes(effort)) throw new Error('このCodexモデルは選択したeffortに対応していません。')
            const system = options.prompt.filter(m => m.role === 'system').map(m => m.content).join('\n') + (askMcp ? CODEX_ASK_USER_INSTRUCTIONS : '')
            // Normal chats work within their company workspace; no directory means no write grant.
            const mcpServers = {
              ...(referenceMcp ? { acb_consultations: referenceMcp.config } : {}),
              ...(companyFilesMcp ? { [COMPANY_FILES_SERVER]: companyFilesMcp.config } : {}),
              ...(reviewMcp ? { [REVIEW_SERVER]: reviewMcp.config } : {}),
              ...(webResearchMcp ? { [WEB_RESEARCH_SERVER]: webResearchMcp.config } : {}),
              ...(askMcp ? { [CODEX_CHOICE_SERVER]: askMcp.config } : {}),
            }
            // 「AI の囲い」 enforce (agent-sandbox.md): the app's permission profile
            // instead of the legacy `sandbox` mode (any legacy mode switches profiles off).
            const sandboxed = !title && !!request.workingDirectory && request.sandbox?.mode === 'enforce'
            // With the app's web research, Codex's own web search is off for this thread.
            const threadConfig = {
              ...(Object.keys(mcpServers).length > 0 ? { mcp_servers: mcpServers } : {}),
              ...(webResearchMcp ? { web_search: 'disabled' } : {}),
              ...(sandboxed ? codexSandboxConfig(request.sandbox!.resolved) : {}),
            }
            const legacySandbox = sandboxed ? {} : { sandbox: !title && request.workingDirectory ? 'workspace-write' : 'read-only' }
            const params = { ...(Object.keys(threadConfig).length > 0 ? { config: threadConfig } : {}), model: selected.id, modelProvider: 'openai', cwd: request.workingDirectory || os.tmpdir(), ...legacySandbox, approvalPolicy: title ? 'never' : 'on-request', approvalsReviewer: 'user', developerInstructions: system || undefined }
            const result = await rpc.request<{ thread: { id: string }; activePermissionProfile?: { id?: unknown } | null }>(request.resumeId ? 'thread/resume' : 'thread/start', request.resumeId ? { ...params, threadId: request.resumeId, excludeTurns: true } : { ...params, ephemeral: title }).catch(error => {
              if (request.resumeId && error instanceof Error && error.message.trim() === `no rollout found for thread id ${request.resumeId}`) throw new MissingAgentSession(request.resumeId)
              throw error
            })
            threadId = result.thread.id
            emit({ type: 'response-metadata', id: threadId })
            // Self-check: Codex says which profile is in force. Anything else (an older
            // Codex, a config that overrides it) means the sandbox is not running.
            if (sandboxed && (result.activePermissionProfile?.id ?? null) !== CODEX_SANDBOX_PROFILE) {
              console.warn('[agent-sandbox] Codex did not apply the permission profile; following the company setting:', request.sandbox!.onUnavailable)
              if (request.sandbox!.onUnavailable !== 'record-only') throw new Error(SANDBOX_MESSAGES.startFailedStop)
              const id = `sandbox-notice-${crypto.randomUUID()}`
              emit({ type: 'text-start', id }); emit({ type: 'text-delta', id, delta: `※ ${SANDBOX_MESSAGES.startFailedRecordOnly}\n\n` }); emit({ type: 'text-end', id })
            }
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
            steerable()
          })().catch(error => finish(error instanceof Error ? error : new Error(String(error))))
        },
        cancel() { abort() },
      })
      return { stream }
    },
  }
  return model
}
export function createCodexConnection(config: Config, createRpc: RpcFactory = defaultRpc, checkVersion: CodexVersionCheck = versionCheckFor(createRpc)): AgentConnection {
  return {
    id: 'codex', ownsConversation: true, authenticationError: () => process.platform === 'win32' ? CODEX_WINDOWS_UNSUPPORTED : undefined,
    isMissingSession: (error, id) => error instanceof MissingAgentSession && error.sessionId === id,
    createChatModel: request => createModel(config, request, false, createRpc, checkVersion),
    createTitleModel: request => createModel(config, request || {}, true, createRpc, checkVersion),
    readMetadata(metadata) {
      const value = metadata?.codex as { sessionId?: string } | undefined
      return { sessionId: value?.sessionId }
    },
  }
}
