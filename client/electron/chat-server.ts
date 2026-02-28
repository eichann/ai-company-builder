import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { cors } from 'hono/cors'
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  wrapLanguageModel,
  extractReasoningMiddleware,
  type UIMessage,
} from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { claudeCode } from 'ai-sdk-provider-claude-code'
import { createFileSystemTools, createSkillTools } from './chat-tools'
import crypto from 'crypto'
import net from 'net'

export interface ChatServerConfig {
  getAuthMode: () => 'claude-code' | 'api-key'
  getApiKey: () => string | undefined
  getPermissionMode: () => 'bypassPermissions' | 'default'
  isClaudeCodeAuthenticated: () => boolean
  getClaudeCodeCliPath: () => string
  getShellEnv: () => Record<string, string>
  buildSystemPrompt: (workingDirectory?: string) => string
  requestToolApproval?: (
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string,
  ) => Promise<{ approved: boolean }>
}

// ============================================================================
// Dangerous command patterns (auto-deny via PreToolUse hooks)
// ============================================================================

const DANGEROUS_PATTERNS: RegExp[] = [
  // Direct deletion commands
  /\brm\s/,                          // rm (file deletion)
  /\bunlink\s/,                      // unlink
  /\bshred\s/,                       // shred (secure delete)
  /\bfind\b.*\s-delete\b/,           // find ... -delete
  /\bfind\b.*-exec\s+rm\b/,          // find ... -exec rm

  // Scripted deletion (Python, Node, etc.)
  /\bos\.remove\s*\(/,               // Python os.remove()
  /\bos\.unlink\s*\(/,               // Python os.unlink()
  /\bshutil\.rmtree\s*\(/,           // Python shutil.rmtree()
  /\bpathlib\b.*\.unlink\s*\(/,      // Python pathlib unlink
  /\bfs\.unlink/,                    // Node fs.unlink
  /\bfs\.rm\b/,                      // Node fs.rm / fs.rmSync
  /\bfs\.rmdir/,                     // Node fs.rmdir

  // Git destructive
  /\bgit\s+reset\s+--hard/,          // git reset --hard
  /\bgit\s+push\s+--force/,          // git push --force
  /\bgit\s+push\s+-f\b/,             // git push -f
  /\bgit\s+clean\s+-f/,              // git clean -f

  // System-level destructive
  /\bchmod\s+777\b/,                 // chmod 777
  /\bmkfs\b/,                        // mkfs
  /\bdd\s+if=/,                      // dd if=
  />\s*\//,                          // > / (redirect to root)
]

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

  // CORS for Electron renderer (Vite dev server or file:// protocol)
  app.use('/*', cors({
    origin: (origin) => origin || '*',
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['POST', 'OPTIONS'],
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
      skillInfo,
      images,
    }: {
      messages: UIMessage[]
      systemPrompt?: string
      workingDirectory?: string
      skillInfo?: { skillFolderPath: string }
      images?: Array<{ mediaType: string; data: string }>
    } = body

    const authMode = config.getAuthMode()
    const basePrompt = systemPrompt || config.buildSystemPrompt(workingDirectory)

    // Append security policy to all system prompts
    const finalSystemPrompt = basePrompt + SECURITY_POLICY

    let model
    if (authMode === 'claude-code') {
      if (!config.isClaudeCodeAuthenticated()) {
        return c.json({ error: 'Claude Code CLIが認証されていません。' }, 401)
      }
      const claudePath = config.getClaudeCodeCliPath()
      const permissionMode = config.getPermissionMode()

      // PreToolUse hook: request UI approval for dangerous patterns (works even in bypassPermissions)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preToolUseHook = async (input: any) => {
        if (input.hook_event_name !== 'PreToolUse') {
          return { continue: true }
        }
        if (input.tool_name === 'Bash') {
          const cmd = String(input.tool_input?.command || '')
          for (const pattern of DANGEROUS_PATTERNS) {
            if (pattern.test(cmd)) {
              console.log(`[hooks] Dangerous pattern detected: ${cmd}`)

              // If UI approval is available, ask the user
              if (config.requestToolApproval) {
                const toolUseId = input.tool_use_id || crypto.randomUUID()
                const result = await config.requestToolApproval(
                  input.tool_name,
                  { command: cmd },
                  toolUseId,
                )
                if (result.approved) {
                  console.log(`[hooks] User approved dangerous command: ${cmd}`)
                  return {
                    continue: true,
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'allow',
                    },
                  }
                }
              }

              // Auto-deny if no UI approval available or user denied
              console.log(`[hooks] Blocked dangerous command: ${cmd}`)
              return {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny',
                  permissionDecisionReason: 'Blocked: dangerous pattern detected',
                },
              }
            }
          }
        }
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
          },
        }
      }

      // canUseTool: UI approval dialog (only in 'default' mode)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const canUseToolFn: any = permissionMode === 'default' && config.requestToolApproval
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? async (toolName: string, toolInput: Record<string, unknown>, options: any) => {
            // Read-only tools: auto-allow
            const readOnlyTools = ['Read', 'ListDirectory', 'Glob', 'Grep', 'View']
            if (readOnlyTools.includes(toolName)) {
              return { behavior: 'allow' as const }
            }
            // Request approval from UI
            const result = await config.requestToolApproval!(
              toolName,
              toolInput,
              options.toolUseID || crypto.randomUUID(),
            )
            if (result.approved) {
              return { behavior: 'allow' as const }
            }
            return {
              behavior: 'deny' as const,
              message: 'ユーザーにより拒否されました',
            }
          }
        : undefined

      model = claudeCode('sonnet', {
        pathToClaudeCodeExecutable: claudePath,
        permissionMode,
        cwd: workingDirectory,
        env: config.getShellEnv(),
        streamingInput: 'auto',
        hooks: {
          PreToolUse: [{ hooks: [preToolUseHook] }],
        },
        ...(canUseToolFn ? { canUseTool: canUseToolFn } : {}),
      })
    } else {
      const apiKey = config.getApiKey()
      if (!apiKey) {
        return c.json({ error: 'APIキーが設定されていません。' }, 401)
      }
      const anthropic = createAnthropic({ apiKey })
      // Wrap with middleware to extract <think> tags as reasoning parts
      model = wrapLanguageModel({
        model: anthropic('claude-sonnet-4-20250514'),
        middleware: extractReasoningMiddleware({
          tagName: 'think',
        }),
      })
    }

    // API key mode: add filesystem tools + optional skill tools
    const tools = (() => {
      if (authMode !== 'api-key') return undefined
      const fsTools = workingDirectory ? createFileSystemTools(workingDirectory, config.requestToolApproval) : undefined
      const skillTools = skillInfo?.skillFolderPath ? createSkillTools(skillInfo.skillFolderPath) : undefined
      if (!fsTools && !skillTools) return undefined
      return { ...fsTools, ...skillTools }
    })()

    const modelMessages = await convertToModelMessages(messages)

    // Prune old messages to manage context window
    // Conservative strategy: keep reasoning, remove old tool results only
    const prunedMessages = pruneMessages({
      messages: modelMessages,
      reasoning: 'none',
      toolCalls: 'before-last-5-messages',
      emptyMessages: 'remove',
    })

    // Sliding window: keep last 80 messages (≈40 turns) to prevent context overflow
    const MAX_CONTEXT_MESSAGES = 80
    const windowedMessages = prunedMessages.length > MAX_CONTEXT_MESSAGES
      ? prunedMessages.slice(-MAX_CONTEXT_MESSAGES)
      : prunedMessages

    console.log(`[chat-server] Messages: ${modelMessages.length} → ${prunedMessages.length} (pruned) → ${windowedMessages.length} (windowed)`)

    // Inject images into the last user message (sent via transport body)
    if (images && images.length > 0) {
      console.log(`[chat-server] Injecting ${images.length} image(s) into model messages`)
      for (let i = windowedMessages.length - 1; i >= 0; i--) {
        if (windowedMessages[i].role === 'user') {
          const userContent = windowedMessages[i].content
          if (Array.isArray(userContent)) {
            for (const img of images) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ;(userContent as any[]).push({
                type: 'image',
                image: img.data,
                mimeType: img.mediaType,
              })
            }
          }
          break
        }
      }
    }

    const result = streamText({
      model,
      system: finalSystemPrompt,
      messages: windowedMessages,
      ...(tools ? { tools, stopWhen: stepCountIs(10) } : {}),
      onStepFinish: ({ finishReason, usage, toolCalls }) => {
        console.log(`[chat-server] Step finished: reason=${finishReason}, tokens=${usage.totalTokens}, tools=${toolCalls.length}`)
      },
      onError: ({ error }) => {
        console.error('[chat-server] Stream error:', error)
      },
    })

    return result.toUIMessageStreamResponse({
      sendReasoning: true,
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
