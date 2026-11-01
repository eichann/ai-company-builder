/**
 * Which company Skill a consultation used (records.md "Which Skill"), behind
 * the company handle: every method is limited to the handle's company.
 */
import type { SkillUse } from '../../shared/core/skill-uses'

export interface SkillUseRepository {
  /**
   * Keeps (name, tree, dirty) for the member's consultation with `at` as its first use;
   * one already kept stays as it was. `full` when the consultation already has `limit` others.
   */
  record(userId: string, conversationId: string, use: { name: string; tree: string; dirty: boolean }, at: string, limit: number): 'added' | 'known' | 'full'
  /** The member's consultation's uses, first used first. */
  forConsultation(userId: string, conversationId: string): SkillUse[]
}
