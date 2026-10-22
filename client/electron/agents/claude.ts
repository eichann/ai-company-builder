import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { referenceSchemas, referenceDescriptions, type ReferenceToolName } from '../consultations/tools'
import { COMPANY_FILES_SERVER, COMPANY_FILE_TOOL_NAMES, companyFileDescriptions, companyFileSchemas, companyFileToolId } from '../company-files/tools'
import { wrapLanguageModel } from 'ai'
import { MissingAgentSession } from './recovery'
import { claudeCode } from 'ai-sdk-provider-claude-code'
import crypto from 'crypto'
import { spawnAgentProcess as spawnClaudeCodeProcess } from './process'
import type { AgentConnection, AgentEvent, AgentHostConfig } from './connection'
import { fromClaudeRateLimitInfo } from '../../shared/rate-limits'
import { agentProgressFromSdkMessage } from '../../shared/agent-progress'
import type { PermissionMode } from '../../shared/permission-mode'
import { decideReservedWrite, decideToolWrite } from '../write-guard'
import { decidePrivateWrite, noteToolInput, noteToolResult } from '../private-read-guard'
import { answerAskUserQuestion } from './choice-tools'
import { CLAUDE_CHOICE_TOOL } from '../../shared/choice-prompt'
import { createClaudeSteer, tapQuery } from './steering'

type StreamPart = Awaited<ReturnType<ReturnType<typeof claudeCode>['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never

export interface ClaudeConnectionConfig extends AgentHostConfig {
  getPermissionMode: () => PermissionMode
  isClaudeCodeAuthenticated: () => boolean
  getClaudeCodeCliPath: () => string

}


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

// Map UI model keys → exact Claude Code CLI model strings.
// opus-4-6 / opus-4-8 / opus-5 / opus-5-5 request the 1M-context variant ([1m]); fable-5 has a
// native 1M context window so it takes no suffix; sonnet/haiku stay as aliases.
const MODEL_CLI_MAP: Record<string, string> = {
  'opus-4-6': 'claude-opus-4-6[1m]',
  'opus-4-8': 'claude-opus-4-8[1m]',
  'opus-5': 'claude-opus-5[1m]',
  'opus-5-5': 'claude-opus-5-5[1m]',
  'fable-5': 'claude-fable-5',
  sonnet: 'sonnet',
  haiku: 'haiku',
}
const DEFAULT_CLI_MODEL = 'claude-opus-5-5[1m]'

// `auto` (Claude Code's classifier mode) can be unavailable in two ways, and
// both must degrade to 'default' — which asks through canUseTool — rather than
// break the chat:
// 1. The CLI predates `auto`: it rejects the flag and exits 1 before any output
//    ("error: option '--permission-mode <mode>' argument 'auto' is invalid").
//    The turn is re-run in 'default' and that CLI path is remembered for the run.
// 2. The CLI knows `auto` but this account / plan / model / settings cannot use
//    it: the CLI itself runs in 'default'. The init message is not reliable for
//    this (it can still say 'auto'); the PreToolUse hook's permission_mode is.
// ai-sdk-provider-claude-code accepts `auto` natively since 3.5 (no patch).
const AUTO_REJECTED = /--permission-mode[^\n]*'auto' is invalid/
const autoUnsupportedClis = new Set<string>()
const notifiedConversations = new Set<string>()
export const PERMISSION_FALLBACK_NOTICE = {
  cli: 'お使いのClaude Codeは自動モードに対応していないため、「確認あり」で実行します（Claude Codeを更新すると自動モードになります）。',
  account: 'この環境では自動モードを使えないため、「確認あり」で実行します。',
} as const

function noticeParts(text: string): StreamPart[] {
  const id = `permission-mode-notice-${crypto.randomUUID()}`
  return [{ type: 'text-start', id }, { type: 'text-delta', id, delta: `※ ${text}\n\n` }, { type: 'text-end', id }]
}

/**
 * The provider (ai-sdk-provider-claude-code 3.6.1) drops `rate_limit_event`
 * and `system/task_progress` messages, and has no per-message callback. Its
 * `onQueryCreated` hands over the SDK Query before the provider iterates it,
 * so wrap the Query's iterator to see every message on the way through. The
 * Query's own iterator is its internal message generator, which the wrapper
 * delegates to unchanged (next / return / throw).
 */
export function tapSdkMessages(query: unknown, onMessage: (message: unknown) => void): void {
  const target = query as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> } | null
  if (!target || typeof target[Symbol.asyncIterator] !== 'function') return
  const inner = target[Symbol.asyncIterator]!.bind(target)
  Object.defineProperty(target, Symbol.asyncIterator, {
    configurable: true,
    value: () => {
      const iterator = inner()
      const wrapped: AsyncIterableIterator<unknown> = {
        async next(...args: [] | [unknown]) {
          const result = await iterator.next(...args)
          if (!result.done) {
            try { onMessage(result.value) } catch { /* side information only */ }
          }
          return result
        },
        return: (value?: unknown) => iterator.return ? iterator.return(value) : Promise.resolve({ done: true as const, value }),
        throw: (error?: unknown) => iterator.throw ? iterator.throw(error) : Promise.reject(error),
        [Symbol.asyncIterator]() { return wrapped },
      }
      return wrapped
    },
  })
}

