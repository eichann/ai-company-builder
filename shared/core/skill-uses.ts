/**
 * Which company Skill a consultation used (owner decision 2026-11-01: compare
 * work done with Skill v1 and v2; records.md "Which Skill").
 *
 * The member's app sees Claude Code's `Skill` tool load a skill whose folder is
 * synced in the company repository (`.claude/skills/<name>/`, at the company
 * root or in a shared department folder) and reports, per consultation:
 *
 * - `name`: the skill folder name (ASCII, `isValidSkillName`);
 * - `tree`: the git tree id of that folder at the member's HEAD — the same id
 *   on every PC that has the same synced content (the version);
 * - `dirty`: the folder had changes not yet in HEAD when it was used (the tree
 *   id then names what it started from, not exactly what ran).
 *
 * Never the folder's path, its files or their contents. A skill inside a
 * private folder, a skill only on this PC (not in HEAD, e.g. kept private by
 * the root .gitignore) and a personal / plugin skill are not reported.
 *
 * The server keeps the first time each (name, tree, dirty) was reported for
 * the member's consultation and copies the list onto what the AI writes in that
 * consultation (ledger entries, Drive put receipts) at write time.
 *
 * Pure (shared/core): the server validates with it, the app builds with it.
 */
import { isValidSkillName } from './names'

export interface SkillUse {
  name: string
  tree: string
  dirty: boolean
  /** When the server first heard of this (name, tree, dirty) in the consultation. */
  firstUsedAt: string
}

/** A git tree id: SHA-1 (40 hex) or SHA-256 (64 hex), lower case. */
export const SKILL_TREE_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
export const SKILL_NAME_MAX = 64
/** Distinct (name, tree, dirty) kept per consultation; more are not recorded. */
export const SKILL_USES_PER_CONSULTATION = 20
/** The consultation id as record tokens take it (1–200 characters, no control characters). */
// eslint-disable-next-line no-control-regex
const CONVERSATION_ID_RE = /^[^\u0000-\u001f\u007f]{1,200}$/

export interface SkillUseReport {
  conversationId: string
  name: string
  tree: string
  dirty: boolean
}

export function isSkillUseName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= SKILL_NAME_MAX && isValidSkillName(name)
}

/** POST …/me/skill-uses body, checked; a string says what is wrong. */
export function readSkillUseReport(body: unknown): SkillUseReport | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Body must be a JSON object'
  const b = body as Record<string, unknown>
  if (typeof b.conversationId !== 'string' || !CONVERSATION_ID_RE.test(b.conversationId)) return 'conversationId is required (1–200 characters)'
  if (!isSkillUseName(b.name)) return 'name is a skill folder name'
  if (typeof b.tree !== 'string' || !SKILL_TREE_RE.test(b.tree)) return 'tree is a git tree id'
  if (typeof b.dirty !== 'boolean') return 'dirty is true or false'
  return { conversationId: b.conversationId, name: b.name, tree: b.tree, dirty: b.dirty }
}

/** A stored list read back (null when absent, empty or not one). */
export function parseSkillUses(raw: string | null | undefined): SkillUse[] | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v)) return null
    const uses = v.filter((u): u is SkillUse => !!u && typeof u === 'object'
      && isSkillUseName((u as SkillUse).name) && typeof (u as SkillUse).tree === 'string' && SKILL_TREE_RE.test((u as SkillUse).tree)
      && typeof (u as SkillUse).dirty === 'boolean' && typeof (u as SkillUse).firstUsedAt === 'string')
      .map(u => ({ name: u.name, tree: u.tree, dirty: u.dirty, firstUsedAt: u.firstUsedAt }))
    return uses.length > 0 ? uses : null
  } catch {
    return null
  }
}
