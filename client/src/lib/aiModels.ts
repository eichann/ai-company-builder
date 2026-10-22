// Claude Code model / effort choices for the chat header, and the defaults a
// member gets until they pick something (pure module — unit tested).

// AI Model type. Opus is split into explicit 4.6 / 4.8 / 5 / 5.5 (1M context) choices; Fable 5
// has a native 1M context window; sonnet/haiku remain as CLI aliases.
export type AIModel = 'opus-4-6' | 'opus-4-8' | 'opus-5' | 'opus-5-5' | 'fable-5' | 'sonnet' | 'haiku'

// AI Effort level type. Valid levels depend on the model (see MODEL_EFFORT_OPTIONS);
// e.g. `xhigh` is only supported on Opus 4.7+ (incl. 4.8), Opus 5, Opus 5.5, and Fable 5,
// not 4.6/sonnet/haiku.
export type AIEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// Effort levels valid per model. Drives the effort selector options and clamping.
export const MODEL_EFFORT_OPTIONS: Record<AIModel, AIEffort[]> = {
  'opus-4-6': ['low', 'medium', 'high', 'max'],
  'opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
  'opus-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'opus-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'fable-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  sonnet: ['low', 'medium', 'high', 'max'],
  haiku: ['low', 'medium', 'high'],
}

// Display labels for the model selector.
export const MODEL_LABELS: Record<AIModel, string> = {
  'opus-4-6': 'Opus 4.6',
  'opus-4-8': 'Opus 4.8',
  'opus-5': 'Opus 5',
  'opus-5-5': 'Opus 5.5',
  'fable-5': 'Fable 5',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
}

/**
 * Defaults for a member with no saved choice (owner's decision, 2026-10-23):
 * Opus 5.5 at medium effort. Only what the member picks is saved
 * (localStorage `aiModel` / `aiEffort`), so changing these never overrides a
 * member's own choice. Codex keeps the model's own default effort.
 */
export const DEFAULT_AI_MODEL: AIModel = 'opus-5-5'
export const DEFAULT_AI_EFFORT: AIEffort = 'medium'

/** The saved `aiModel` value → model; anything unknown → the default. */
export function resolveSavedModel(saved: string | null | undefined): AIModel {
  if (saved && Object.prototype.hasOwnProperty.call(MODEL_LABELS, saved)) return saved as AIModel
  // The legacy 'opus' alias and anything unknown get the current default, not a stale generation.
  return DEFAULT_AI_MODEL
}

/** The saved `aiEffort` value → effort; anything unknown → the default. */
export function resolveSavedEffort(saved: string | null | undefined): AIEffort {
  if (saved === 'low' || saved === 'medium' || saved === 'high' || saved === 'xhigh' || saved === 'max') return saved
  return DEFAULT_AI_EFFORT
}
