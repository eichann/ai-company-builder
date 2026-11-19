// What the member must still do before the chat can use Claude Code (pure).
import type { ClaudeCodeStatus } from '../../../shared/ipc-contract'

/** Anthropic's own install page (the app does not install Claude Code itself). */
export const CLAUDE_SETUP_GUIDE_URL = 'https://code.claude.com/docs/en/setup'

/** The chat may start with Claude Code (main's `authenticated` is false only for a plain sign-out). */
export function claudeCodeReady(status: ClaudeCodeStatus): boolean {
  return status.available && status.authenticated
}

export type ClaudeSetupStep = 'checking' | 'install' | 'sign-in' | 'ready'

/**
 * `sign-in` only when the CLI said plainly that nobody is signed in and the app can start
 * its sign-in; an old CLI or an answer the app could not read is `ready`, as before.
 */
export function claudeSetupStep(status: ClaudeCodeStatus | null): ClaudeSetupStep {
  if (!status) return 'checking'
  if (!status.available) return 'install'
  if (status.signIn?.state === 'signed-out' && status.signInSupported) return 'sign-in'
  return 'ready'
}
