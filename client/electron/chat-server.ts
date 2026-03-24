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
import fs from 'fs'
import net from 'net'
import { spawn as nodeSpawn } from 'child_process'

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

  // Latest usage info from the most recent chat completion
  let latestUsage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    noCacheTokens: number
  } | null = null


  // CORS for Electron renderer (Vite dev server or file:// protocol)
  app.use('/*', cors({
    origin: (origin) => origin || '*',
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['POST', 'GET', 'OPTIONS'],
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
      modelId,
    }: {
      messages: UIMessage[]
      systemPrompt?: string
      workingDirectory?: string
      skillInfo?: { skillFolderPath: string }
      images?: Array<{ mediaType: string; data: string }>
      modelId?: string
    } = body

    const authMode = config.getAuthMode()

    // Claude Code CLI mode: minimal context only (working directory + language)
    // Claude Code has its own comprehensive system prompt; heavy injection degrades quality.
    // API key mode: build full system prompt as before.
    let finalSystemPrompt: string | undefined
    if (authMode === 'claude-code') {
      if (workingDirectory) {
        finalSystemPrompt = `あなたの作業ディレクトリは「${workingDirectory}」です。\nファイル操作はこのディレクトリ内で行ってください。\n日本語で回答してください。`
      }
    } else {
      finalSystemPrompt = (systemPrompt || config.buildSystemPrompt(workingDirectory)) + SECURITY_POLICY
    }

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

      model = claudeCode(modelId || 'sonnet', {
        pathToClaudeCodeExecutable: claudePath,
        permissionMode,
        cwd: workingDirectory,
        env: config.getShellEnv(),
        settingSources: ['user', 'project'],
        streamingInput: 'always',
        // Custom spawn to avoid EBADF in Electron's main process.
        //
        // Problem: Electron's main process has many open FDs from Chromium
        // (GPU, IPC, renderer, crash reporter, etc.) that lack FD_CLOEXEC.
        // These inherited FDs cause posix_spawn to fail with EBADF — both
        // when WE spawn the Claude CLI, and when the Claude CLI itself
        // tries to spawn subprocesses (Bash tool, Glob tool, etc.).
        //
        // Fix (3 layers):
        // 1. Repair FDs 0-2 if invalid (reopen to /dev/null)
        // 2. Set uid to force fork+exec instead of posix_spawn for THIS spawn
        // 3. Spawn via shell wrapper that closes all inherited FDs > 2
        //    before exec'ing claude, so claude starts with a clean FD table
        spawnClaudeCodeProcess: (opts: { command: string; args: string[]; cwd?: string; env?: Record<string, string>; signal?: AbortSignal }) => {
          // Defense 1: Ensure FDs 0-2 are valid
          for (const fd of [0, 1, 2]) {
            try { fs.fstatSync(fd) }
            catch {
              console.warn(`[chat-server] FD ${fd} invalid, reopening as /dev/null`)
              fs.openSync('/dev/null', fd === 0 ? 'r' : 'w')
            }
          }

          console.log('[chat-server] spawning claude:', opts.command, opts.args?.slice(0, 3))
          try {
            // Defense 3: Spawn through a shell wrapper that closes all
            // inherited FDs > 2 before exec'ing the Claude CLI.
            //
            // Why: Even after we successfully spawn (Defense 2), the Claude
            // CLI inherits Electron's FDs. When Claude CLI's Node.js runtime
            // uses posix_spawn for its own tools (Bash, Glob, etc.), those
            // inherited FDs cause EBADF again.
            //
            // The shell script:
            //   - Globs /dev/fd/* to get all open FDs
            //   - Closes every FD > 2 (preserves stdin=0, stdout=1, stderr=2)
            //   - exec's the claude command (replaces shell, no extra process)
            //
            // "$0" = opts.command, "$@" = opts.args (passed after the script)
            const child = nodeSpawn('/bin/sh', [
              '-c',
              'for f in /dev/fd/*; do n="${f##*/}"; [ "$n" -gt 2 ] 2>/dev/null && eval "exec $n>&-" 2>/dev/null || true; done; exec "$0" "$@"',
              opts.command,
              ...opts.args,
            ], {
              cwd: opts.cwd,
              env: opts.env,
              stdio: ['pipe', 'pipe', 'ignore'],
              signal: opts.signal,
              windowsHide: true,
              // Defense 2: Force fork+exec on macOS (skip posix_spawn)
              ...(process.getuid ? { uid: process.getuid() } : {}),
            })
            console.log('[chat-server] spawn succeeded, pid:', child.pid)
            child.on('error', (err) => console.error('[chat-server] child process error:', err))
            return child
          } catch (err) {
            console.error('[chat-server] spawn THREW:', err)
            throw err
          }
        },
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

    // Claude Code CLI mode: skip client-side pruning — Claude Code manages its own context
    // API key mode: prune old messages to manage context window
    let finalMessages = modelMessages
    if (authMode !== 'claude-code') {
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
          finalMessages[i] = { ...finalMessages[i], content: parts }
          break
        }
      }
    }

    const result = streamText({
      model,
      ...(finalSystemPrompt ? { system: finalSystemPrompt } : {}),
      messages: finalMessages,
      ...(tools ? { tools, stopWhen: stepCountIs(10) } : {}),
      onStepFinish: ({ finishReason, usage, toolCalls }) => {
        console.log(`[chat-server] Step finished: reason=${finishReason}, tokens=${usage.totalTokens}, tools=${toolCalls.length}`)
        // Update latest usage for the /api/usage endpoint
        if (usage.totalTokens != null) {
          latestUsage = {
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            totalTokens: usage.totalTokens ?? 0,
            cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
            cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
            noCacheTokens: usage.inputTokenDetails?.noCacheTokens ?? 0,
          }
        }
      },
      onError: ({ error }) => {
        console.error('[chat-server] Stream error:', error)
      },
    })

    return result.toUIMessageStreamResponse({
      sendReasoning: true,
    })
  })

  // GET /api/usage — returns latest token usage from the most recent completion
  app.get('/api/usage', (c) => {
    return c.json({ usage: latestUsage })
  })

  // GET /api/context — returns context usage estimate based on latest step usage
  app.get('/api/context', (c) => {
    return c.json({ context: null })
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

