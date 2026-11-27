/**
 * A company Skill's steps for 「ブラウザ操作」's operator, bound to the version the server holds (agent-browser.md "The
 * operator works from the approved steps"). Knows no site.
 *
 * The steps are the Skill folder's `SKILL.md` and `site-notes.md`, joined in that order into one text — exactly the text
 * the operator is handed. The server reads them from its own copy of the Skill (the folder version the approval and the
 * frames run name) and answers a **seal**: `sha256:` of that text, or that the Skill has none, or that they are too large.
 * The app builds the same text from the member's company folder and starts only when its hash is the seal's: steps that
 * differ (edited locally, not synced yet), are missing (a department not downloaded) or would be cut are never handed over.
 * Hashing is the caller's (the core has no crypto).
 */

/** The files of a Skill folder that make its steps, in the order they are joined. */
export const BROWSER_SKILL_STEP_FILES = ['SKILL.md', 'site-notes.md'] as const
export type BrowserSkillStepFileName = typeof BROWSER_SKILL_STEP_FILES[number]

export const BROWSER_SKILL_STEPS_LIMITS = Object.freeze({
  /** One file read at most (larger: the steps are too large, never read in part). */
  fileBytes: 64 * 1024,
  /** The joined text handed to the operator at most (longer: too large, never cut). */
  chars: 20_000,
})

/** One step file as read: its text, too large to read whole, or absent (null). */
export type BrowserSkillStepFile = { name: BrowserSkillStepFileName; text: string } | { name: BrowserSkillStepFileName; tooLarge: true }

/** The steps a folder gives: none, too large, or the one text. */
export type BrowserSkillStepsText = { kind: 'none' } | { kind: 'too-large' } | { kind: 'text'; text: string }

/** The server's seal of a Skill's steps, as the frames run's start answers it. */
export type BrowserSkillStepsSeal = { state: 'none' } | { state: 'too-large' } | { state: 'sealed'; hash: string }

const HASH_RE = /^sha256:[0-9a-f]{64}$/

/**
 * The steps' one text from the files read (each name at most once, in `BROWSER_SKILL_STEP_FILES`' order whatever order they
 * were given in): `# <name>\n<text>` per file, joined by a blank line. Any file too large, or the text over
 * `BROWSER_SKILL_STEPS_LIMITS.chars` → `too-large`; no file → `none`.
 */
export function browserSkillStepsText(files: readonly BrowserSkillStepFile[]): BrowserSkillStepsText {
  const parts: string[] = []
  for (const name of BROWSER_SKILL_STEP_FILES) {
    const found = files.filter(f => f.name === name)
    if (found.length === 0) continue
    const f = found[0]
    if (found.length > 1 || 'tooLarge' in f) return { kind: 'too-large' }
    parts.push(`# ${name}\n${f.text}`)
  }
  if (parts.length === 0) return { kind: 'none' }
  const text = parts.join('\n\n')
  return text.length > BROWSER_SKILL_STEPS_LIMITS.chars ? { kind: 'too-large' } : { kind: 'text', text }
}

/** The seal of a folder's steps (`sha256` = hex of a text's UTF-8). */
export function browserSkillStepsSeal(steps: BrowserSkillStepsText, sha256: (text: string) => string): BrowserSkillStepsSeal {
  if (steps.kind === 'none') return { state: 'none' }
  if (steps.kind === 'too-large') return { state: 'too-large' }
  return { state: 'sealed', hash: `sha256:${sha256(steps.text)}` }
}

/** A seal as an answer carries it, read strictly; null when it is anything else (an older server sends none). */
export function readBrowserSkillStepsSeal(v: unknown): BrowserSkillStepsSeal | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const keys = Object.keys(o)
  if (o.state === 'none' || o.state === 'too-large') return keys.length === 1 ? { state: o.state } : null
  if (o.state === 'sealed' && keys.length === 2 && typeof o.hash === 'string' && HASH_RE.test(o.hash)) return { state: 'sealed', hash: o.hash }
  return null
}

/** Why the app does not start a Skill's work over its steps. */
export const BROWSER_SKILL_STEPS_PROBLEMS = ['steps-unsealed', 'steps-too-large', 'steps-missing', 'steps-changed'] as const
export type BrowserSkillStepsProblem = typeof BROWSER_SKILL_STEPS_PROBLEMS[number]

/**
 * The one check before the operator is handed a Skill's steps: the server's seal (`unknown`, as received) against the text
 * read on this PC (`local`; null = the folder could not be read at all). Only a sealed hash equal to the local text's, or
 * a Skill with no steps on both sides, passes. No seal (an older server) → `steps-unsealed`; too large on either side →
 * `steps-too-large`; sealed but nothing here → `steps-missing`; anything else → `steps-changed`.
 */
export function browserSkillStepsCheck(seal: unknown, local: BrowserSkillStepsText | null, sha256: (text: string) => string): { ok: true; steps: string | null } | { ok: false; problem: BrowserSkillStepsProblem } {
  const s = readBrowserSkillStepsSeal(seal)
  if (!s) return { ok: false, problem: 'steps-unsealed' }
  if (s.state === 'too-large' || local?.kind === 'too-large') return { ok: false, problem: 'steps-too-large' }
  if (s.state === 'none') return local === null || local.kind === 'none' ? { ok: true, steps: null } : { ok: false, problem: 'steps-changed' }
  if (local === null || local.kind === 'none') return { ok: false, problem: 'steps-missing' }
  return `sha256:${sha256(local.text)}` === s.hash ? { ok: true, steps: local.text } : { ok: false, problem: 'steps-changed' }
}
