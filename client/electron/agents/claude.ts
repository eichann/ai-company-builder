import { claudeCode } from 'ai-sdk-provider-claude-code'
import crypto from 'crypto'
import fs from 'fs'
import { spawn as nodeSpawn } from 'child_process'
import type { AgentConnection } from './connection'

export interface ClaudeConnectionConfig {
  getPermissionMode: () => 'bypassPermissions' | 'default'
  isClaudeCodeAuthenticated: () => boolean
  getClaudeCodeCliPath: () => string
  getShellEnv: () => Record<string, string>
  requestToolApproval?: (
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string,
    appSessionId?: string,
  ) => Promise<{ approved: boolean }>
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

// Windows spawn for the Claude CLI. Windows has no posix_spawn EBADF problem
// and no /bin/sh or /dev/fd, so the macOS FD-closing shell wrapper does not
// apply — we spawn directly. A native claude.exe spawns directly (and handles
// install paths containing spaces); a claude.cmd/.bat must go through cmd.exe.
function spawnClaudeOnWindows(opts: { command: string; args: string[]; cwd?: string; env?: Record<string, string | undefined>; signal?: AbortSignal }) {
  const isBatch = /\.(cmd|bat)$/i.test(opts.command)
  let file = opts.command
  let args = opts.args
  const extra: Record<string, unknown> = {}
  if (isBatch) {
    // Quote the command and any args with spaces, then run verbatim through
    // cmd.exe so paths like C:\Users\My Name\...\claude.cmd work.
    file = process.env.ComSpec || 'cmd.exe'
    const quoted = [opts.command, ...opts.args]
      .map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a))
      .join(' ')
    args = ['/d', '/s', '/c', quoted]
    extra.windowsVerbatimArguments = true
  }
  console.log('[chat-server] spawning claude (win32):', opts.command, opts.args?.slice(0, 3))
  const child = nodeSpawn(file, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: opts.signal,
    windowsHide: true,
    ...extra,
  })
  child.on('error', (err) => console.error('[chat-server] child process error:', err))
  child.stderr?.on('data', (data: Buffer) => console.error('[chat-server] claude stderr:', data.toString()))
  return child
}

// Spawn helper for Claude Code CLI that works around Electron's FD inheritance issues (EBADF on posix_spawn).
// Repair standard FDs, force fork+exec, and close inherited Chromium FDs before exec.
function spawnClaudeCodeProcess(opts: { command: string; args: string[]; cwd?: string; env?: Record<string, string | undefined>; signal?: AbortSignal }) {
  if (process.platform === 'win32') return spawnClaudeOnWindows(opts)
  for (const fd of [0, 1, 2]) {
    try { fs.fstatSync(fd) }
    catch {
      console.warn(`[chat-server] FD ${fd} invalid, reopening as /dev/null`)
      fs.openSync('/dev/null', fd === 0 ? 'r' : 'w')
    }
  }
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
    ...(process.getuid ? { uid: process.getuid() } : {}),
  })
  child.on('error', (err) => console.error('[chat-server] child process error:', err))
  child.stderr?.on('data', (data: Buffer) => console.error('[chat-server] claude stderr:', data.toString()))
  return child
}


export function createClaudeConnection(config: ClaudeConnectionConfig, createModel = claudeCode): AgentConnection {
  return {
    id: 'claude-code',
    ownsConversation: true,
    authenticationError: () => config.isClaudeCodeAuthenticated() ? undefined : 'Claude Code CLIが認証されていません。',
    createChatModel({ workingDirectory, appSessionId, modelId, effort, resumeId: existingCliSessionId }) {
      const claudePath = config.getClaudeCodeCliPath()
      const permissionMode = config.getPermissionMode()

      // PreToolUse hook: request UI approval for dangerous patterns (works even in bypassPermissions)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preToolUseHook = async (input: any) => {
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

      const resolvedModel = resolveClaudeModel(modelId)
      const resolvedEffort = resolveEffort(resolvedModel, effort)

      return createModel(resolvedModel, {
        pathToClaudeCodeExecutable: claudePath,
        permissionMode,
        cwd: workingDirectory,
        env: config.getShellEnv(),
        settingSources: ['user', 'project'],
        streamingInput: 'always',
        ...(existingCliSessionId ? { resume: existingCliSessionId } : {}),
        // Agent SDK 0.2.47 declares effort as 4 values, but Claude Code CLI v2.1.111+
        // accepts `xhigh` (Opus 4.7+). The SDK passes the string straight to the
        // CLI via `--effort`, so we cast to bypass the stale SDK type.
        ...(resolvedEffort ? { sdkOptions: { effort: resolvedEffort as 'low' | 'medium' | 'high' | 'max' } } : {}),
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
        spawnClaudeCodeProcess,
        hooks: {
          PreToolUse: [{ hooks: [preToolUseHook] }],
        },
        ...(canUseToolFn ? { canUseTool: canUseToolFn } : {}),
      })
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
      const value = metadata?.['claude-code'] as {
        sessionId?: string
        modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; contextWindow?: number }>
      } | undefined
      let contextUsage: { inputTokens: number; outputTokens: number; contextWindow?: number } | undefined
      if (value?.modelUsage) {
        contextUsage = { inputTokens: 0, outputTokens: 0 }
        for (const usage of Object.values(value.modelUsage)) {
          contextUsage.inputTokens += usage.inputTokens ?? 0
          contextUsage.outputTokens += usage.outputTokens ?? 0
          if (usage.contextWindow && usage.contextWindow > 0) contextUsage.contextWindow = usage.contextWindow
        }
      }
      return { sessionId: value?.sessionId, contextUsage }
    },
  }
}
