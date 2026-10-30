/**
 * The AI backends the app can run (pure: no Electron, React or SDK imports,
 * so the main process, the renderer and tests all read the same table).
 *
 * One entry per agent: what it is called, which models it offers, which
 * per-feature models the app picks for it (titles, commit messages, voice,
 * hand-off memos), and what it can do (`capabilities`). Every model id the
 * app sends anywhere lives in this file — `tests/agent-registry.test.ts`
 * fails on a model id literal anywhere else under client/electron, src or
 * shared.
 *
 * How each agent is started (connections, one-shot text, hand-off writers)
 * lives next to the connections, in `electron/agents/registry.ts`; that
 * module must provide every factory a capability here claims (also tested).
 */

import type { AuthMode } from '../agent'

/** The member's sign-in choice (`config.authMode`, shared/agent.ts `AuthMode`), and the registry key. */
export type AgentId = AuthMode

/** Display and preference order (settings cards, commit-message fallbacks). `AGENTS` below must have each. */
export const AGENT_IDS: readonly AgentId[] = ['claude-code', 'codex', 'api-key']

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value)
}

/** Claude Code effort levels; which ones a model accepts is per model. */
export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const AGENT_EFFORTS: readonly AgentEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export interface AgentModel<Id extends string = string> {
  /** The key the app stores and sends (localStorage `aiModel`, request `modelId`). */
  readonly id: Id
  readonly label: string
  /** Effort levels the selector offers for this model. */
  readonly efforts: readonly AgentEffort[]
  /** `1m`: one-million-token context (requested, or native). */
  readonly context: '1m' | 'standard'
  /** The exact string handed to the CLI's `--model`. */
  readonly cliModel: string
}

export interface AgentCapabilities {
  /**
   * A native agent (CLI) that owns its system prompt, tools and session: the
   * app supplies workspace context only and resumes the agent's own session.
   * Without it the app runs the loop (system prompt, file tools, pruning).
   */
  readonly ownsConversation: boolean
  /** Extra instructions reach the running turn (steering.ts). */
  readonly steering: boolean
  /** Next-prompt suggestions after a turn (prompt-suggestion.ts). */
  readonly promptSuggestions: boolean
  /** The AI can ask a choice prompt (choice-prompt.ts). */
  readonly choicePrompts: boolean
  /** Running subagent rows get progress lines (agent-progress.ts). */
  readonly subagentProgress: boolean
  /** Plan usage for the header meter (rate-limits.ts). */
  readonly rateLimits: boolean
  /** Images attached to a message reach the model. */
  readonly imageInput: boolean
  /** Read-only company files over MCP (company-files/tools.ts). */
  readonly companyFilesMcp: boolean
  /** Consultation reference tools (consultations/tools.ts). */
  readonly references: boolean
  /** Writes into read-only / not-downloaded folders are refused up front (write-guard.ts). */
  readonly writeGuard: boolean
  /** Private content → public places asks the member first (private-read-guard.ts). */
  readonly privateReadGuard: boolean
  /** Hand-off memos for session recovery (handoff/). */
  readonly handoff: boolean
  /** Short isolated text jobs: commit messages, voice formatting. */
  readonly oneShotText: boolean
  /**
   * A separate Web reader (web-research.ts): the agent's own CLI with only its
   * web tools, no settings, in an empty folder. The chat then gets the app's
   * `web_research` tool and loses its built-in web tools.
   */
  readonly webReader: boolean
  /**
   * The app can hand the company's AI sandbox (「AI の囲い」, sandbox-policy.ts)
   * to this agent's own sandbox (mode `enforce`). Without it, `enforce` runs as
   * the company's `onUnavailable` says (record only, or no AI).
   */
  readonly sandbox: boolean
  /**
   * Used when the member's own agent cannot write the commit message (or is
   * not signed in). A CLI that may belong to another vendor is never picked
   * on the member's behalf.
   */
  readonly commitMessageFallback: boolean
  /**
   * May write a private folder's commit message (its file names go to this
   * agent). Only the API key, exactly as before private folders had AI messages.
   */
  readonly privateFolderCommitMessages: boolean
  /** The model list comes from the agent at run time (e.g. `model/list`), not from `models`. */
  readonly liveModelCatalog: boolean
}

