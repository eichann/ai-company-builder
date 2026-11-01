/**
 * The state engine (stage 4-3, `.claude/rules/records.md`): the only way a
 * record's server-sourced values (state, assignee, due…) change. It does
 * exactly five things (ontology §17.7, 案 B) and nothing else:
 *
 *   1. may the action start from the current state?
 *   2. may this actor do it (the type's `who`)?
 *   3. write the new state AND its ledger entry together (one transaction,
 *      optimistic concurrency on the record's version)
 *   4. tell whom the action names (the push channel: kind + version only)
 *   5. on a milestone, append a line to the record file's 「経緯」 (the
 *      server's own commit, through the push checker)
 *
 * No expressions, computed values, cascades, timers or outside sends: an
 * action's arguments are copied into the fields they name, `hand_to` copies
 * one person into `next_actor`, and that is all the engine computes.
 *
 * The ledger is append-only: an undo is a new entry reversing an earlier
 * one. Every entry carries before/after values of each field it changed, so
 * any version of a record can be replayed (shared/core/record-ledger.ts).
 *
 * This module is the engine's one entry point; the parts are in
 * record-engine/ (records.md "The state engine" lists them):
 *   types.ts            the engine's dependencies, the actor, the change a notice is about
 *   values.ts           field values by kind, OK statements, decision materials, provenance
 *   refusals.ts         refusals shared by the operations and other services
 *   links.ts            interface links, `links.<name>` ledger values, link rows
 *   context.ts          what every member-facing operation shares (open, reader, state, tell)
 *   create.ts / act.ts / undo.ts / file-links.ts / share.ts / history.ts
 *                       the member-facing operations
 *   external-writer.ts  results of a connector plugin's exchange (no route reaches it)
 *   service-writer.ts   service-owned types of the core services (no route reaches it)
 */
import { acting } from './record-engine/act'
import { engineContext } from './record-engine/context'
import { creating } from './record-engine/create'
import { fileLinking } from './record-engine/file-links'
import { ledgerReading } from './record-engine/history'
import { sharing } from './record-engine/share'
import type { RecordEngineDeps } from './record-engine/types'
import { undoing } from './record-engine/undo'

export type { ActorInput, RecordChange, RecordEngineDeps } from './record-engine/types'
export { selfReportedProvenance } from './record-engine/values'
export {
  ASSIGNEE_CANNOT_READ, FILE_NOT_LINKABLE, LINK_TARGET_NOT_FOUND, OK_BY_CANNOT_READ, STATE_CHANGED_BY_SERVICE, TYPE_CREATED_BY_SERVICE,
} from './record-engine/refusals'
export { linkLedgerValue } from './record-engine/links'
export { mayAct } from './record-engine/act'
export { SHARE_ACTION } from './record-engine/share'
export {
  createExternalRecordWriter, type ExternalRecordInput, type ExternalRecordResult, type ExternalRecordWriter,
} from './record-engine/external-writer'
export {
  createServiceRecordWriter, type ServiceActor, type ServiceCreateInput, type ServiceRecordWriter, type ServiceTransitionInput,
  type ServiceWriteFailed, type ServiceWriteFailure, type ServiceWriteResult,
} from './record-engine/service-writer'

/** The member-facing engine (records routes, a member's AI): create, act, undo, fileLink, share, history, atVersion. */
export function createRecordEngine(deps: RecordEngineDeps) {
  const ctx = engineContext(deps)
  return {
    ...creating(ctx),
    ...acting(ctx),
    ...undoing(ctx),
    ...fileLinking(ctx),
    ...sharing(ctx),
    ...ledgerReading(ctx),
  }
}

export type RecordEngine = ReturnType<typeof createRecordEngine>
