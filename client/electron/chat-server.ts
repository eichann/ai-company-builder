import { REFERENCE_INSTRUCTIONS, type ReferenceTools } from './consultations/tools'
import type { CompanyFileTools } from './company-files/tools'
import { recoverSessionModel } from './agents/recovery'
import type { HandoffRecovery } from '../shared/handoff'
import { resumeSession, agentInputMessages } from './agents/session'
import { createCodexConnection } from './agents/codex'
import type { AgentSession, AuthMode } from '../shared/agent'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { cors } from 'hono/cors'
import {
  streamText,
  generateText,
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  type UIMessage,
} from 'ai'
import { createChunkInjector, limitedUIMessageStreamResponse, type ChunkInjector } from './ui-stream-limits'
import type { AgentEvent, AgentHostConfig, AskUser } from './agents/connection'
import { CHOICE_PART_TYPE, type ChoicePromptRecord, type ChoiceResult } from '../shared/choice-prompt'
import { createClaudeConnection } from './agents/claude'
import { createApiConnection } from './agents/anthropic-api'
import type { ClaudeConnectionConfig } from './agents/claude'
import { createFileSystemTools, createSkillTools } from './chat-tools'
import type { WriteGuard } from './write-guard'
import { forgetPrivateReads, noteCompanyFileResult, privateReadStateFor, createPrivateReadState, seedFromMessages, type PrivateReadContext } from './private-read-guard'
import { RATE_LIMITS_PART_TYPE, type RateLimitProvider, type RateLimitSnapshot } from '../shared/rate-limits'
import { AGENT_PROGRESS_PART_TYPE } from '../shared/agent-progress'
import { createChatTurns } from './chat-turns'
import crypto from 'crypto'
import net from 'net'

export interface ChatServerConfig extends ClaudeConnectionConfig {
  createReferences?: (company: string, id: string, signal: AbortSignal) => ReferenceTools
  /**
   * Read-only company files for this turn (company-files/tools.ts): the tools
   * and the system-prompt paragraph that tells the AI when to use them.
   */
  createCompanyFiles?: (companyId: string, companyRoot: string | undefined, signal: AbortSignal) => { tools: CompanyFileTools; instructions: string } | undefined
  prepareRecovery?: (company: string, id: string, messages: UIMessage[]) => { context: string; usedMemo: boolean }
  onRecovery?: (company: string, id: string, recovery: HandoffRecovery) => void
  persistAgentSession?: (company: string, id: string, session: AgentSession) => void
  onChatActivity?: (token: string, active: boolean) => void
  getApiKey: () => string | undefined
  getAuthMode: () => 'claude-code' | 'codex' | 'api-key'
  buildSystemPrompt: (workingDirectory?: string) => string
  /**
   * The write guard for a chat in this company (write-guard.ts): refreshes the
   * member's write access (short timeout, cached answer on failure) and
   * returns undefined when nothing is known — then nothing is blocked.
   */
  getWriteGuard?: (companyId: string, companyRoot: string) => Promise<WriteGuard | undefined>
}

// ============================================================================
// Security policy appended to all system prompts
// ============================================================================

const SECURITY_POLICY = `

## セキュリティポリシー（必ず遵守）

あなたはセキュリティフックにより、危険な操作（ファイル削除、git force push等）が監視されています。

**重要なルール：**
- ツールの実行がセキュリティシステムによって拒否された場合、**別の手段で同じ操作を試みてはいけません**。
- 例: \`rm\` コマンドが拒否された場合、Python（os.remove, shutil.rmtree）、Node.js（fs.unlink）、find -delete、その他いかなる方法でもファイル削除を試みないでください。
- 拒否された操作については、ユーザーに「この操作はセキュリティ設定によりブロックされました。必要であれば手動で行ってください。」と伝えてください。
- このルールはファイル削除に限らず、セキュリティシステムによって拒否されたすべての操作に適用されます。
`

/**
 * External git repositories belong in the company folder's `.workspace/`
 * (never shared). The write guard refuses a clone anywhere else in the
 * company folder (write-guard.ts checkGitClone); this tells the AI first.
 */
