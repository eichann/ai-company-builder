// Claude Code model / effort choices for the chat header, and the defaults a
// member gets until they pick something (pure module — unit tested). The
// models themselves live in the agent registry (shared/agents/registry.ts);
// this is the renderer's view of the Claude Code entry.

import { AGENTS, AGENT_EFFORTS, type AgentEffort, type ClaudeModelId } from '../../shared/agents/registry'

export type AIModel = ClaudeModelId

// AI Effort level type. Valid levels depend on the model (see MODEL_EFFORT_OPTIONS).
export type AIEffort = AgentEffort

const CLAUDE = AGENTS['claude-code']

/** Claude Code models in selector order. */
export const CLAUDE_MODELS = CLAUDE.models

// Effort levels valid per model. Drives the effort selector options and clamping.
export const MODEL_EFFORT_OPTIONS = Object.fromEntries(CLAUDE.models.map(m => [m.id, [...m.efforts]])) as Record<AIModel, AIEffort[]>

// Display labels for the model selector.
export const MODEL_LABELS = Object.fromEntries(CLAUDE.models.map(m => [m.id, m.label])) as Record<AIModel, string>

/**
 * Defaults for a member with no saved choice (owner's decision, 2026-10-23):
 * Opus 5.5 at medium effort. Only what the member picks is saved
 * (localStorage `aiModel` / `aiEffort`), so changing these never overrides a
 * member's own choice. Codex keeps the model's own default effort.
 */
export const DEFAULT_AI_MODEL: AIModel = CLAUDE.defaultModel!
export const DEFAULT_AI_EFFORT: AIEffort = CLAUDE.defaultEffort!

/** The saved `aiModel` value → model; anything unknown → the default. */
export function resolveSavedModel(saved: string | null | undefined): AIModel {
  if (saved && Object.prototype.hasOwnProperty.call(MODEL_LABELS, saved)) return saved as AIModel
  // The legacy bare opus alias and anything unknown get the current default, not a stale generation.
  return DEFAULT_AI_MODEL
}

/** The saved `aiEffort` value → effort; anything unknown → the default. */
export function resolveSavedEffort(saved: string | null | undefined): AIEffort {
  if (saved && (AGENT_EFFORTS as readonly string[]).includes(saved)) return saved as AIEffort
  return DEFAULT_AI_EFFORT
}
