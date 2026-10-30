// Sync's commit message (electron/commit-message.ts): written by the AI the
// member signs in with — Claude Code (`claude -p --model haiku`, isolated),
// Codex, or the API key — from the staged file list only (name-status +
// stat, no contents). No AI, a failure or 30 s without an answer → null, and
// sync commits its fixed message. A private folder's clone uses the API key
// only, as before.

import fs from 'fs'
import type { SimpleGit } from 'simple-git'
import { createCommitMessageGenerator, type CommitMessageGenerator } from '../commit-message'
import type { ClaudeCli } from './claude-cli'
import type { ConfigStore } from './config-store'
import type { ShellEnvironment } from './shell-env'

export interface CommitMessagesDeps {
  config: ConfigStore
  /** The API key in clear text (services/api-key-store.ts), read per use. */
  apiKey: () => string | undefined
  claudeCli: ClaudeCli
  shellEnv: ShellEnvironment
  /** A working directory for the one-shot CLI (<userData>/commit-message). */
  cwd: () => string
  /**
   * False while an administrator has stopped the AI (agent-stop.md): no AI is
   * asked and sync commits its fixed message.
   */
  aiAllowed?: () => boolean
}

/**
 * `gitFor` picks the index: the member's own for sync, a throwaway copy for
 * the preview's summary (git:generateSummary — preview never stages).
 */
export type CommitMessagesFor = (gitFor: (repoPath: string) => SimpleGit) => CommitMessageGenerator

export function createCommitMessages({ config, apiKey, claudeCli, shellEnv, cwd, aiAllowed }: CommitMessagesDeps): CommitMessagesFor {
  return (gitFor) => withStop(aiAllowed, createCommitMessageGenerator({
    readStaged: async (repoPath) => {
      const git: SimpleGit = gitFor(repoPath)
      // core.quotePath=false: Japanese names as text, not octal escapes.
      const stat = await git.raw(['-c', 'core.quotePath=false', 'diff', '--cached', '--stat'])
      const nameStatus = await git.raw(['-c', 'core.quotePath=false', 'diff', '--cached', '--name-status'])
      return { nameStatus, stat }
    },
    settings: () => ({ authMode: config.authMode(), apiKey: apiKey() }),
    claudeReady: claudeCli.isAuthenticated,
    getCli: claudeCli.path,
    getEnv: shellEnv.env,
    getCwd: () => {
      const dir = cwd()
      fs.mkdirSync(dir, { recursive: true })
      return dir
    },
  }))
}

/** The generator, or null (the fixed message) while the AI is stopped. */
export function withStop(aiAllowed: (() => boolean) | undefined, generate: CommitMessageGenerator): CommitMessageGenerator {
  if (!aiAllowed) return generate
  return async (repoPath, opts) => {
    if (!aiAllowed()) { console.log('[commit-message] the AI is stopped by an administrator; using the fixed message'); return null }
    return generate(repoPath, opts)
  }
}
