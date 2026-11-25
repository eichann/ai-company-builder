/**
 * 「Skill の承認」 (agent-browser.md "A Skill's browser declaration and its approval"). Two ports:
 *
 * - `BrowserSkillApprovalRepository`, from the company handle (`CompanyData`): every method limited to that company.
 * - `BrowserSkillSource`: the company's own copy of its Skills — the shared branch of the company repository for a
 *   company with the shared folder, the Skill shelf for one without. **Never what an app sent.** Rules:
 *   services/browser-skills.ts.
 */
export interface BrowserSkillApprovalRow {
  seq: number
  skillPath: string
  declarationHash: string
  /** shared/types/browser-skills.ts `BrowserSkillApprovalMode` (ports import no API shapes). */
  mode: 'per_run' | 'pre_approved'
  how: 'approved' | 'edited'
  approvedBy: string
  approvedAt: string
  filesSeen: string | null
  revokedAt: string | null
  revokedBy: string | null
}

export type BrowserSkillApprovalInsert = Omit<BrowserSkillApprovalRow, 'seq' | 'revokedAt' | 'revokedBy'>

export interface BrowserSkillApprovalRepository {
  /** The skill's latest row, or null. */
  latest(skillPath: string): BrowserSkillApprovalRow | null
  insert(row: BrowserSkillApprovalInsert): BrowserSkillApprovalRow
  /** Revoke row `seq` when it is still the skill's latest and not revoked; false otherwise. */
  revoke(seq: number, at: string, by: string): boolean
  setFilesSeen(seq: number, files: string): void
}

/** One Skill as the server's own copy holds it. */
export interface BrowserSkillContent {
  name: string
  /** `browser.yaml`'s text, or `too-large` (never read whole). */
  declaration: string | 'too-large'
  /** The whole folder's fingerprint (`git:<tree id>` / `shelf:<version>`): moves when any file of the Skill changes. */
  files: string
}

/** A Skill as one change left it, and whether that change touched `browser.yaml` (added or changed it). */
export interface BrowserSkillLanded extends BrowserSkillContent {
  declarationChanged: boolean
}

export interface BrowserSkillSource {
  /** The company-wide Skills that carry `browser.yaml`, by name (sorted, bounded). */
  list(companyId: string): Promise<string[]>
  /** One Skill now (null: no such Skill, or no `browser.yaml` in it). */
  read(companyId: string, name: string): Promise<BrowserSkillContent | null>
  /**
   * What one accepted push to the company repository changed (`<old> <new> <ref>` lines the push checker accepted): the
   * company-wide Skills with `browser.yaml` that it touched, each read **at the pushed commit** (not the tip, which may
   * already be someone else's).
   */
  pushed(companyId: string, refUpdates: string): Promise<BrowserSkillLanded[]>
  /** A shelf Skill at exactly the version one publish wrote, against the version current before it (null: none). */
  shelfLanded(companyId: string, name: string, versions: { before: string | null; written: string }): Promise<BrowserSkillLanded | null>
}