export function externalRepositoryInstruction(companyRootPath?: string): string {
  const where = companyRootPath ? `「${companyRootPath.replace(/[\\/]+$/, '')}/.workspace/」` : '会社フォルダ直下の「.workspace/」'
  return `【外部のGitリポジトリ】GitHub などの外部のリポジトリを clone するときは、必ず${where}の中に置いてください（例: git clone <URL> .workspace/<名前>）。.workspace/ は会社の全員には共有されません。会社フォルダの他の場所（部署のフォルダなど）に clone すると全員に共有されたり同期が止まったりするため、アプリが止めます。`
}

/**
 * Choice prompts for one turn (choice-prompt.ts): shows the card in this
 * conversation through `requestInteraction`, waits for the member, and adds
 * the outcome to the response as a `data-choice-prompt` part — the transcript
 * shows it, and chat history keeps it (`choicePrompts`).
 */
export function createAskUser(
  requestInteraction: AgentHostConfig['requestInteraction'],
  appSessionId: string | undefined,
  agent: 'claude-code' | 'codex',
  inject: Pick<ChunkInjector, 'push'>,
): AskUser | undefined {
  if (!requestInteraction || !appSessionId) return undefined
  return async (questions, toolCallId, signal) => {
    const id = toolCallId || crypto.randomUUID()
    let result: ChoiceResult
    try {
      const response = await requestInteraction({ kind: 'choices', agent, ...(toolCallId ? { toolCallId } : {}), questions }, appSessionId, signal)
      result = 'choices' in response ? { answers: response.choices }
        : { cancelled: 'cancelled' in response && response.reason ? response.reason : signal.aborted ? 'aborted' : 'cancelled' }
    } catch (error) {
      console.warn('[chat-server] choice prompt failed:', error instanceof Error ? error.message : 'unknown')
      result = { cancelled: 'unavailable' }
    }
    const record: ChoicePromptRecord = { id, questions, ...('answers' in result ? { answers: result.answers } : { cancelled: result.cancelled }) }
    inject.push({ type: CHOICE_PART_TYPE, id: `choice-${id}`, data: record })
    return result
  }
}

async function findAvailablePort(start: number, end: number): Promise<number> {
  for (let port = start; port < end; port++) {
    const available = await new Promise<boolean>((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => {
        server.close()
        resolve(true)
      })
      server.listen(port, '127.0.0.1')
    })
    if (available) return port
  }
  throw new Error('No available port found in range ' + start + '-' + end)
}

