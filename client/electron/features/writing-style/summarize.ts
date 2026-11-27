// The writing-style summary's one AI call (client/shared/writing-style.ts): the member's own agent — the one their
// consultations use — as a tool-less, isolated one-shot (agents/registry.ts `runOneShotText`: Claude Code `claude -p`
// with no tools, settings or memory; Codex's text one-shot; the API key). The messages go as JSON data inside one
// outside-text block; only a checked `<writing_style>` JSON comes back. Never another agent on the member's behalf, never
// logged (only the agent id and a fixed word).
import fs from 'fs'
import type { AuthMode } from '../../../shared/agent'
import { isAgentId, type AgentId } from '../../../shared/agents/registry'
import { oneShotUnavailable, runOneShotText, type OneShotTextRequest } from '../../agents/registry'
import {
  readWritingStyleAnswer, WRITING_STYLE_DEVELOPER_INSTRUCTIONS, WRITING_STYLE_SYSTEM_PROMPT, writingStyleInput,
} from '../../../shared/writing-style'
import type { WritingSample, WritingStyle } from '../../../../shared/core/writing-style'

export const WRITING_STYLE_TIMEOUT_MS = 120_000

export interface WritingSummarizerDeps {
  settings: () => { authMode: AuthMode; apiKey?: string }
  claudeReady: () => boolean
  getCli: () => string
  getEnv: () => Record<string, string>
  /** A neutral, empty working directory (never the company folder). */
  cwd: () => string
  adapter?: (agent: AgentId, request: OneShotTextRequest) => Promise<string>
  log?: Pick<Console, 'warn'>
}

const CLI_MESSAGES = {
  cancelled: 'cancelled', timedOut: 'timed out', spawnFailed: 'the CLI could not be started',
  stdinFailed: 'stdin failed', tooLong: 'output too long', exitFailed: 'the CLI exited with an error', invalid: 'no usable result',
}

export function createWritingSummarizer(deps: WritingSummarizerDeps) {
  const adapter = deps.adapter ?? runOneShotText
  const log = deps.log ?? console
  return async (samples: readonly WritingSample[], signal: AbortSignal): Promise<WritingStyle | null> => {
    const { authMode, apiKey } = deps.settings()
    // A stored value the app does not know runs Claude Code, as it always did.
    const agent: AgentId = isAgentId(authMode) ? authMode : 'claude-code'
    const cwd = deps.cwd()
    fs.mkdirSync(cwd, { recursive: true })
    const host = { getCli: deps.getCli, cwd, env: deps.getEnv(), apiKey, claudeReady: deps.claudeReady }
    if (oneShotUnavailable(agent, host)) return null
    const controller = new AbortController()
    const stop = () => controller.abort()
    signal.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(stop, WRITING_STYLE_TIMEOUT_MS)
    try {
      const raw = await adapter(agent, {
        job: 'writingStyle', system: WRITING_STYLE_SYSTEM_PROMPT, input: writingStyleInput(samples), signal: controller.signal, host,
        timeoutMs: WRITING_STYLE_TIMEOUT_MS, maxOutputTokens: 1200, cliMessages: CLI_MESSAGES, instructions: WRITING_STYLE_DEVELOPER_INSTRUCTIONS,
      })
      const style = readWritingStyleAnswer(raw)
      if (!style) log.warn(`[writing-style] ${agent}: no usable summary`)
      return style
    } catch {
      log.warn(`[writing-style] ${agent}: the summary failed`)
      return null
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
    }
  }
}
