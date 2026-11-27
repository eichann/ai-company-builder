/**
 * API shapes of a Skill's draft made from a member's own recordings (agent-browser.md "A Skill's draft from a recording").
 * Every route answers the member's own drafts and recordings only: nobody else's, owners and admins included.
 *
 *   GET    /browser-skill-drafts            → BrowserSkillDraftsList
 *   POST   /browser-skill-drafts            { recordingIds, name? } → BrowserSkillDraftDetail (made again from own recordings)
 *   GET    /browser-skill-drafts/:draftId   → BrowserSkillDraftDetail
 *   PUT    /browser-skill-drafts/:draftId   { expectedVersion, name?, declaration?, steps? } → BrowserSkillDraftDetail
 *   DELETE /browser-skill-drafts/:draftId   → { deleted: true }
 */
import type { BrowserRecordingContent } from '../core/browser-recording'
import type { BrowserSkillDraftLeftOut, BrowserSkillDraftMark } from '../core/browser-skill-draft'

export interface BrowserSkillDraftSummary {
  id: string
  /** The Skill's name (the Skill name rule); `draft-xxxxxx` until the author names it. */
  name: string
  domain: string
  /** The recordings it was made from (some may be gone after their 30 days). */
  recordingIds: string[]
  version: string
  /** The version a trial went through to the end (a later PR), else null. */
  triedVersion: string | null
  createdAt: string
  updatedAt: string
  /** When it is deleted by itself (30 days after its last change). */
  deleteAt: string
}

/** What the rule said about the declaration it made (fixed words; the writes counted from 1). */
export interface BrowserSkillDraftNotes {
  writes: Array<{ write: number; marks: BrowserSkillDraftMark[]; idFields: string[] }>
  leftOut: Array<{ recording: number; step: number; reason: BrowserSkillDraftLeftOut }>
}

/** One of the author's own recordings the draft was made from, in its kept form (no value). */
export interface BrowserSkillDraftSource {
  id: string
  createdAt: string
  content: BrowserRecordingContent
}

export interface BrowserSkillDraftDetail extends BrowserSkillDraftSummary {
  /** What the server made from the recordings (never changes): `declaration` may only be narrower. */
  baseDeclaration: string
  notes: BrowserSkillDraftNotes
  /** The current `browser.yaml`. */
  declaration: string
  /** The current `SKILL.md` (empty until written). */
  steps: string
  /** The recordings still kept, the author's own only. */
  sources: BrowserSkillDraftSource[]
}

/** One of the author's own recordings (no content), to choose from when making a draft again. */
export interface BrowserSkillDraftRecording {
  id: string
  domain: string
  lines: number
  createdAt: string
}

export interface BrowserSkillDraftsList {
  drafts: BrowserSkillDraftSummary[]
  /** The author's own recordings still kept, newest first. */
  recordings: BrowserSkillDraftRecording[]
}
