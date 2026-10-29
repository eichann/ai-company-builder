/**
 * How each agent in the registry (shared/agents/registry.ts) is started in
 * the main process: its chat connection, its one-shot text jobs (sync's
 * commit message, voice formatting) and its hand-off memo writer.
 *
 * Callers never branch on an agent id: they look the agent up here and in the
 * descriptor's `capabilities`. A factory a capability claims must exist (and
 * one that is absent must not be claimed) — `tests/agent-registry-factories.test.ts`.
 */

import { generateText } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { AGENTS, type AgentCapabilities, type AgentId, type AgentTaskModels } from '../../shared/agents/registry'
import type { AgentConnection } from './connection'
import { createClaudeConnection, type ClaudeConnectionConfig } from './claude'
import { createCodexConnection } from './codex'
import { createApiConnection } from './anthropic-api'
import { generateCodexText, type CodexTextRequest } from './codex-text'
import { runClaudeOneShot, type ClaudeOneShotMessages } from '../claude-oneshot'
import { writeClaudeHandoff } from '../handoff/claude'
import { writeCodexHandoff } from '../handoff/codex'
import type { HandoffMetrics, HandoffRequest } from '../handoff/contract'
import { runClaudeWebReader } from './claude-web-reader'
import { runCodexWebReader } from './codex-web-reader'
import { WEB_READER_TIMEOUT_MS, inEmptyFolder, type WebReaderJob, type WebReaderRequest, type WebReaderResult } from './web-reader'

/** What any connection may need from the app (the chat server's config is one). */
export interface AgentHost extends ClaudeConnectionConfig {
  getApiKey: () => string | undefined
}

/**
 * A role-specific configuration a caller may ask for on a chat connection.
 * The shape is fixed so callers ask for a role without branching on the
 * agent; no agent implements one, so `createAgentConnection` refuses any
 * profile that sets a field (a caller must never believe a restriction is in
 * force when it is not). The Web reader is not a profile: it is a one-shot
 * job with its restrictions built in (`runWebReader`, web-reader.ts).
 */
export interface AgentProfile {
  /** A name for logs and for the agent's own choices ('reader', 'worker', …). */
  readonly role?: string
  /** Only these tools (agent-native names); undefined = the agent's normal set. */
  readonly allowedTools?: readonly string[]
  /** Settings layers the agent may load; [] = none. */
  readonly settingSources?: readonly ('user' | 'project' | 'local')[]
  /** Sandbox overrides (network / filesystem). */
  readonly sandbox?: { readonly network?: 'none' | 'allowlist'; readonly allowedHosts?: readonly string[]; readonly writableRoots?: readonly string[] }
  /** Working directory for the agent process instead of the request's. */
  readonly cwd?: string
}

/** Where a one-shot job runs and with which credentials, read when the job starts. */
export interface OneShotHost {
  /** Read lazily: an agent that is not the CLI never asks for it. */
  getCli: () => string
  /** A neutral working directory (never the company folder). */
  cwd: string
  env: Record<string, string>
  apiKey?: string
  /**
   * Claude Code installed and signed in. Passed by callers that pick among
   * agents (commit messages); without it the CLI is simply tried.
   */
  claudeReady?: () => boolean
}

/** A short, isolated text job: no tools, no session, the input as JSON data. */
export interface OneShotTextRequest {
  /** Picks the agent's task model (descriptor `tasks`) unless `model` is set. */
  job: Extract<keyof AgentTaskModels, 'commitMessage' | 'voice'>
  model?: string
  system: string
  /** Data for the model, sent as JSON — never an instruction slot. */
  input: unknown
  signal: AbortSignal
  host: OneShotHost
  /** The CLI's own time limit (callers also abort through `signal`). */
  timeoutMs: number
  maxOutputTokens: number
  /** Wording of the CLI's failures (shown to the member for voice, logged for commit messages). */
  cliMessages: ClaudeOneShotMessages
  /** Agents with tools of their own are told to do only this job (Codex developer instructions). */
  instructions?: string
  /** Set → an answer cut off at `maxOutputTokens` is this error instead of text. */
  truncatedMessage?: string
  onMetrics?: CodexTextRequest['onMetrics']
}

export interface AgentFactories {
  /** The chat connection (every agent). */
  createConnection(host: AgentHost): AgentConnection
  /** `capabilities.oneShotText`. */
  oneShotText?: (request: OneShotTextRequest) => Promise<string>
  /** Why a one-shot cannot run with these credentials (checked before trying), or undefined. */
  oneShotUnavailable?: (host: OneShotHost) => string | undefined
  /** `capabilities.handoff`. */
  writeHandoff?: (request: HandoffRequest, host: { getCli: () => string }) => Promise<HandoffMetrics>
  /** `capabilities.webReader`: the restricted reader (web-reader.ts), in the folder and with the model it is given. */
  runWebReader?: (job: WebReaderJob) => Promise<WebReaderResult>
}

const model = (id: AgentId, request: OneShotTextRequest) => request.model ?? AGENTS[id].tasks[request.job]

