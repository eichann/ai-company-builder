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
import { createClaudeConnection } from './agents/claude'
import { createApiConnection } from './agents/anthropic-api'
import type { ClaudeConnectionConfig } from './agents/claude'
import { createFileSystemTools, createSkillTools } from './chat-tools'
import crypto from 'crypto'
import net from 'net'

export interface ChatServerConfig extends ClaudeConnectionConfig {
  getApiKey: () => string | undefined
  getAuthMode: () => 'claude-code' | 'codex' | 'api-key'
  buildSystemPrompt: (workingDirectory?: string) => string
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

  // Per-session usage and context tracking
  interface SessionUsage {
    latestUsage: {
      inputTokens: number
      outputTokens: number
      totalTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
      noCacheTokens: number
    } | null
    accumulatedInputTokens: number
    accumulatedOutputTokens: number
    contextWindowSize: number
  }
  const sessionUsageMap = new Map<string, SessionUsage>()

  function getSessionUsage(sessionId: string): SessionUsage {
    let usage = sessionUsageMap.get(sessionId)
    if (!usage) {
      usage = { latestUsage: null, accumulatedInputTokens: 0, accumulatedOutputTokens: 0, contextWindowSize: 0 }
      sessionUsageMap.set(sessionId, usage)
    }
    return usage
  }

  // Current native session for each ACB conversation (provider-tagged).
  const agentSessionMap = new Map<string, AgentSession>()


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
      claudeSessionId: bodyClaudeSessionId,
      agentSession: bodyAgentSession,
      authMode: requestedAuthMode,
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
      claudeSessionId?: string
      agentSession?: AgentSession | null
      authMode?: AuthMode
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
    const model = connection.createChatModel({ workingDirectory, appSessionId, modelId, effort, resumeId: existingCliSessionId })

    // API key mode: add filesystem tools + optional skill tools
    const tools = (() => {
      if (connection.ownsConversation) return undefined
      const fsTools = workingDirectory ? createFileSystemTools(workingDirectory, config.requestToolApproval) : undefined
      const skillTools = skillInfo?.skillFolderPath ? createSkillTools(skillInfo.skillFolderPath) : undefined
      if (!fsTools && !skillTools) return undefined
      return { ...fsTools, ...skillTools }
    })()

    let inputMessages = messages
    try {
      if (connection.ownsConversation) inputMessages = agentInputMessages(messages, existingCliSessionId)
      else if (candidate && candidate.providerId !== authMode) inputMessages = agentInputMessages(messages)
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400) }
    const modelMessages = await convertToModelMessages(inputMessages)

    // Debug: log reference files and system prompt
    if (referenceFiles && referenceFiles.length > 0) {
      console.log('[chat-server] Reference files:', referenceFiles)
    }
    if (finalSystemPrompt) {
      console.log('[chat-server] System prompt (last 300 chars):', finalSystemPrompt.slice(-300))
    }

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

    const result = streamText({
      abortSignal: c.req.raw.signal,
      maxRetries: 0,
      model,
      ...(finalSystemPrompt ? { system: finalSystemPrompt } : {}),
      messages: finalMessages,
      ...(tools ? { tools, stopWhen: stepCountIs(10) } : {}),
      onStepFinish: ({ finishReason, usage, toolCalls, providerMetadata }) => {
        console.log(`[chat-server] Step finished: reason=${finishReason}, tokens=${usage.totalTokens}, tools=${toolCalls.length}`)
        // Update per-session usage
        const sid = appSessionId || '__default__'
        const su = getSessionUsage(sid)
        if (usage.totalTokens != null) {
          su.latestUsage = {
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            totalTokens: usage.totalTokens ?? 0,
            cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
            cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
            noCacheTokens: usage.inputTokenDetails?.noCacheTokens ?? 0,
          }
        }
        if (!connection.ownsConversation && appSessionId) agentSessionMap.set(appSessionId, { providerId: authMode, id: appSessionId, modelId })
        const metadata = connection.readMetadata(providerMetadata)
        if (metadata.sessionId && appSessionId) {
          agentSessionMap.set(appSessionId, { providerId: authMode, id: metadata.sessionId, modelId })
        }
        if (metadata.contextUsage) {
          su.accumulatedInputTokens = metadata.contextUsage.inputTokens
          su.accumulatedOutputTokens = metadata.contextUsage.outputTokens
          if (metadata.contextUsage.contextWindow) su.contextWindowSize = metadata.contextUsage.contextWindow
        }
      },
      onError: ({ error }) => {
        console.error('[chat-server] Stream error:', error)
      },
    })

    return result.toUIMessageStreamResponse({
      sendReasoning: true,
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
    // Clean up per-session usage tracking
    sessionUsageMap.delete(id)
    console.log(`[chat-server] Session cleared: ${id} (found: ${deleted})`)
    return c.json({ success: true })
  })

  // GET /api/usage?sessionId=xxx — returns latest token usage for a specific session
  app.get('/api/usage', (c) => {
    const sessionId = c.req.query('sessionId') || '__default__'
    const su = sessionUsageMap.get(sessionId)
    return c.json({ usage: su?.latestUsage || null })
  })

  // GET /api/context?sessionId=xxx — returns context usage for a specific session
  app.get('/api/context', (c) => {
    const sessionId = c.req.query('sessionId') || '__default__'
    const su = sessionUsageMap.get(sessionId)
    if (!su || (su.accumulatedInputTokens === 0 && su.contextWindowSize === 0)) {
      return c.json({ context: null })
    }
    const maxTokens = su.contextWindowSize > 0 ? su.contextWindowSize : 200_000
    const usedTokens = su.accumulatedInputTokens + su.accumulatedOutputTokens
    const percentage = Math.min(100, Math.round((usedTokens / maxTokens) * 100))
    return c.json({
      context: { usedTokens, maxTokens, percentage },
    })
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

