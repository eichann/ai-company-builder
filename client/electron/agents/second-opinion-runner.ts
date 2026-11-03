/**
 * The asked agent's contract (「もう一方の AI に聞く」, chat-and-agents.md "Asking the other AI"):
 * a one-shot of the other agent's own CLI with NO tools at all — it cannot read or write files,
 * run commands, search or fetch the web, or reach MCP servers — no settings, skills, hooks,
 * memory or session, an empty temporary folder as its working directory, and the material the
 * app chose (shared/agents/second-opinion.ts) as JSON data on its input. Narrower than the
 * company's sandbox: there is nothing for a sandbox to hold.
 *
 * Each agent implements it in its own module (claude-second-opinion.ts,
 * codex-second-opinion.ts), reached through agents/registry.ts `runSecondOpinion`.
 */
import type { SecondOpinionErrorCode } from '../../shared/agents/second-opinion'

export interface SecondOpinionHost {
  /** The member's CLI (read only by agents that run one). */
  getCli: () => string
  /** The member's environment; the agent cuts it down (agent-env.ts). */
  env: Record<string, string>
  /** Claude Code installed and signed in (checked before starting it). */
  claudeReady?: () => boolean
}

export interface SecondOpinionRequest {
  /** The material (secondOpinionMaterial): sent as JSON data, never as instructions. */
  material: unknown
  signal: AbortSignal
  host: SecondOpinionHost
  /** Default SECOND_OPINION_LIMITS.timeoutMs. */
  timeoutMs?: number
}

/** What the factory hands the agent. */
export interface SecondOpinionJob extends SecondOpinionRequest {
  /** The registry's `tasks.secondOpinion`; '' → the agent's catalog default. */
  model: string
  /** A fresh empty folder, removed afterwards. */
  cwd: string
  timeoutMs: number
}

export interface SecondOpinionResult {
  /** The answer, raw (the tool cleans it). */
  answer: string
}

/** A failure the tool turns into a plain sentence; `message` is for logs (no content). */
export class SecondOpinionError extends Error {
  constructor(readonly code: SecondOpinionErrorCode, message: string) {
    super(message)
    this.name = 'SecondOpinionError'
  }
}

/** Anything more from the CLI is not one answer. */
export const SECOND_OPINION_MAX_OUTPUT = 4_000_000
export const SECOND_OPINION_MAX_ANSWER = 100_000
