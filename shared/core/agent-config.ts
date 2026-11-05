/**
 * Agent config — what the chat's agents (Claude Code, Codex) load from the
 * company folder and can run, which only owners and admins may add, change,
 * delete or rename (the push check's [PROTECTED_CONFIG], .claude/rules/push-check.md).
 * A member's change there would run on every teammate's computer, or steer
 * every teammate's AI, as soon as sync brings it.
 *
 * Two parts, both at any depth and A–Z case-insensitive:
 *
 * - Named config (AGENT_CONFIG_PATTERN): `.mcp.json`, `.claude/settings.json`,
 *   `.claude/settings.local.json`, `.claude/hooks/`, Codex's whole `.codex/`,
 *   and a file or symlink named `.claude` or `.codex`. Owner/admin only, with
 *   no exception.
 * - Default-deny (AGENT_FOLDER_PATTERN, 2026-11-05): everything else in
 *   `.claude/` and Codex's `.agents/` (and a file or symlink named `.agents`),
 *   so a file kind a CLI starts to load later (Codex's repository
 *   marketplace `.agents/plugins/`, `.claude/output-styles/`, a script a
 *   setting points at, …) is protected the day it appears. Two kinds keep
 *   their own, wider rules, so members' everyday work does not change:
 *   skill files (skill-files.ts: also department managers, 「Skill を直せる人」)
 *   and instruction files (instruction-files.ts: CLAUDE.md, AGENTS.md and
 *   `.claude/rules/*.md`, also a department manager inside their department).
 *
 * The push checker builds its bytewise twins from the same patterns
 * (server/src/lib/push-check/rules.ts); client/tests/rule-parity-names.test.ts
 * pins that both give the same answer.
 *
 * Pure: no Node, Electron, React, Hono, database or git.
 */
import { isInstructionFile } from './instruction-files'
import { lookalikeKey } from './paths'
import { isSkillFile } from './skill-files'

/** Named agent config, owner/admin only whatever else the path is. Regex source, lower case (`i` where matched). */
export const AGENT_CONFIG_PATTERN = String.raw`(^|/)\.mcp\.json$|(^|/)\.claude$|(^|/)\.claude/settings(\.local)?\.json$|(^|/)\.claude/hooks(/|$)|(^|/)\.codex(/|$)`

/** The agents' folders, protected by default: `.claude/` and `.agents/` (or a file named so). Regex source, lower case. */
export const AGENT_FOLDER_PATTERN = String.raw`(^|/)\.(claude|agents)(/|$)`

const AGENT_CONFIG_RE = new RegExp(AGENT_CONFIG_PATTERN)
const AGENT_FOLDER_RE = new RegExp(AGENT_FOLDER_PATTERN)

/**
 * Is `repoPath` agent config only an owner/admin may change — named config,
 * or anything else in `.claude/` / `.agents/` that is neither a skill file nor
 * an instruction file? However a disk could fold the spelling (lookalikeKey).
 */
export function isAgentConfig(repoPath: string): boolean {
  const key = lookalikeKey(repoPath)
  if (AGENT_CONFIG_RE.test(key)) return true
  return AGENT_FOLDER_RE.test(key) && !isSkillFile(repoPath) && !isInstructionFile(repoPath)
}
