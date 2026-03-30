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
    appSessionId?: string,
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
  /(?<!\d)>\s*\//,                    // > / (redirect to root, but not 2>/dev/null)
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

  // Claude Code CLI session ID tracking (appSessionId → claudeCliSessionId)
  const claudeSessionMap = new Map<string, string>()


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
    }: {
      messages: UIMessage[]
      systemPrompt?: string
      workingDirectory?: string
      activeDepartment?: { name: string; folder: string }
      skillInfo?: { skillFolderPath: string }
      images?: Array<{ mediaType: string; data: string }>
      modelId?: string
      effort?: 'low' | 'medium' | 'high' | 'max'
      referenceFiles?: string[]
      appSessionId?: string
      claudeSessionId?: string
    } = body

    const authMode = config.getAuthMode()

    // Claude Code CLI mode: minimal context only (working directory + language)
    // Claude Code has its own comprehensive system prompt; heavy injection degrades quality.
    // API key mode: build full system prompt as before.
    let finalSystemPrompt: string | undefined
    if (authMode === 'claude-code') {
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
        const refInstruction = `\n\n重要: ユーザーが以下のファイルを参照として添付しました。回答する前に、必ずこれらのファイルをReadツールで読み込み、内容を踏まえて回答してください:\n${fileList}`
        finalSystemPrompt = (finalSystemPrompt || '') + refInstruction
      }
    } else {
      finalSystemPrompt = (systemPrompt || config.buildSystemPrompt(workingDirectory)) + SECURITY_POLICY
    }

    // Look up existing Claude CLI session for resume (before model creation)
    // Priority: 1) frontend-persisted claudeSessionId  2) in-memory map  3) none
    const existingCliSessionId = authMode === 'claude-code'
      ? (bodyClaudeSessionId || (appSessionId ? claudeSessionMap.get(appSessionId) : undefined))
      : undefined

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
                  appSessionId,
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
              appSessionId,
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

      if (existingCliSessionId) {
        console.log(`[chat-server] Resuming Claude CLI session: ${existingCliSessionId} (app session: ${appSessionId})`)
      }

      model = claudeCode(modelId || 'sonnet', {
        pathToClaudeCodeExecutable: claudePath,
        permissionMode,
        cwd: workingDirectory,
        env: config.getShellEnv(),
        settingSources: ['user', 'project'],
        streamingInput: 'always',
        ...(existingCliSessionId ? { resume: existingCliSessionId } : {}),
        ...(effort ? { sdkOptions: { effort } } : {}),
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
        spawnClaudeCodeProcess: (opts: { command: string; args: string[]; cwd?: string; env?: Record<string, string | undefined>; signal?: AbortSignal }) => {
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
              stdio: ['pipe', 'pipe', 'pipe'],
              signal: opts.signal,
              windowsHide: true,
              // Defense 2: Force fork+exec on macOS (skip posix_spawn)
              ...(process.getuid ? { uid: process.getuid() } : {}),
            })
            console.log('[chat-server] spawn succeeded, pid:', child.pid)
            child.on('error', (err) => console.error('[chat-server] child process error:', err))
            child.stderr?.on('data', (data: Buffer) => console.error('[chat-server] claude stderr:', data.toString()))
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
    if (authMode === 'claude-code' && existingCliSessionId) {
      // Resume mode: only send the latest user message
      let lastUserIdx = -1
      for (let i = finalMessages.length - 1; i >= 0; i--) {
        if (finalMessages[i].role === 'user') { lastUserIdx = i; break }
      }
      if (lastUserIdx >= 0) {
        finalMessages = [finalMessages[lastUserIdx]]
        console.log(`[chat-server] Resume mode: sending only latest user message (trimmed ${modelMessages.length} → 1)`)
      }
    } else if (authMode !== 'claude-code') {
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
        // Capture Claude Code CLI session ID and modelUsage for context tracking
        if (authMode === 'claude-code' && providerMetadata) {
          const claudeMeta = providerMetadata['claude-code'] as {
            sessionId?: string
            modelUsage?: Record<string, {
              inputTokens?: number
              outputTokens?: number
              contextWindow?: number
              costUSD?: number
            }>
          } | undefined

          if (claudeMeta?.sessionId && appSessionId) {
            claudeSessionMap.set(appSessionId, claudeMeta.sessionId)
            console.log(`[chat-server] Captured CLI session: ${claudeMeta.sessionId} for app session: ${appSessionId}`)
          }

          // Extract context usage from modelUsage (per-session)
          if (claudeMeta?.modelUsage) {
            let totalInput = 0
            let totalOutput = 0
            for (const [modelName, mu] of Object.entries(claudeMeta.modelUsage)) {
              totalInput += mu.inputTokens ?? 0
              totalOutput += mu.outputTokens ?? 0
              if (mu.contextWindow && mu.contextWindow > 0) {
                su.contextWindowSize = mu.contextWindow
              }
              console.log(`[chat-server] modelUsage[${modelName}]: in=${mu.inputTokens} out=${mu.outputTokens} ctx=${mu.contextWindow}`)
            }
            su.accumulatedInputTokens = totalInput
            su.accumulatedOutputTokens = totalOutput
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

  // GET /api/session/:appSessionId — return CLI session ID for persistence
  app.get('/api/session/:appSessionId', (c) => {
    const id = c.req.param('appSessionId')
    const claudeSessionId = claudeSessionMap.get(id) || null
    return c.json({ claudeSessionId })
  })

  // DELETE /api/session/:appSessionId — clear Claude CLI session mapping (on new chat / tab close)
  app.delete('/api/session/:appSessionId', (c) => {
    const id = c.req.param('appSessionId')
    const deleted = claudeSessionMap.delete(id)
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

