import type { LedgerEntry, LedgerValue, LedgerVia } from '../../../shared/core/record-ledger'
import type { ActionVia } from '../../../shared/core/record-types'
import type { Clock, IdGenerator } from '../../ports/clock'
import type { CompanyDataSource } from '../../ports/company-data'
import type { TokenDigest } from '../../ports/key-broker'
import type { RecordFileWriter } from '../../ports/record-files'
import type { Transactions } from '../../ports/transactions'
import type { Member } from '../access'
import type { AcceptanceQuestion } from '../task-acceptance'

/**
 * After an action ran (its state and ledger written): what happened, for a lane that reacts to it
 * (plan C5: a meeting read moves its まとまり to a business plugin's step). Bound once
 * (`useAfterAction`); a listener's failure never changes the action's answer.
 */
export type AfterActionListener = (member: Member, actor: ActorInput, done: { recordId: string; type: string; action: string; toState: string | null }) => Promise<void>

/** Who holds a business role on a record (plan C3; services/plugin-roles.ts implements it). */
export interface RoleHolders {
  holdsOnRecord(companyId: string, type: string, recordId: string, role: string, userId: string): boolean
}

export interface RecordEngineDeps {
  companyData: CompanyDataSource
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
  files: RecordFileWriter
  /** Department folders the member manages (`dept_manager` in `who`). */
  managedFolders: (companyId: string, userId: string) => string[]
  isMember: (companyId: string, userId: string) => boolean
  /** The member's role in the company, or null (an assignee must be able to read the record). */
  roleOf: (companyId: string, userId: string) => string | null
  /**
   * The notices for these members (the people named on the record whom the entry concerns).
   * `change` says which ledger entry it was (services/notifications.ts), which keep only kind,
   * record, version and actor — never a value. Called without `change` it does nothing more:
   * the `records` push signal is `recordChanged`'s.
   */
  notify: (companyId: string, userIds: string[], change?: RecordChange) => void
  /**
   * A record changed (any ledger entry): every member who can read it now gets the content-free
   * `records` push signal (services/record-signal.ts; notifications.md "The push signal"). None
   * without it.
   */
  recordChanged?: (companyId: string, recordId: string) => void
  /**
   * Is this (NFC) path a folder of the company repository's shared branch? null when that cannot
   * be told (no repository yet, git failed). Used by `checkPlace` before a create / share names a
   * folder (audit B-M1: a missing folder answers like a private one). Absent → not checked.
   */
  folderExists?: (companyId: string, path: string) => Promise<boolean | null>
  /**
   * Does the company have its shared folder (services/company-folder.ts)? Without one a path on a
   * member's PC means nothing to anyone else: new company-path links, attached file versions and
   * file materials are refused (409 NO_COMPANY_FOLDER); such a company links a Drive file or an
   * owner-only file of the member's PC instead ("File links without the shared folder"). A Drive file
   * is linked in every company; a PC file a company with the folder refuses (409
   * FILE_LINK_KIND_NOT_HERE). Absent → yes.
   */
  hasCompanyFolder?: (companyId: string) => boolean
  /** Digests an output's item key into its id (minutes.md "Outputs made once"); absent → by title only. */
  tokenDigest?: TokenDigest
  /**
   * The absent members this member covers today (代わりの人, services/absences.ts,
   * the one resolution point): `who` may then also be met as one of them. None without it.
   */
  actsFor?: (companyId: string, userId: string) => string[]
  /**
   * Acceptance (引き受け, records.md "Acceptance"; services/task-acceptance.ts): is a request
   * someone else was asked to do accepted by itself (the company's setting)? Without it every
   * request is accepted at once (as before version 7 of the task type).
   */
  autoAccepts?: (companyId: string, q: AcceptanceQuestion) => boolean
  /**
   * Does the company want the AI's homework of a meeting as proposals (案, `PROPOSALS`;
   * TaskSettings.meetingTasks `propose`)? Without it the AI's creates start as before.
   */
  proposesFromMeeting?: (companyId: string) => boolean
  /**
   * After an action was written (state and ledger committed): a core service that must follow up
   * on a person's action (the inbox: 「もう返した」 drops the prepared reply drafts). Never throws
   * into the engine; nothing is undone when it fails.
   */
  afterAct?: (companyId: string, change: RecordChange) => void
  /**
   * The company's now (`YYYY-MM-DDTHH:MM`, its time zone) and its own holidays, for a core
   * argument default counted in business days (`ARG_DEFAULTS`, task version 12). Without it:
   * the default zone's now and no company holidays.
   */
  companyDay?: (companyId: string) => { now: string; holidays: string[] }
  /**
   * The company's reply 目安 (`YYYY-MM-DD`) for a message received at `receivedAt` (task settings:
   * 翌営業日 / 当日中 + cutoff, the company's holidays; `replyTarget`): the due of a request the AI
   * makes from a message without a deadline (inbox.md "A task from a message"). Without it: the
   * default settings and no company holidays.
   */
  replyGuideline?: (companyId: string, receivedAt: string) => string
  /**
   * 「使う機能」 (shared/core/features.ts, records.md "Features on and off"): are records of this
   * type 「見るだけ」 now (its feature is off)? Then nothing of it is created and no action, undo
   * or link change runs on it (409 FEATURE_OFF); reading is unchanged. Absent → never.
   */
  featureOff?: (companyId: string, type: string) => boolean
}

/**
 * A Google Drive file the Google connector checked for the linking member (records.md "File links
 * without the shared folder"): one of their own live picks, opened with their own `drive.file`
 * token, its revision, name, type and the sha256 of the content ACB read (null when it could not).
 * Only the route hands it over (services/google-drive.ts `linkable`), never a request body.
 */
export interface VerifiedDriveFile {
  fileId: string
  revisionId: string | null
  name: string
  mimeType: string | null
  sha256: string | null
}

/** The entry a notify is about (the record's type and its server fields after the entry). */
export interface RecordChange {
  type: string
  entry: LedgerEntry
  fields: Record<string, LedgerValue>
}

/**
 * Who is acting, decided by the route from the credential (records.md "Who
 * is acting"): the member's session → human; a record token → their AI. A
 * body field saying otherwise is ignored.
 */
export interface ActorInput {
  kind: 'human' | 'ai'
  /** For an AI: which one (the agent the token was issued for). */
  source?: string
  /**
   * Provenance, recorded in the ledger and NEVER used to authorize anything:
   * for a person, what their app reports (it can say anything); for the AI,
   * the conversation of its token. `proposedBy: 'ai'` only for a person.
   */
  conversationId?: string | null
  proposedBy?: 'ai' | null
  /** For the AI: the execution run its token is bound to (S10b; from the token, never the body). */
  runId?: string | null
  /**
   * For a person: the plugin screen the call came through (its bridge, plan 4b B6;
   * services/plugin-bridge.ts sets it, never a body). The action's `via` must
   * then include `plugin`; the ledger keeps it.
   */
  via?: LedgerVia | null
}

/**
 * Where a call comes from, as an action's `via` names it (shared/core/record-types.ts
 * ACTION_VIA): a plugin's screen, an automated run, else the core's screens (a
 * person's session, the member's consultation).
 */
export const callVia = (actor: Pick<ActorInput, 'kind' | 'runId' | 'via'>): ActionVia =>
  actor.via ? 'plugin' : actor.kind === 'ai' && actor.runId ? 'run' : 'screen'
