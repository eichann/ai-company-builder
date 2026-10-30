import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { referenceSchemas, referenceDescriptions, type ReferenceToolName } from '../consultations/tools'
import { COMPANY_FILES_SERVER, COMPANY_FILE_TOOL_NAMES, companyFileDescriptions, companyFileSchemas, companyFileToolId } from '../company-files/tools'
import { REVIEW_SERVER, REVIEW_TOOL, REVIEW_TOOL_ID, reviewDescription, reviewSchema } from '../review/tools'
import { WEB_RESEARCH_SERVER, WEB_RESEARCH_TOOL, webResearchDescription, webResearchSchema } from '../web-research/tools'
import { WEB_RESEARCH_TOOL_ID } from '../../shared/web-research'
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
import { AGENTS, claudeCliEffort, claudeCliModel, type AgentEffort } from '../../shared/agents/registry'
import { turnToolEvents } from './tool-events'
import { createDeniedCallWatcher, recordCanUseTool, recordPreToolUse, recordToolEnd, verdict, type ToolVerdict } from './claude-tool-events'
import { withoutBrokerEnv } from '../../shared/broker-env'
import { categorizeTool } from '../../shared/agent-events'
import { AGENT_STOP_MESSAGES } from '../../shared/agent-stop'
import { CLAUDE_SANDBOX_UNAVAILABLE_RE, SANDBOX_MESSAGES, claudeSandboxOptions, parseSandboxViolation, sandboxConcern, sandboxRefusalContext } from '../../shared/agents/sandbox-policy'