export const AGENT_FACTORIES: { readonly [K in AgentId]: AgentFactories } = {
  'claude-code': {
    createConnection: host => createClaudeConnection(host),
    oneShotText: request => runClaudeOneShot({
      cli: request.host.getCli(), cwd: request.host.cwd, model: model('claude-code', request)!,
      systemPrompt: request.system, input: request.input, signal: request.signal, env: request.host.env,
      timeoutMs: request.timeoutMs, messages: request.cliMessages,
    }),
    oneShotUnavailable: host => {
      if (!host.claudeReady) return undefined
      let ready = false
      try { ready = host.claudeReady() } catch { /* treated as not ready */ }
      return ready ? undefined : 'Claude Code CLIが認証されていません。'
    },
    writeHandoff: (request, host) => writeClaudeHandoff({ ...request, cli: host.getCli() }),
    runWebReader: job => runClaudeWebReader(job),
  },
  codex: {
    createConnection: host => createCodexConnection(host),
    // The light model when the account has it, else the catalog's default (selectVoiceModel).
    oneShotText: request => generateCodexText({
      env: request.host.env, cwd: request.host.cwd, system: request.system, text: JSON.stringify(request.input),
      signal: request.signal, ...(request.model ? { modelId: request.model } : {}),
      ...(request.instructions ? { developerInstructions: request.instructions } : {}),
      ...(request.onMetrics ? { onMetrics: request.onMetrics } : {}),
    }),
    writeHandoff: request => writeCodexHandoff(request),
    runWebReader: job => runCodexWebReader(job),
  },
  'api-key': {
    createConnection: host => createApiConnection(host),
    oneShotText: async request => {
      const apiKey = request.host.apiKey
      if (!apiKey) throw new Error('APIキーが設定されていません。設定からAPIキーを登録してください')
      const result = await generateText({
        model: createAnthropic({ apiKey })(model('api-key', request)!),
        system: request.system, prompt: JSON.stringify(request.input),
        abortSignal: request.signal, maxRetries: 0, maxOutputTokens: request.maxOutputTokens,
      })
      if (request.truncatedMessage && result.finishReason === 'length') throw new Error(request.truncatedMessage)
      return result.text
    },
    oneShotUnavailable: host => host.apiKey ? undefined : 'APIキーが設定されていません。設定からAPIキーを登録してください',
  },
}

/** Capabilities that need a factory, and which one. */
export const CAPABILITY_FACTORIES = {
  oneShotText: 'oneShotText',
  handoff: 'writeHandoff',
  webReader: 'runWebReader',
} as const satisfies Partial<Record<keyof AgentCapabilities, keyof AgentFactories>>

function assertProfileSupported(id: AgentId, profile: AgentProfile | undefined) {
  if (!profile) return
  const set = Object.entries(profile).filter(([, value]) => value !== undefined).map(([key]) => key)
  if (set.length) throw new Error(`${AGENTS[id].label}: role profiles are not supported yet (${set.join(', ')})`)
}

/** The chat connection for an agent; a role profile is refused until agents implement roles. */
export function createAgentConnection(id: AgentId, host: AgentHost, profile?: AgentProfile): AgentConnection {
  assertProfileSupported(id, profile)
  return AGENT_FACTORIES[id].createConnection(host)
}

/** Run a one-shot job with an agent that claims `oneShotText`. */
export function runOneShotText(id: AgentId, request: OneShotTextRequest): Promise<string> {
  const run = AGENTS[id].capabilities.oneShotText ? AGENT_FACTORIES[id].oneShotText : undefined
  if (!run) return Promise.reject(new Error(`${AGENTS[id].label}: no one-shot text`))
  return run(request)
}

/** Why the agent cannot run a one-shot job with these credentials, or undefined. */
export function oneShotUnavailable(id: AgentId, host: OneShotHost): string | undefined {
  if (!AGENTS[id].capabilities.oneShotText) return `${AGENTS[id].label}: no one-shot text`
  return AGENT_FACTORIES[id].oneShotUnavailable?.(host)
}

/** Write a hand-off memo with an agent that claims `handoff`. */
export function writeAgentHandoff(id: AgentId, request: HandoffRequest, host: { getCli: () => string }): Promise<HandoffMetrics> {
  const write = AGENTS[id].capabilities.handoff ? AGENT_FACTORIES[id].writeHandoff : undefined
  if (!write) return Promise.reject(new Error(`${AGENTS[id].label}: no hand-off memos`))
  return write(request, host)
}

/**
 * Ask the Web reader of an agent that claims `webReader` (the member's own
 * agent, its `tasks.webReader` model), in a new empty folder removed
 * afterwards. Rejects with a `WebReaderError` (web-reader.ts).
 */
export function runWebReader(id: AgentId, request: WebReaderRequest): Promise<WebReaderResult> {
  const run = AGENTS[id].capabilities.webReader ? AGENT_FACTORIES[id].runWebReader : undefined
  const model = AGENTS[id].tasks.webReader
  if (!run || !model) return Promise.reject(new Error(`${AGENTS[id].label}: no Web reader`))
  return inEmptyFolder(cwd => run({ ...request, model, cwd, timeoutMs: request.timeoutMs ?? WEB_READER_TIMEOUT_MS }))
}
