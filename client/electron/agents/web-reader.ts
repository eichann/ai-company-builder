/**
 * The Web reader's contract (web-research.md): a one-shot job of the member's
 * own agent that may only search and read the web — no file or command
 * tools, no settings, MCP servers, skills or memory, an empty temporary
 * folder as its working directory — and answers key points + sources. The
 * chat AI never sees a page itself; the app tool (web-research/tools.ts)
 * cleans the reader's answer first (shared/web-research.ts).
 *
 * Each agent implements it in its own module (claude-web-reader.ts,
 * codex-web-reader.ts), reached through agents/registry.ts `runWebReader`.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { WebResearchInput } from '../../shared/web-research'

export interface WebReaderHost {
  /** The member's CLI (read only by agents that run one). */
  getCli: () => string
  /** The member's environment; the agent cuts it down (agent-env.ts). */
  env: Record<string, string>
}

export interface WebReaderRequest {
  /** Validated (shared/web-research.ts validateWebResearchInput); sent to the reader as JSON data. */
  input: WebResearchInput
  signal: AbortSignal
  host: WebReaderHost
  /** Default WEB_READER_TIMEOUT_MS. */
  timeoutMs?: number
}

/** What the factory hands the agent's reader. */
export interface WebReaderJob extends WebReaderRequest {
  /** The registry's `tasks.webReader`. */
  model: string
  /** A fresh empty folder, removed afterwards. */
  cwd: string
  timeoutMs: number
}

export interface WebReaderResult {
  /** The reader's final answer (raw; the tool cleans it). */
  answer: string
  /** URLs the reader opened, in order (for the source list and logs; never logged). */
  fetchedUrls: string[]
  /** How many searches it ran. */
  searches: number
}

export type WebReaderErrorCode = 'unavailable' | 'timeout' | 'cancelled' | 'refused-address' | 'too-long' | 'failed'

/** A failure the tool turns into a plain message; `message` is for logs (no content). */
export class WebReaderError extends Error {
  constructor(readonly code: WebReaderErrorCode, message: string) {
    super(message)
    this.name = 'WebReaderError'
  }
}

export const WEB_READER_TIMEOUT_MS = 120_000
/** Anything more from the CLI is not a reader's answer. */
export const WEB_READER_MAX_OUTPUT = 8_000_000
export const WEB_READER_MAX_ANSWER = 100_000

/** Run `job` in a new empty temporary folder that is removed afterwards. */
export async function inEmptyFolder<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'acb-web-reader-'))
  try { return await run(cwd) } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {})
  }
}