type StreamPart = Awaited<ReturnType<ReturnType<typeof claudeCode>['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never

export interface ClaudeConnectionConfig extends AgentHostConfig {
  getPermissionMode: () => PermissionMode
  isClaudeCodeAuthenticated: () => boolean
  getClaudeCodeCliPath: () => string

}


/** Claude Code's own web tools, denied when the app's web research is given. */
export const CLAUDE_BUILTIN_WEB_TOOLS = ['WebFetch', 'WebSearch'] as const

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

// UI model keys → exact CLI model strings, and the xhigh clamp: the agent
// registry (shared/agents/registry.ts) holds every model id.

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
    createChatModel({ workingDirectory, appSessionId, modelId, effort, resumeId: existingCliSessionId, references, companyFiles, review, webResearch, writeGuard, privateReads, askUser, onEvent, steering, onPromptSuggestion, toolEventContext, sandbox, turnEnv, toolStop }) {
      const claudePath = config.getClaudeCodeCliPath()
      const requestedMode = config.getPermissionMode()
      const cliLacksAuto = requestedMode === 'auto' && autoUnsupportedClis.has(claudePath)
      const permissionMode: PermissionMode = cliLacksAuto ? 'default' : requestedMode

      // The mode the CLI actually runs tools in (it reports it on every hook call).
      let observedMode: string | undefined
      // The AI action log for this turn (shared/agent-events.ts); undefined when nobody records.
      const toolEvents = turnToolEvents(config, 'claude-code', { appSessionId, modelId, workingDirectory, toolEventContext, sandbox })
      // 「AI の囲い」 enforce: Claude Code's own sandbox, from the company policy (sandbox-policy.ts).
      const enforced = sandbox?.mode === 'enforce' ? claudeSandboxOptions(sandbox.resolved) : undefined
      // The emergency stop (agent-stop.md), asked live: a stopped kind (or the whole AI) is refused
      // before the tool runs, in every permission mode and for subagents (hooks run there too).
      const stopReason = (toolName: string): string | undefined => {
        const kind = toolStop?.(categorizeTool(toolName))
        if (!kind) return undefined
        console.log(`[hooks] Refused, stopped by an administrator: ${toolName}`)
        return AGENT_STOP_MESSAGES.toolRefused(kind === 'all' ? null : kind)
      }
      const stoppedVerdict = (toolName: string): ToolVerdict<object> | undefined => {
        const reason = stopReason(toolName)
        return reason ? verdict({ continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }, 'stopped') : undefined
      }
      // PreToolUse decision: request UI approval for dangerous patterns (works even in
      // bypassPermissions). Each answer carries the decision it stands for (the action log).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const decidePreToolUse = async (input: any): Promise<ToolVerdict<object>> => {
        if (typeof input.permission_mode === 'string') observedMode = input.permission_mode
        if (input.hook_event_name !== 'PreToolUse') {
          return verdict({ continue: true })
        }
        const stopped = stoppedVerdict(String(input.tool_name))
        if (stopped) return stopped
        // Background subagents outlive the turn, but the SDK closes the hook
        // control channel (CLI stdin) at the first result — their later hook
        // round-trips then fail open, bypassing the dangerous-command gate, and
        // their results never reach the UI. Force every subagent launch to run
        // synchronously instead. (Bash's own run_in_background is unaffected;
        // the tool name is 'Task' on some CLI versions and 'Agent' on others.)
        if (input.tool_name === 'Task' || input.tool_name === 'Agent') {
          return verdict({
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              updatedInput: { ...(input.tool_input ?? {}), run_in_background: false },
            },
          }, 'auto-allowed')
        }
        // Read-only folders (per-folder write rules): refuse before the tool
        // runs, with a reason the model relays to the member instead of
        // retrying. Unknown access never blocks (the server still checks).
        const toolCwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : workingDirectory
        let guarded = decideToolWrite(writeGuard, String(input.tool_name), input.tool_input, toolCwd)
        if (!guarded.deny) guarded = await decideReservedWrite(writeGuard, String(input.tool_name), input.tool_input, toolCwd)
        if (guarded.deny) {
          console.log(`[hooks] Blocked write to read-only folder: ${input.tool_name} ${guarded.path}`)
          return verdict({
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: guarded.message,
            },
          }, 'guard-denied', guarded.code)
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
              return verdict({
                continue: true,
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny',
                  permissionDecisionReason: `${decision.message}ユーザーが許可しなかったため実行していません。別の方法で同じ操作をせず、ユーザーに確認してください。`,
                },
              }, config.requestToolApproval ? 'member-denied' : 'guard-denied', 'private-read')
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
                  // Stopped while the member was deciding.
                  const stoppedMeanwhile = stoppedVerdict(input.tool_name)
                  if (stoppedMeanwhile) return stoppedMeanwhile
                  return verdict({
                    continue: true,
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'allow',
                    },
                  }, 'member-allowed', 'dangerous-command')
                }
              }

              // Auto-deny if no UI approval available or user denied
              console.log(`[hooks] Blocked dangerous command: ${cmd}`)
              return verdict({
                continue: true,
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny',
                  permissionDecisionReason: 'Blocked: dangerous pattern detected',
                },
              }, config.requestToolApproval ? 'member-denied' : 'guard-denied', 'dangerous-command')
            }
          }
        }
        // The member just confirmed this very call: do not ask twice.
        if (confirmedPrivate) {
          const stoppedMeanwhile = stoppedVerdict(String(input.tool_name))
          if (stoppedMeanwhile) return stoppedMeanwhile
          return verdict({ continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: input.tool_input ?? {} } }, 'member-allowed', 'private-read')
        }
        // No decision: leave it to the permission mode. Returning 'allow' here
        // skipped both the auto-mode classifier and the 'default' approval
        // prompt for every tool.
        return verdict({ continue: true }, 'policy-default')
      }
      // The one place the PreToolUse decision is recorded.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preToolUseHook = async (input: any) => {
        const decided = await decidePreToolUse(input)
        recordPreToolUse(toolEvents, input, decided)
        return decided.result
      }
      // PostToolUse: what a Grep / shell command printed can be private content.
      // With the action log, also how each call ended (PostToolUseFailure;
      // PermissionDenied = the permission mode refused, when the CLI says so).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const postToolUseHook = async (input: any) => {
        if (privateReads && input.hook_event_name === 'PostToolUse') {
          noteToolResult(privateReads.context, privateReads.state, String(input.tool_name), input.tool_response)
        }
        recordToolEnd(toolEvents, input)
        // A command the sandbox refused: the AI relays the company's sentence instead of retrying.
        if (enforced && sandbox && input.hook_event_name === 'PostToolUseFailure') {
          const read = sandboxConcern(sandbox.resolved, String(input.tool_name), input.tool_input, sandbox.home) === 'read'
          const context = sandboxRefusalContext(parseSandboxViolation(input.error), read)
          if (context) return { continue: true, hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: context } }
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
      const decideCanUseTool = async (toolName: string, toolInput: Record<string, unknown>, options: any): Promise<ToolVerdict<object>> => {
        const stopped = stopReason(toolName)
        if (stopped) return verdict({ behavior: 'deny' as const, message: stopped }, 'stopped')
        if (toolName === CLAUDE_CHOICE_TOOL) {
          const answer = await answerAskUserQuestion(askUser, toolInput, options?.toolUseID, options?.signal)
          return verdict(answer, answer.behavior === 'allow' ? 'member-allowed' : 'member-denied')
        }
        if (!approvals) return verdict({ behavior: 'deny' as const, message: 'この操作は確認が必要なため実行していません。' }, 'guard-denied', 'needs-approval')
        // Read-only tools: auto-allow. Every allow echoes updatedInput: older CLIs
        // (e.g. 2.0.x, the ones that also lack auto) reject an allow without it.
        // Web research changes nothing in the company; after private reads the
        // PreToolUse hook has already asked the member (private-read-guard.ts).
        const readOnlyTools = ['Read', 'ListDirectory', 'Glob', 'Grep', 'View']
        if (readOnlyTools.includes(toolName) || (references && Object.keys(referenceSchemas).some(name => toolName === `mcp__acb_consultations__${name}`)) || (companyFiles && COMPANY_FILE_TOOL_NAMES.some(name => toolName === companyFileToolId(name))) || (review && toolName === REVIEW_TOOL_ID) || (webResearch && toolName === WEB_RESEARCH_TOOL_ID)) {
          return verdict({ behavior: 'allow' as const, updatedInput: toolInput }, 'auto-allowed')
        }
        // Request approval from UI
        const result = await config.requestToolApproval!(
          toolName,
          toolInput,
          options.toolUseID || crypto.randomUUID(),
          appSessionId,
        )
        if (result.approved) {
          const stoppedMeanwhile = stopReason(toolName)
          if (stoppedMeanwhile) return verdict({ behavior: 'deny' as const, message: stoppedMeanwhile }, 'stopped')
          return verdict({ behavior: 'allow' as const, updatedInput: toolInput }, 'member-allowed')
        }
        return verdict({
          behavior: 'deny' as const,
          message: 'ユーザーにより拒否されました',
        }, 'member-denied')
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const canUseToolFn: any = approvals || askUser
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? async (toolName: string, toolInput: Record<string, unknown>, options: any) => {
            const decided = await decideCanUseTool(toolName, toolInput, options)
            recordCanUseTool(toolEvents, toolName, toolInput, options?.toolUseID, decided)
            return decided.result
          }
        : undefined

      if (existingCliSessionId) {
        console.log(`[chat-server] Resuming Claude CLI session: ${existingCliSessionId} (app session: ${appSessionId})`)
      }

      const resolvedModel = claudeCliModel(modelId)
      const resolvedEffort = claudeCliEffort(resolvedModel, effort as AgentEffort | undefined)

      const createNative = (mode: PermissionMode, sandboxed = !!enforced) => {
        // One MCP server instance per query: a fallback re-run must not reuse the first one.
        const referenceServer = references ? createSdkMcpServer({ name: 'acb_consultations', tools: (Object.keys(referenceSchemas) as ReferenceToolName[]).map(name => tool(name, referenceDescriptions[name], referenceSchemas[name].shape, async args => ({ content: [{ type: 'text' as const, text: await references.execute(name, args) }] }))) }) : undefined
        // App-provided (not the company repository's .mcp.json, which is protected config).
        const companyFilesServer = companyFiles ? createSdkMcpServer({ name: COMPANY_FILES_SERVER, tools: COMPANY_FILE_TOOL_NAMES.map(name => tool(name, companyFileDescriptions[name], companyFileSchemas[name].shape, async args => ({ content: [{ type: 'text' as const, text: await companyFiles.execute(name, args) }] }), { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } })) }) : undefined
        const reviewServer = review ? createSdkMcpServer({ name: REVIEW_SERVER, tools: [tool(REVIEW_TOOL, reviewDescription, reviewSchema.shape, async args => ({ content: [{ type: 'text' as const, text: await review.execute(args) }] }), { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } })] }) : undefined
        // 「Web で調べる」: a separate reader reads the web (web-research/tools.ts).
        const webResearchServer = webResearch ? createSdkMcpServer({ name: WEB_RESEARCH_SERVER, tools: [tool(WEB_RESEARCH_TOOL, webResearchDescription, webResearchSchema.shape, async args => ({ content: [{ type: 'text' as const, text: await webResearch.execute(args) }] }), { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } })] }) : undefined
        const mcpServers = {
          ...(referenceServer ? { acb_consultations: referenceServer } : {}),
          ...(companyFilesServer ? { [COMPANY_FILES_SERVER]: companyFilesServer } : {}),
          ...(reviewServer ? { [REVIEW_SERVER]: reviewServer } : {}),
          ...(webResearchServer ? { [WEB_RESEARCH_SERVER]: webResearchServer } : {}),
        }
        const allowedTools = [
          ...(referenceServer ? Object.keys(referenceSchemas).map(name => `mcp__acb_consultations__${name}`) : []),
          ...(companyFilesServer ? COMPANY_FILE_TOOL_NAMES.map(companyFileToolId) : []),
          ...(reviewServer ? [REVIEW_TOOL_ID] : []),
          ...(webResearchServer ? [WEB_RESEARCH_TOOL_ID] : []),
        ]
        const state = { missingSession: false, autoRejected: false, sandboxUnavailable: false }
        // Steering + prompt suggestions (steering.ts): watch the query the
        // provider runs. A suggestion arrives after the turn's result, once
        // the UI stream has already closed, so it goes out through
        // onPromptSuggestion (the chat server hands it to the renderer).
        const onQueryCreated = steering || onPromptSuggestion ? (query: object) => {
          const steer = steering ? createClaudeSteer(query as Parameters<typeof createClaudeSteer>[0]) : undefined
          if (steer) steering!.attach(steer.target)
          let answered = false
          tapQuery(query, message => {
            steer?.observe(message)
            if ((message as { type?: string }).type === 'result') answered = true
          }, () => {
            if (steer) { steer.close(); steering!.detach(steer.target) }
            // No suggestion came (suppressed, or the drain timed out). A query
            // that never answered (e.g. the auto-mode re-run) says nothing.
            if (answered) onPromptSuggestion?.(null)
          })
        } : undefined
        const model = createModel(resolvedModel, {
          pathToClaudeCodeExecutable: claudePath,
          permissionMode: mode,
          cwd: workingDirectory,
          // CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: without it the CLI stops
          // suggesting once the plan is near its usage limit
          // (status `allowed_warning`), which heavy members hit most days.
          // The key broker's variables for this consultation (turnEnv) replace any of the same names.
          env: {
            ...withoutBrokerEnv(config.getShellEnv()),
            ...turnEnv,
            ...(onPromptSuggestion ? { CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'true' } : {}),
          },
          settingSources: ['user', 'project'],
          // With the app's web research, the CLI's own web tools are off for the
          // whole session, subagents included (a deny beats any allow, in every
          // permission mode; WebFetch / WebSearch also bypass the sandbox's
          // network allowlist, so this is the only reliable switch). Not
          // `disallowedTools`: the provider ignores it whenever allowedTools is set.
          // Under the company sandbox the same flag settings also deny reading its secret places
          // (the sandbox covers only Bash; the Read tool needs these rules).
          ...(webResearch || sandboxed ? { settings: { permissions: { deny: [...new Set([...(webResearch ? CLAUDE_BUILTIN_WEB_TOOLS : []), ...(sandboxed && enforced ? enforced.permissionsDeny : [])])] } } } : {}),
          // The company sandbox (agent-sandbox.md): --settings layer, so the company
          // repository's .claude/settings.json cannot loosen it (strictAllowlist,
          // allowUnsandboxedCommands: false). failIfUnavailable: a CLI that cannot
          // start it stops, and the app follows the company's onUnavailable.
          ...(sandboxed && enforced ? { sandbox: enforced.sandbox } : {}),
          streamingInput: 'always',
          // One-line progress for running subagents (task_progress.summary),
          // shown in the subagent row; see shared/agent-progress.ts.
          ...(onEvent ? { agentProgressSummaries: true } : {}),
          // Both observers watch the same Query: usage/progress events, and
          // steering + prompt suggestions (each wraps the iterator the provider reads);
          // the action log closes this query's open calls when it ends.
          ...(onEvent || onQueryCreated || toolEvents ? {
            onQueryCreated: (query: unknown) => {
              if (onEvent) tapSdkMessages(query, message => {
                const event = claudeAgentEvent(message)
                if (event) onEvent(event)
              })
              onQueryCreated?.(query as object)
              // Refusals by permission rules run no hook: read them from the messages.
              if (toolEvents) tapQuery(query as object, createDeniedCallWatcher(toolEvents), () => toolEvents.close())
            },
          } : {}),
          // Off unless the renderer can show it; the member's own
          // `promptSuggestionEnabled: false` (user settings) still wins in the CLI.
          ...(onPromptSuggestion ? { promptSuggestions: true, onPromptSuggestion: (suggestion: string) => onPromptSuggestion(suggestion) } : {}),
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
            if (existingCliSessionId || mode === 'auto' || sandboxed) child.stderr?.on('data', (chunk: Buffer) => {
              pending += chunk.toString()
              const lines = pending.split('\n'); pending = lines.pop()!.slice(-512)
              if (existingCliSessionId && lines.some(line => line.trim() === `No conversation found with session ID: ${existingCliSessionId}`)) state.missingSession = true
              if (mode === 'auto' && lines.some(line => AUTO_REJECTED.test(line))) state.autoRejected = true
              if (sandboxed && lines.some(line => CLAUDE_SANDBOX_UNAVAILABLE_RE.test(line))) state.sandboxUnavailable = true
            })
            return child
          },
          hooks: {
            PreToolUse: [{ hooks: [preToolUseHook] }],
            ...(privateReads || toolEvents ? { PostToolUse: [{ hooks: [postToolUseHook] }] } : {}),
            ...(toolEvents || sandboxed ? { PostToolUseFailure: [{ hooks: [postToolUseHook] }] } : {}),
            ...(toolEvents ? { PermissionDenied: [{ hooks: [postToolUseHook] }] } : {}),
          },
          ...(canUseToolFn ? { canUseTool: canUseToolFn } : {}),
        })
        return { model, state }
      }

      const primary = createNative(permissionMode)
      if (!existingCliSessionId && requestedMode !== 'auto' && !enforced) return primary.model
      // The fallback notice is shown once per conversation, as soon as it applies,
      // outside any open text block.
      const takeNotice = (text: string | undefined) => {
        if (!text || (appSessionId && notifiedConversations.has(appSessionId))) return undefined
        if (appSessionId) notifiedConversations.add(appSessionId)
        return text
      }
      const relay = (stream: ReadableStream<StreamPart>, state: typeof primary.state, pendingNotice: () => string | undefined, oncePerConversation = true) => {
        let shown = false
        const openText = new Set<string>()
        return stream.pipeThrough(new TransformStream<StreamPart, StreamPart>({
          transform(part, controller) {
            if (!shown && openText.size === 0 && part.type !== 'stream-start' && part.type !== 'response-metadata' && part.type !== 'error') {
              const pending = pendingNotice()
              if (pending) {
                shown = true
                const text = oncePerConversation ? takeNotice(pending) : pending
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
      // The company sandbox did not start (failIfUnavailable): the company's
      // onUnavailable decides — stop with a plain sentence, or run this turn without it.
      const sandboxStartFailed = (error: unknown) => primary.state.sandboxUnavailable || CLAUDE_SANDBOX_UNAVAILABLE_RE.test(error instanceof Error ? error.message : String(error ?? ''))
      const sandboxFallback = async (params: Parameters<ReturnType<typeof claudeCode>['doStream']>[0]) => {
        console.warn('[agent-sandbox] Claude Code could not start the sandbox; following the company setting:', sandbox?.onUnavailable)
        if (sandbox?.onUnavailable !== 'record-only') {
          return { stream: new ReadableStream<StreamPart>({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'error', error: new Error(SANDBOX_MESSAGES.startFailedStop) }); c.close() } }) }
        }
        const retry = createNative(cliLacksAuto ? 'default' : permissionMode, false)
        const result = await retry.model.doStream(params)
        return { ...result, stream: relay(result.stream, retry.state, () => SANDBOX_MESSAGES.startFailedRecordOnly, false) }
      }
      return wrapLanguageModel({ model: primary.model, middleware: {
        specificationVersion: 'v3',
        wrapStream: async ({ doStream, params }) => {
          if ((requestedMode !== 'auto' || cliLacksAuto) && !enforced) {
            const result = await doStream()
            return { ...result, stream: relay(result.stream, primary.state, cliLacksAuto ? cliNotice : () => undefined) }
          }
          const peeksAuto = requestedMode === 'auto' && !cliLacksAuto
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
            if (peeksAuto && primary.state.autoRejected) return fallback()
            if (enforced && sandboxStartFailed(error)) return sandboxFallback(params)
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
          const last = head.at(-1)
          if (last?.type === 'error' && peeksAuto && primary.state.autoRejected) {
            await reader.cancel().catch(() => {})
            return fallback()
          }
          if (last?.type === 'error' && enforced && sandboxStartFailed(last.error)) {
            await reader.cancel().catch(() => {})
            return sandboxFallback(params)
          }
          const replay = new ReadableStream<StreamPart>({
            start(controller) { for (const part of head) controller.enqueue(part) },
            async pull(controller) {
              const next = await reader.read()
              if (next.done) controller.close(); else controller.enqueue(next.value)
            },
            cancel(reason) { return reader.cancel(reason) },
          })
          return { ...result, stream: relay(replay, primary.state, peeksAuto ? accountNotice : cliLacksAuto ? cliNotice : () => undefined) }
        },
      } })
    },
    createTitleModel() {
      return createModel(AGENTS['claude-code'].tasks.title!, {
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