/** SDK message → app event (usage limits, subagent progress), or undefined. */
export function claudeAgentEvent(message: unknown): AgentEvent | undefined {
  const value = message as { type?: unknown; rate_limit_info?: unknown } | null
  if (value?.type === 'rate_limit_event') {
    const info = value.rate_limit_info
    return { type: 'rate-limits', update: previous => fromClaudeRateLimitInfo(info, previous) }
  }
  const progress = agentProgressFromSdkMessage(message)
  return progress ? { type: 'agent-progress', progress } : undefined
}

function resolveClaudeModel(modelId?: string): string {
  if (!modelId) return DEFAULT_CLI_MODEL
  return MODEL_CLI_MAP[modelId] ?? modelId
}

// xhigh effort is only supported on Opus 4.7+ (incl. 4.8), Opus 5, Opus 5.5, and Fable 5.
// Demote elsewhere so a stale selection — e.g. one carried over by session resume — doesn't
// error on the CLI. Note: 'claude-opus-4-5' does not contain 'opus-5', so this check is safe.
// The 'opus-5' substring test deliberately also matches 'claude-opus-5-5[1m]' — keep it a
// substring test, not an exact match, or Opus 5.5 silently loses xhigh.
function resolveEffort(
  model: string,
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max',
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  if (
    effort === 'xhigh' &&
    !(
      model.includes('opus-4-8') ||
      model.includes('opus-4-7') ||
      model.includes('opus-5') ||
      model.includes('fable-5')
    )
  ) {
    return 'high'
  }
  return effort
}