export async function startChatServer(config: ChatServerConfig) {
  const authToken = crypto.randomUUID()
  const app = new Hono()

  // Plan usage limits per agent (shared/rate-limits.ts): the account's, not a
  // conversation's, so every tab's header meter shows the latest one.
  const rateLimitSnapshots = new Map<RateLimitProvider, RateLimitSnapshot>()

  // Current native session for each ACB conversation (provider-tagged).
  const agentSessionMap = new Map<string, AgentSession>()
  // Running turns: steering (extra instructions) and next-prompt suggestions.
  const chatTurns = createChatTurns()


  // CORS for Electron renderer (Vite dev server or file:// protocol)
  app.use('/*', cors({
    origin: (origin) => origin || '*',
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['POST', 'GET', 'DELETE', 'OPTIONS'],
  }))

  // Auth middleware
  app.use('/api/*', async (c, next) => {
    const header = c.req.header('Authorization')
    if (header !== `Bearer ${authToken}`) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    await next()
  })

  // POST /api/chat
  app.post('/api/chat', async (c) => {
    const body = await c.req.json()
    const {
      messages,
      systemPrompt,
      workingDirectory,
      activeDepartment,
      skillInfo,
      images,
      modelId,
      effort,
      referenceFiles,
      appSessionId,
      companyId,
      companyRootPath,
      claudeSessionId: bodyClaudeSessionId,
      agentSession: bodyAgentSession,
      authMode: requestedAuthMode,
      promptSuggestions,
    }: {
      messages: UIMessage[]
      systemPrompt?: string
      workingDirectory?: string
      activeDepartment?: { name: string; folder: string }
      skillInfo?: { skillFolderPath: string }
      images?: Array<{ mediaType: string; data: string }>
      modelId?: string
      effort?: string
      referenceFiles?: string[]
      appSessionId?: string
      companyId?: string
      companyRootPath?: string
      claudeSessionId?: string
      agentSession?: AgentSession | null
      authMode?: AuthMode
      /** The member's setting (Settings → 入力候補); absent = on. */
      promptSuggestions?: boolean
    } = body

    const authMode = requestedAuthMode || config.getAuthMode()
    if (!['claude-code', 'codex', 'api-key'].includes(authMode)) return c.json({ error: '不明なAI接続方式です。' }, 400)
    const connection = authMode === 'codex' ? createCodexConnection(config) : authMode === 'claude-code' ? createClaudeConnection(config) : createApiConnection(config)

    // Native agents own their system prompts; ACB supplies only workspace context.
    // API key mode: build full system prompt as before.
    let finalSystemPrompt: string | undefined
    if (connection.ownsConversation) {
      if (workingDirectory) {
        finalSystemPrompt = `あなたの作業ディレクトリは「${workingDirectory}」です。\nファイル操作はこのディレクトリ内で行ってください。\n日本語で回答してください。`
        finalSystemPrompt += `\n\n【重要】スクリーンショット、テスト結果、一時ファイル、設定ファイル（.playwright/, test-results/ 等）など、ユーザーのコンテンツではない生成物は必ず「.workspace/」ディレクトリ内に出力してください。.workspace/ が存在しない場合は作成してください。作業ディレクトリのルートを汚さないでください。`
        finalSystemPrompt += `\n\n${externalRepositoryInstruction(companyRootPath)}`
        if (activeDepartment) {
          finalSystemPrompt += `\n\n現在ユーザーが閲覧中の部署: 「${activeDepartment.name}」（フォルダ: ${activeDepartment.folder}/）\nユーザーの質問やファイル操作は、特に指定がなければこの部署のフォルダ内が対象です。`
        } else {
          finalSystemPrompt += `\n\n現在ユーザーは全社共通の画面を閲覧しています。`
        }
      }
      if (referenceFiles && referenceFiles.length > 0) {
        const fileList = referenceFiles.map(p => `- ${p}`).join('\n')
        const refInstruction = `\n\n重要: ユーザーが以下のファイルを参照として添付しました。回答する前に、必ずこれらのファイルを読み込み、内容を踏まえて回答してください:\n${fileList}`
        finalSystemPrompt = (finalSystemPrompt || '') + refInstruction
      }
    } else {
      finalSystemPrompt = (systemPrompt || config.buildSystemPrompt(workingDirectory)) + SECURITY_POLICY
    }

    // A different provider/model starts from visible history, never an older native session.
    const storedSession = appSessionId ? agentSessionMap.get(appSessionId) : undefined
    const candidate: AgentSession | null | undefined = storedSession || bodyAgentSession || (bodyAgentSession === undefined && bodyClaudeSessionId ? { providerId: 'claude-code', id: bodyClaudeSessionId } : undefined)
    const existingCliSessionId = connection.ownsConversation ? resumeSession(candidate, authMode, modelId) : undefined

    const authenticationError = connection.authenticationError()
    if (authenticationError) return c.json({ error: authenticationError }, 401)
    const references = connection.ownsConversation && companyId && appSessionId ? config.createReferences?.(companyId, appSessionId, c.req.raw.signal) : undefined
    if (references) finalSystemPrompt = (finalSystemPrompt || "") + REFERENCE_INSTRUCTIONS
    const writeGuard = companyId && companyRootPath ? await Promise.resolve(config.getWriteGuard?.(companyId, companyRootPath)).catch(() => undefined) : undefined
    // What this conversation has read from private folders (private-read-guard.ts).
    // Kept per conversation across turns; a conversation the app no longer
    // remembers (restart, reopened from history) is re-marked from its visible tool calls.
    const privateContext: PrivateReadContext | undefined = writeGuard ? { root: writeGuard.root, getPrivateFolders: () => writeGuard.getPrivateFolders?.() } : undefined
    const privateState = appSessionId ? privateReadStateFor(appSessionId) : createPrivateReadState()
    if (!privateState.seeded) {
      privateState.seeded = true
      try { seedFromMessages(privateContext, privateState, messages, workingDirectory) } catch { /* best effort */ }
    }
    const createdCompanyFiles = connection.ownsConversation && companyId ? config.createCompanyFiles?.(companyId, companyRootPath, c.req.raw.signal) : undefined
    const companyFiles = createdCompanyFiles && {
      ...createdCompanyFiles,
      tools: {
        async execute(name: string, input: unknown) {
          const output = await createdCompanyFiles.tools.execute(name, input)
          noteCompanyFileResult(privateState, name, output)
          return output
        },
      },
    }
    if (companyFiles) finalSystemPrompt = (finalSystemPrompt || '') + companyFiles.instructions
    const privateReads = privateContext ? { context: privateContext, state: privateState } : undefined
    // Choice prompts (Claude Code's AskUserQuestion, Codex's ask_user): CLI agents only.
    const injector = createChunkInjector()
    const askUser = connection.ownsConversation && (authMode === 'claude-code' || authMode === 'codex')
      ? createAskUser(config.requestInteraction, appSessionId, authMode, injector) : undefined
    // Steering for the CLI agents; next-prompt suggestions for Claude Code.
    const turn = appSessionId && connection.ownsConversation && (authMode === 'claude-code' || authMode === 'codex')
      ? chatTurns.open(appSessionId, injector, { suggestions: authMode === 'claude-code' && promptSuggestions !== false }) : undefined
    // Usage limits and subagent progress reach the renderer as transient data
    // parts (useChat onData), never stored in the transcript.
    const onEvent = connection.ownsConversation && (authMode === 'claude-code' || authMode === 'codex')
      ? (event: AgentEvent) => {
        if (event.type === 'rate-limits') {
          const snapshot = event.update(rateLimitSnapshots.get(authMode))
          if (!snapshot) return
          rateLimitSnapshots.set(authMode, snapshot)
          injector.push({ type: RATE_LIMITS_PART_TYPE, data: snapshot, transient: true })
        } else {
          injector.push({ type: AGENT_PROGRESS_PART_TYPE, data: event.progress, transient: true })
        }
      } : undefined
    const modelRequest = { workingDirectory, appSessionId, modelId, effort, resumeId: existingCliSessionId, references, companyFiles: companyFiles?.tools, writeGuard, privateReads, askUser, onEvent, steering: turn?.steering, onPromptSuggestion: turn?.onPromptSuggestion }
    let usedMemo = false
    const recoveryEvent = (status: HandoffRecovery['status']) => {
      if (companyId && appSessionId) config.onRecovery?.(companyId, appSessionId, { status, usedMemo, at: new Date().toISOString() })
    }
    const model = companyId && appSessionId && config.prepareRecovery && existingCliSessionId
      ? recoverSessionModel(connection, modelRequest, {
        prepare: () => config.prepareRecovery!(companyId, appSessionId, messages),
        started: value => { usedMemo = value; recoveryEvent('recovering') },
        session: id => {
          const session = { providerId: authMode, id, modelId }
          config.persistAgentSession?.(companyId, appSessionId, session)
          agentSessionMap.set(appSessionId, session)
        },
        finished: () => recoveryEvent('recovered'),
        failed: () => recoveryEvent('error'),
      }) : connection.createChatModel(modelRequest)

    // API key mode: add filesystem tools + optional skill tools
    const tools = (() => {
      if (connection.ownsConversation) return undefined
      const fsTools = workingDirectory ? createFileSystemTools(workingDirectory, config.requestToolApproval, writeGuard) : undefined
      const skillTools = skillInfo?.skillFolderPath ? createSkillTools(skillInfo.skillFolderPath) : undefined
      if (!fsTools && !skillTools) return undefined
      return { ...fsTools, ...skillTools }
    })()

    let inputMessages = messages
    try {
      if (connection.ownsConversation) inputMessages = agentInputMessages(messages, existingCliSessionId)
      else if (candidate && candidate.providerId !== authMode) inputMessages = agentInputMessages(messages)
    } catch (error) { turn?.end('failed'); return c.json({ error: error instanceof Error ? error.message : String(error) }, 400) }
    const modelMessages = await convertToModelMessages(inputMessages)

    // Claude Code CLI mode with resume: send only the latest user message
    // (CLI already has the full conversation context from its session)
    // Without resume: send all messages (first request in session)
    // API key mode: prune old messages to manage context window
    let finalMessages = modelMessages
    if (connection.ownsConversation && existingCliSessionId) {
      // Resume mode: only send the latest user message
      let lastUserIdx = -1
      for (let i = finalMessages.length - 1; i >= 0; i--) {
        if (finalMessages[i].role === 'user') { lastUserIdx = i; break }
      }
      if (lastUserIdx >= 0) {
        finalMessages = [finalMessages[lastUserIdx]]
        console.log(`[chat-server] Resume mode: sending only latest user message (trimmed ${modelMessages.length} → 1)`)
      }
    } else if (!connection.ownsConversation) {
      const prunedMessages = pruneMessages({
        messages: modelMessages,
        reasoning: 'none',
        toolCalls: 'before-last-5-messages',
        emptyMessages: 'remove',
      })

      const MAX_CONTEXT_MESSAGES = 80
      finalMessages = prunedMessages.length > MAX_CONTEXT_MESSAGES
        ? prunedMessages.slice(-MAX_CONTEXT_MESSAGES)
        : prunedMessages

      console.log(`[chat-server] Messages: ${modelMessages.length} → ${prunedMessages.length} (pruned) → ${finalMessages.length} (windowed)`)
    } else {
      console.log(`[chat-server] Messages: ${modelMessages.length} (no pruning in CLI mode)`)
    }

    // Inject images into the last user message (sent via transport body)
    if (images && images.length > 0) {
      console.log(`[chat-server] Injecting ${images.length} image(s) into model messages`)
      for (let i = finalMessages.length - 1; i >= 0; i--) {
        if (finalMessages[i].role === 'user') {
          const userContent = finalMessages[i].content
          // Convert string content to multipart array format
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const parts: any[] = Array.isArray(userContent)
            ? [...userContent]
            : [{ type: 'text', text: userContent }]
          for (const img of images) {
            parts.push({
              type: 'image',
              image: img.data,
              mimeType: img.mediaType,
            })
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          finalMessages[i] = { ...finalMessages[i], content: parts as any }
          break
        }
      }
    }

    const activityToken = crypto.randomUUID()
    let released = false
    const release = (outcome: 'finished' | 'failed' = 'failed') => {
      if (released) return
      released = true
      c.req.raw.signal.removeEventListener('abort', abortRelease)
      turn?.end(outcome)
      config.onChatActivity?.(activityToken, false)
    }
    function abortRelease() { release('failed') }
    config.onChatActivity?.(activityToken, true)
    c.req.raw.signal.addEventListener('abort', abortRelease, { once: true })
    let result
    try { result = streamText({
      abortSignal: c.req.raw.signal,
      maxRetries: 0,
      model,
      ...(finalSystemPrompt ? { system: finalSystemPrompt } : {}),
      messages: finalMessages,
      ...(tools ? { tools, stopWhen: stepCountIs(10) } : {}),
      onStepFinish: ({ finishReason, usage, toolCalls, providerMetadata }) => {
        console.log(`[chat-server] Step finished: reason=${finishReason}, tokens=${usage.totalTokens}, tools=${toolCalls.length}`)
        if (!connection.ownsConversation && appSessionId) agentSessionMap.set(appSessionId, { providerId: authMode, id: appSessionId, modelId })
        const metadata = connection.readMetadata(providerMetadata)
        if (metadata.sessionId && appSessionId) {
          agentSessionMap.set(appSessionId, { providerId: authMode, id: metadata.sessionId, modelId })
        }
      },
      onFinish: () => release('finished'),
      onAbort: () => release('failed'),
      onError: ({ error }) => {
        release()
        console.error('[chat-server] Stream error:', error instanceof Error ? error.message : 'unknown')
      },
    }) } catch (error) { release(); throw error }

    // Every tool payload is bounded before it reaches the renderer (see
    // ui-stream-limits.ts): @ai-sdk/react structuredClones the whole message
    // per chunk, so unbounded image results froze the UI. CLI agents never get
    // tool parts replayed (agentInputMessages keeps only text/file), so they
    // use tight limits; api-key mode replays recent tool parts to the model and
    // keeps its already-bounded outputs verbatim.
    return limitedUIMessageStreamResponse(result, {
      ownsConversation: connection.ownsConversation,
      inject: injector,
      onError: error => error instanceof Error ? error.message : 'AIとの接続でエラーが発生しました。',
    })
  })

  // GET /api/session/:appSessionId — return CLI session ID for persistence
  // POST /api/generate-title — generate a concise title for a chat session using Haiku
  app.post('/api/generate-title', async (c) => {
    const body = await c.req.json() as { messages: Array<{ role: 'user' | 'assistant'; content: string }>; authMode?: AuthMode; modelId?: string }
    const inputMessages = Array.isArray(body?.messages) ? body.messages : []
    if (inputMessages.length === 0) {
      return c.json({ error: 'No messages provided' }, 400)
    }

    const authMode = body.authMode || config.getAuthMode()
    const connection = authMode === 'codex' ? createCodexConnection(config) : authMode === 'claude-code' ? createClaudeConnection(config) : createApiConnection(config)
    const authenticationError = connection.authenticationError()
    if (authenticationError) return c.json({ error: authenticationError }, 401)
    const model = connection.createTitleModel({ modelId: body.modelId })

    // Build a compact transcript (cap input to keep cost minimal)
    const MAX_TRANSCRIPT_CHARS = 1500
    let transcript = ''
    for (const msg of inputMessages.slice(0, 6)) {
      const label = msg.role === 'user' ? 'ユーザー' : 'アシスタント'
      const text = (msg.content ?? '').slice(0, 600)
      const line = `${label}: ${text}\n`
      if (transcript.length + line.length > MAX_TRANSCRIPT_CHARS) break
      transcript += line
    }

    const prompt = `以下はユーザーとAIアシスタントのチャット冒頭です。この会話の話題を端的に表す日本語のタイトルを1つだけ生成してください。

要件:
- 15文字以内
- 話題の核心を捉える
- 「〜について」のような曖昧な末尾は避ける
- 引用符・前置き・説明は不要、タイトル本文のみを出力

会話:
${transcript}
タイトル:`

    try {
      const result = await generateText({ model, prompt, maxRetries: 0 })
      let title = (result.text || '').trim()
      // Strip surrounding quotes if any
      title = title.replace(/^["「『'`]+/, '').replace(/["」』'`]+$/, '').trim()
      // Take only the first line, in case the model added explanation
      title = title.split('\n')[0].trim()
      // Hard cap (allow some slack over 15 chars in case model overshoots slightly)
      if (title.length > 30) title = title.slice(0, 30)
      if (!title) {
        return c.json({ error: 'Empty title' }, 500)
      }
      return c.json({ title })
    } catch (e) {
      console.error('[chat-server] generate-title failed:', e)
      return c.json({ error: 'Generation failed' }, 500)
    }
  })

  // POST /api/steer — an extra instruction for the conversation's running turn.
  // Answers once it is known whether the agent read it (shared/steer.ts).
  app.post('/api/steer', async (c) => {
    const body = await c.req.json().catch(() => null) as { appSessionId?: unknown; text?: unknown } | null
    if (typeof body?.appSessionId !== 'string' || typeof body.text !== 'string') return c.json({ error: 'invalid request' }, 400)
    return c.json(await chatTurns.steer(body.appSessionId, body.text))
  })

  // GET /api/prompt-suggestion/:appSessionId — the next-prompt suggestion of
  // the latest turn; waits for it (bounded), since it follows the response.
  app.get('/api/prompt-suggestion/:appSessionId', async (c) => {
    return c.json({ suggestion: await chatTurns.suggestion(c.req.param('appSessionId')) })
  })

  app.get('/api/session/:appSessionId', (c) => {
    const id = c.req.param('appSessionId')
    const session = agentSessionMap.get(id)
    const claudeSessionId = session?.providerId === 'claude-code' ? session.id : null
    return c.json({ claudeSessionId, agentSession: session || null })
  })

  // DELETE /api/session/:appSessionId — clear Claude CLI session mapping (on new chat / tab close)
  app.delete('/api/session/:appSessionId', (c) => {
    const id = c.req.param('appSessionId')
    const deleted = agentSessionMap.delete(id)
    forgetPrivateReads(id)
    chatTurns.forget(id)
    console.log(`[chat-server] Session cleared: ${id} (found: ${deleted})`)
    return c.json({ success: true })
  })

  // GET /api/rate-limits?provider=claude-code|codex — the last known plan usage
  // (null until an agent reported one since the app started).
  app.get('/api/rate-limits', (c) => {
    const provider = c.req.query('provider')
    const snapshot = provider === 'claude-code' || provider === 'codex' ? rateLimitSnapshots.get(provider) : undefined
    return c.json({ rateLimits: snapshot ?? null })
  })

  // Find port in 3300-3400 range (distinct from tool ports 3100-3200)
  const port = await findAvailablePort(3300, 3400)

  const server = serve({
    fetch: app.fetch,
    port,
    hostname: '127.0.0.1',
  })

  console.log(`[chat-server] Started on http://127.0.0.1:${port}`)

  return { port, authToken, server }
}