/** Which model the app uses for each job. `undefined` = the agent's own choice (documented per entry). */
export interface AgentTaskModels {
  /** Chat when the member chose nothing (or the agent has no model choice). */
  readonly chat?: string
  /** Conversation titles. */
  readonly title?: string
  /** Sync's commit message. */
  readonly commitMessage?: string
  /** Voice formatting. */
  readonly voice?: string
  /** Hand-off memos. */
  readonly handoff?: string
  /** The Web reader (`capabilities.webReader`); absent → the agent's catalog default (Codex). */
  readonly webReader?: string
}

export interface AgentDescriptor<ModelId extends string = string> {
  readonly id: AgentId
  /** Short name (chat header, cards, meters): 'Claude', 'Codex', 'API'. */
  readonly shortLabel: string
  /** Full name in settings. */
  readonly label: string
  /** Static model list in selector order (empty when `liveModelCatalog`). */
  readonly models: readonly AgentModel<ModelId>[]
  /** For a member with no saved choice (owner's decision, 2026-10-23). */
  readonly defaultModel?: ModelId
  readonly defaultEffort?: AgentEffort
  readonly tasks: AgentTaskModels
  readonly capabilities: AgentCapabilities
  /**
   * The oldest CLI the app starts (`<cli> --version`, cli-version.ts): older
   * ones lack what the app relies on (for Codex: permission profiles and the
   * network proxy the sandbox uses). Undefined = no check.
   */
  readonly minCliVersion?: string
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

// Opus is split into explicit 4.6 / 4.8 / 5 / 5.5 choices that request the
// 1M-context variant ([1m]); Fable 5 has a native 1M context window, so it
// takes no suffix; sonnet/haiku remain CLI aliases. `xhigh` is only accepted
// on Opus 4.7+ (incl. 4.8), Opus 5, Opus 5.5 and Fable 5.
const CLAUDE_MODELS = [
  { id: 'fable-5', label: 'Fable 5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], context: '1m', cliModel: 'claude-fable-5' },
  { id: 'opus-5-5', label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], context: '1m', cliModel: 'claude-opus-5-5[1m]' },
  { id: 'opus-5', label: 'Opus 5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], context: '1m', cliModel: 'claude-opus-5[1m]' },
  { id: 'opus-4-8', label: 'Opus 4.8', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], context: '1m', cliModel: 'claude-opus-4-8[1m]' },
  { id: 'opus-4-6', label: 'Opus 4.6', efforts: ['low', 'medium', 'high', 'max'], context: '1m', cliModel: 'claude-opus-4-6[1m]' },
  { id: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high', 'max'], context: 'standard', cliModel: 'sonnet' },
  { id: 'haiku', label: 'Haiku', efforts: ['low', 'medium', 'high'], context: 'standard', cliModel: 'haiku' },
] as const satisfies readonly AgentModel[]

export type ClaudeModelId = typeof CLAUDE_MODELS[number]['id']

/** The CLI alias for the small fast model (titles, `claude -p` one-shots, hand-off memos). */
const CLAUDE_LIGHT_MODEL = 'haiku'
/** The chat default; also the Web reader's (owner decision 2026-10-29: a light reader did not dig). */
const CLAUDE_CHAT_MODEL = 'claude-opus-5-5[1m]'

const CLAUDE_CODE: AgentDescriptor<ClaudeModelId> = {
  id: 'claude-code',
  shortLabel: 'Claude',
  label: 'Claude Code',
  models: CLAUDE_MODELS,
  defaultModel: 'opus-5-5',
  defaultEffort: 'medium',
  tasks: {
    chat: CLAUDE_CHAT_MODEL,
    title: CLAUDE_LIGHT_MODEL,
    commitMessage: CLAUDE_LIGHT_MODEL,
    voice: CLAUDE_LIGHT_MODEL,
    handoff: CLAUDE_LIGHT_MODEL,
    webReader: CLAUDE_CHAT_MODEL,
  },
  capabilities: {
    ownsConversation: true,
    steering: true,
    promptSuggestions: true,
    choicePrompts: true,
    subagentProgress: true,
    rateLimits: true,
    imageInput: true,
    companyFilesMcp: true,
    references: true,
    writeGuard: true,
    privateReadGuard: true,
    handoff: true,
    oneShotText: true,
    webReader: true,
    // macOS / Linux (sandboxPlatform): Claude Code's own sandbox via the SDK `sandbox` option.
    sandbox: true,
    commitMessageFallback: true,
    privateFolderCommitMessages: false,
    liveModelCatalog: false,
  },
}

/** UI model key → exact CLI `--model` string; anything unknown passes through (an id the CLI knows). */
export function claudeCliModel(modelId?: string): string {
  if (!modelId) return CLAUDE_CODE.tasks.chat!
  return CLAUDE_MODELS.find(m => m.id === modelId)?.cliModel ?? modelId
}

/**
 * `xhigh` on a CLI model that does not accept it is demoted to `high`, so a
 * stale selection — e.g. one carried over by session resume — doesn't error on
 * the CLI. A substring test on purpose: 'claude-opus-4-5' does not contain
 * 'opus-5', while 'claude-opus-5-5[1m]' does — keep it a substring test, not
 * an exact match, or Opus 5.5 silently loses xhigh. It also covers ids the
 * member's CLI knows but this table does not.
 */
export function claudeCliEffort(cliModel: string, effort?: AgentEffort): AgentEffort | undefined {
  if (effort === 'xhigh' && !['opus-4-8', 'opus-4-7', 'opus-5', 'fable-5'].some(family => cliModel.includes(family))) return 'high'
  return effort
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/** The lightweight model verified for Japanese dictation (voice, commit messages, hand-off memos). */
const CODEX_LIGHT_MODEL = 'gpt-5.6-luna'

const CODEX: AgentDescriptor = {
  id: 'codex',
  shortLabel: 'Codex',
  label: 'Codex',
  // Verified with the app: app-server protocol, permission profiles +
  // features.network_proxy (`codex sandbox`, findings §B.2).
  minCliVersion: '0.153.4',
  // From `model/list` at run time; the model's own default effort applies.
  models: [],
  tasks: {
    // Titles use the conversation's own model (the request's modelId).
    // Voice and commit messages prefer the light model, else the catalog's default.
    commitMessage: CODEX_LIGHT_MODEL,
    voice: CODEX_LIGHT_MODEL,
    // Required: hand-off memos fail when the account does not have it.
    handoff: CODEX_LIGHT_MODEL,
    // No webReader entry: the Web reader runs on the catalog's default chat
    // model at its default effort (owner decision 2026-10-29: not the light one).
  },
  capabilities: {
    ownsConversation: true,
    steering: true,
    promptSuggestions: false,
    choicePrompts: true,
    subagentProgress: false,
    rateLimits: true,
    imageInput: true,
    companyFilesMcp: true,
    references: true,
    writeGuard: false,
    privateReadGuard: false,
    handoff: true,
    oneShotText: true,
    webReader: true,
    sandbox: false,
    commitMessageFallback: false,
    privateFolderCommitMessages: false,
    liveModelCatalog: true,
  },
}

// ---------------------------------------------------------------------------
// API key (Anthropic API, the app's own loop)
// ---------------------------------------------------------------------------

const API_KEY: AgentDescriptor = {
  id: 'api-key',
  shortLabel: 'API',
  label: 'APIキー',
  models: [],
  tasks: {
    chat: 'claude-sonnet-4-20250514',
    title: 'claude-haiku-4-5-20251001',
    // Commit messages moved to the newer Haiku with sync's AI messages; voice keeps 4.5.
    commitMessage: 'claude-haiku-5-5',
    voice: 'claude-haiku-4-5-20251001',
  },
  capabilities: {
    ownsConversation: false,
    steering: false,
    promptSuggestions: false,
    choicePrompts: false,
    subagentProgress: false,
    rateLimits: false,
    imageInput: true,
    companyFilesMcp: false,
    references: false,
    writeGuard: true,
    privateReadGuard: false,
    handoff: false,
    oneShotText: true,
    // The app's own loop has no web tools to replace.
    webReader: false,
    sandbox: false,
    commitMessageFallback: true,
    privateFolderCommitMessages: true,
    liveModelCatalog: false,
  },
}

export const AGENTS: { readonly [K in AgentId]: K extends 'claude-code' ? AgentDescriptor<ClaudeModelId> : AgentDescriptor } = {
  'claude-code': CLAUDE_CODE,
  codex: CODEX,
  'api-key': API_KEY,
}

/** The descriptor for an id, or undefined for anything else (stored / requested values are untrusted). */
export function agentDescriptor(id: unknown): AgentDescriptor | undefined {
  return isAgentId(id) ? AGENTS[id] : undefined
}

/** The short name shown for an agent ('Claude', 'Codex', 'API'); 'Claude' for anything unknown, as the UI always showed. */
export function agentShortLabel(id: unknown): string {
  return agentDescriptor(id)?.shortLabel ?? AGENTS['claude-code'].shortLabel
}

/** One capability of an id; false for an unknown id. */
export function agentCan(id: unknown, capability: keyof AgentCapabilities): boolean {
  return agentDescriptor(id)?.capabilities[capability] ?? false
}