export function createClaudeConnection(config: ClaudeConnectionConfig, createModel = claudeCode): AgentConnection {
  return {
    id: 'claude-code',
    ownsConversation: true,
    authenticationError: () => config.isClaudeCodeAuthenticated() ? undefined : 'Claude Code CLIが認証されていません。',
    isMissingSession(error, sessionId) {
      if (error instanceof MissingAgentSession) return error.sessionId === sessionId
      const value = error as { data?: { stderr?: string }; message?: string } | undefined
      const text = value?.data?.stderr || value?.message || ''
      return text.split('\n').some(line => line.trim() === `No conversation found with session ID: ${sessionId}`)
    },
    createChatModel({ workingDirectory, appSessionId, modelId, effort, resumeId: existingCliSessionId, references, companyFiles, writeGuard, privateReads, askUser, onEvent, steering }) {
      const claudePath = config.getClaudeCodeCliPath()
      const requestedMode = config.getPermissionMode()
      const cliLacksAuto = requestedMode === 'auto' && autoUnsupportedClis.has(claudePath)
      const permissionMode: PermissionMode = cliLacksAuto ? 'default' : requestedMode

      // The mode the CLI actually runs tools in (it reports it on every hook call).
      let observedMode: string | undefined
      // PreToolUse hook: request UI approval for dangerous patterns (works even in bypassPermissions)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preToolUseHook = async (input: any) => {
        if (typeof input.permission_mode === 'string') observedMode = input.permission_mode
        if (input.hook_event_name !== 'PreToolUse') {
          return { continue: true }
        }
        // Background subagents outlive the turn, but the SDK closes the hook
        // control channel (CLI stdin) at the first result — their later hook
        // round-trips then fail open, bypassing the dangerous-command gate, and
        // their results never reach the UI. Force every subagent launch to run
        // synchronously instead. (Bash's own run_in_background is unaffected;
        // the tool name is 'Task' on some CLI versions and 'Agent' on others.)
        if (input.tool_name === 'Task' || input.tool_name === 'Agent') {
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              updatedInput: { ...(input.tool_input ?? {}), run_in_background: false },
            },
          }
        }
        // Read-only folders (per-folder write rules): refuse before the tool
        // runs, with a reason the model relays to the member instead of
        // retrying. Unknown access never blocks (the server still checks).
        const toolCwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : workingDirectory
        let guarded = decideToolWrite(writeGuard, String(input.tool_name), input.tool_input, toolCwd)
        if (!guarded.deny) guarded = await decideReservedWrite(writeGuard, String(input.tool_name), input.tool_input, toolCwd)
        if (guarded.deny) {
          console.log(`[hooks] Blocked write to read-only folder: ${input.tool_name} ${guarded.path}`)
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: guarded.message,
            },
          }
        }
        // Private content → public places (private-read-guard.ts): once this
        // conversation has read a private folder, the member confirms every
        // write to a public place and every send-out — in every permission
        // mode, so the question is asked here and not left to canUseTool.
        let confirmedPrivate = false
        if (privateReads) {
          noteToolInput(privateReads.context, privateReads.state, String(input.tool_name), input.tool_input, toolCwd)
          const decision = decidePrivateWrite(privateReads.context, privateReads.state, String(input.tool_name), input.tool_input, toolCwd)
          if (decision.ask) {
            const answer = config.requestToolApproval
              ? await config.requestToolApproval(String(input.tool_name), input.tool_input ?? {}, input.tool_use_id || crypto.randomUUID(), appSessionId, decision.message)
              : { approved: false }
            if (!answer.approved) {
              console.log(`[hooks] Member declined a write after private reads: ${input.tool_name}`)
              return {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny',
                  permissionDecisionReason: `${decision.message}ユーザーが許可しなかったため実行していません。別の方法で同じ操作をせず、ユーザーに確認してください。`,
                },
              }
            }
            confirmedPrivate = true
          }
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
        // The member just confirmed this very call: do not ask twice.
        if (confirmedPrivate) {
          return { continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: input.tool_input ?? {} } }
        }
        // No decision: leave it to the permission mode. Returning 'allow' here
        // skipped both the auto-mode classifier and the 'default' approval
        // prompt for every tool.
        return { continue: true }
      }
      // PostToolUse: what a Grep / shell command printed can be private content.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const postToolUseHook = async (input: any) => {
        if (privateReads && input.hook_event_name === 'PostToolUse') {
          noteToolResult(privateReads.context, privateReads.state, String(input.tool_name), input.tool_response)
        }
        return { continue: true }
      }

      // canUseTool: UI approval dialog. In 'auto' the classifier denies risky
      // calls outright (no prompt); calls reach canUseTool when the CLI falls
      // back to asking — auto unavailable (it starts in 'default') or the
      // classifier's denial limit — so 'auto' needs it as much as 'default'.
      // AskUserQuestion (choice prompts) always comes here, in every mode —
      // bypassPermissions too — so canUseTool is installed whenever the turn
      // can show a choice card; in bypassPermissions nothing else reaches it
      // except an explicit `ask` rule, which stays refused as before.
      const approvals = permissionMode !== 'bypassPermissions' && !!config.requestToolApproval
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const canUseToolFn: any = approvals || askUser
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? async (toolName: string, toolInput: Record<string, unknown>, options: any) => {
            if (toolName === CLAUDE_CHOICE_TOOL) return answerAskUserQuestion(askUser, toolInput, options?.toolUseID, options?.signal)
            if (!approvals) return { behavior: 'deny' as const, message: 'この操作は確認が必要なため実行していません。' }
            // Read-only tools: auto-allow. Every allow echoes updatedInput: older CLIs
            // (e.g. 2.0.x, the ones that also lack auto) reject an allow without it.
            const readOnlyTools = ['Read', 'ListDirectory', 'Glob', 'Grep', 'View']
            if (readOnlyTools.includes(toolName) || (references && Object.keys(referenceSchemas).some(name => toolName === `mcp__acb_consultations__${name}`)) || (companyFiles && COMPANY_FILE_TOOL_NAMES.some(name => toolName === companyFileToolId(name)))) {
              return { behavior: 'allow' as const, updatedInput: toolInput }
            }
            // Request approval from UI
            const result = await config.requestToolApproval!(
              toolName,
              toolInput,
              options.toolUseID || crypto.randomUUID(),
              appSessionId,
            )
            if (result.approved) {
              return { behavior: 'allow' as const, updatedInput: toolInput }
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

      const resolvedModel = resolveClaudeModel(modelId)
      const resolvedEffort = resolveEffort(resolvedModel, effort as Parameters<typeof resolveEffort>[1])

      const createNative = (mode: PermissionMode) => {
        // One MCP server instance per query: a fallback re-run must not reuse the first one.
        const referenceServer = references ? createSdkMcpServer({ name: 'acb_consultations', tools: (Object.keys(referenceSchemas) as ReferenceToolName[]).map(name => tool(name, referenceDescriptions[name], referenceSchemas[name].shape, async args => ({ content: [{ type: 'text' as const, text: await references.execute(name, args) }] }))) }) : undefined
        // App-provided (not the company repository's .mcp.json, which is protected config).
        const companyFilesServer = companyFiles ? createSdkMcpServer({ name: COMPANY_FILES_SERVER, tools: COMPANY_FILE_TOOL_NAMES.map(name => tool(name, companyFileDescriptions[name], companyFileSchemas[name].shape, async args => ({ content: [{ type: 'text' as const, text: await companyFiles.execute(name, args) }] }), { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } })) }) : undefined
        const mcpServers = {
          ...(referenceServer ? { acb_consultations: referenceServer } : {}),
          ...(companyFilesServer ? { [COMPANY_FILES_SERVER]: companyFilesServer } : {}),
        }
        const allowedTools = [
          ...(referenceServer ? Object.keys(referenceSchemas).map(name => `mcp__acb_consultations__${name}`) : []),
          ...(companyFilesServer ? COMPANY_FILE_TOOL_NAMES.map(companyFileToolId) : []),
        ]
        const state = { missingSession: false, autoRejected: false }
        // Steering (steering.ts): watch the query the provider runs. Next-prompt
        // suggestions are generated by ACB after the turn (prompt-suggester.ts),
        // not by the CLI's `promptSuggestions`.
        const onQueryCreated = steering ? (query: object) => {
          const steer = createClaudeSteer(query as Parameters<typeof createClaudeSteer>[0])
          steering.attach(steer.target)
          tapQuery(query, message => steer.observe(message), () => {
            steer.close()
            steering.detach(steer.target)
          })
        } : undefined
        const model = createModel(resolvedModel, {
          pathToClaudeCodeExecutable: claudePath,
          permissionMode: mode,
          cwd: workingDirectory,
          env: config.getShellEnv(),
          settingSources: ['user', 'project'],
          streamingInput: 'always',
          // One-line progress for running subagents (task_progress.summary),
          // shown in the subagent row; see shared/agent-progress.ts.
          ...(onEvent ? { agentProgressSummaries: true } : {}),
          // Both observers watch the same Query: usage/progress events, and
          // steering (each wraps the iterator the provider reads).
          ...(onEvent || onQueryCreated ? {
            onQueryCreated: (query: unknown) => {
              if (onEvent) tapSdkMessages(query, message => {
                const event = claudeAgentEvent(message)
                if (event) onEvent(event)
              })
              onQueryCreated?.(query as object)
            },
          } : {}),
          ...(allowedTools.length > 0 ? { mcpServers, allowedTools } : {}),
          ...(existingCliSessionId ? { resume: existingCliSessionId } : {}),
          // Passed straight to the CLI as `--effort` (xhigh needs CLI v2.1.111+).
          ...(resolvedEffort ? { sdkOptions: { effort: resolvedEffort } } : {}),
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
          spawnClaudeCodeProcess: opts => {
            const child = spawnClaudeCodeProcess(opts)
            // The SDK can discard stderr on result errors; inspect only these exact startup failures.
            let pending = ''
            if (existingCliSessionId || mode === 'auto') child.stderr?.on('data', (chunk: Buffer) => {
              pending += chunk.toString()
              const lines = pending.split('\n'); pending = lines.pop()!.slice(-512)
              if (existingCliSessionId && lines.some(line => line.trim() === `No conversation found with session ID: ${existingCliSessionId}`)) state.missingSession = true
              if (mode === 'auto' && lines.some(line => AUTO_REJECTED.test(line))) state.autoRejected = true
            })
            return child
          },
          hooks: {
            PreToolUse: [{ hooks: [preToolUseHook] }],
            ...(privateReads ? { PostToolUse: [{ hooks: [postToolUseHook] }] } : {}),
          },
          ...(canUseToolFn ? { canUseTool: canUseToolFn } : {}),
        })
        return { model, state }
      }

      const primary = createNative(permissionMode)
      if (!existingCliSessionId && requestedMode !== 'auto') return primary.model
      // The fallback notice is shown once per conversation, as soon as it applies,
      // outside any open text block.
      const takeNotice = (text: string | undefined) => {
        if (!text || (appSessionId && notifiedConversations.has(appSessionId))) return undefined
        if (appSessionId) notifiedConversations.add(appSessionId)
        return text
      }
      const relay = (stream: ReadableStream<StreamPart>, state: typeof primary.state, pendingNotice: () => string | undefined) => {
        let shown = false
        const openText = new Set<string>()
        return stream.pipeThrough(new TransformStream<StreamPart, StreamPart>({
          transform(part, controller) {
            if (!shown && openText.size === 0 && part.type !== 'stream-start' && part.type !== 'response-metadata' && part.type !== 'error') {
              const pending = pendingNotice()
              if (pending) {
                shown = true
                const text = takeNotice(pending)
                if (text) for (const extra of noticeParts(text)) controller.enqueue(extra)
              }
            }
            if (part.type === 'text-start') openText.add(part.id)
            else if (part.type === 'text-end') openText.delete(part.id)
            controller.enqueue(part.type === 'error' && state.missingSession && existingCliSessionId ? { type: 'error', error: new MissingAgentSession(existingCliSessionId) } : part)
          },
        }))
      }
      const cliNotice = () => PERMISSION_FALLBACK_NOTICE.cli
      const accountNotice = () => (observedMode === 'default' ? PERMISSION_FALLBACK_NOTICE.account : undefined)
      return wrapLanguageModel({ model: primary.model, middleware: {
        specificationVersion: 'v3',
        wrapStream: async ({ doStream, params }) => {
          if (requestedMode !== 'auto' || cliLacksAuto) {
            const result = await doStream()
            return { ...result, stream: relay(result.stream, primary.state, cliLacksAuto ? cliNotice : () => undefined) }
          }
          // A CLI without `auto` rejects the flag before producing anything:
          // peek at the first real part and, on that exact failure, re-run the
          // turn in 'default' (nothing has reached the user yet).
          const fallback = async () => {
            autoUnsupportedClis.add(claudePath)
            console.warn(`[chat-server] ${claudePath} does not support --permission-mode auto; falling back to default`)
            const retry = createNative('default')
            const result = await retry.model.doStream(params)
            return { ...result, stream: relay(result.stream, retry.state, cliNotice) }
          }
          let result
          try { result = await doStream() } catch (error) {
            if (primary.state.autoRejected) return fallback()
            throw error
          }
          const reader = result.stream.getReader()
          const head: StreamPart[] = []
          for (;;) {
            const next = await reader.read()
            if (next.done) break
            head.push(next.value)
            if (next.value.type !== 'stream-start') break
          }
          if (head.at(-1)?.type === 'error' && primary.state.autoRejected) {
            await reader.cancel().catch(() => {})
            return fallback()
          }
          const replay = new ReadableStream<StreamPart>({
            start(controller) { for (const part of head) controller.enqueue(part) },
            async pull(controller) {
              const next = await reader.read()
              if (next.done) controller.close(); else controller.enqueue(next.value)
            },
            cancel(reason) { return reader.cancel(reason) },
          })
          return { ...result, stream: relay(replay, primary.state, accountNotice) }
        },
      } })
    },
    createTitleModel() {
      return createModel('haiku', {
        pathToClaudeCodeExecutable: config.getClaudeCodeCliPath(),
        env: config.getShellEnv(),
        settingSources: ['user', 'project'],
        spawnClaudeCodeProcess,
      })
    },
    readMetadata(metadata) {
      const value = metadata?.['claude-code'] as { sessionId?: string } | undefined
      return { sessionId: value?.sessionId }
    },
  }
}
