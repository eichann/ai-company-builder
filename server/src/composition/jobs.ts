/**
 * Scheduled jobs' wiring (定期の仕事, jobs.md) and the Skill shelf they pin from (plugins.md "The
 * Skill shelf"). Part of the composition root; like composition.ts, this module may import
 * adapters. src/composition.ts calls each function once, where its services were built before
 * (the order of construction is the root's):
 *
 * - `wireJobs`: the Skill shelf and the jobs' definitions and approval (PR 3a).
 * - `wireJobRetry`: 「もう一度」 of an occurrence (B PR 5b), after the execution runs.
 * - `wireJobOccurrences`: the occurrences and the runner (the server's operation), after the lanes.
 *
 * The PC's runs (`createJobRuns`) stay in composition.ts, next to the execution runs whose subjects
 * they are. What is built later in createServices is reached through the closures composition.ts
 * passes, called only after construction.
 */
import { DEFAULT_COMPANY_TIME_ZONE } from '../../shared/core/calendar'
import { latestJobSlot, nextJobSlot } from '../../shared/core/job-schedule'
import { isTimeTrigger } from '../../shared/core/jobs'
import { sha256Bytes } from '../adapters/system'
import { companySkillTree } from '../lib/skill-trees'
import type { CompanyRepository } from '../ports/companies'
import type { MembershipRepository } from '../ports/memberships'
import type { AgentStopService } from '../services/agent-stops'
import type { AiRunService } from '../services/ai-runs'
import { companyTimeToUtc, createJobOccurrences, createJobRunner, type JobOccurrenceDeps } from '../services/job-occurrences'
import { createJobRetry } from '../services/job-retry'
import { createJobService, type JobService, type JobServiceDeps } from '../services/jobs'
import { companyNow } from '../services/notifications'
import type { PermissionViewService } from '../services/permission-views'
import type { PushChannel } from '../services/push-channel'
import type { ServiceRecordWriter } from '../services/record-engine'
import { createSkillShelfService } from '../services/skill-shelf'
import type { TaskSettingsService } from '../services/task-settings'
import type { CompositionShared } from './shared'

export interface JobsWiringDeps<R extends { memberships: MembershipRepository }> {
  /** createServices' repositories, spread into the jobs' service as before. */
  repos: R
  shared: CompositionShared
  hasCompanyFolder: (companyId: string) => boolean
  permissionViews: Pick<PermissionViewService, 'managedFolders' | 'skillEditing'>
  push: Pick<PushChannel, 'notify'>
  taskSettings: Pick<TaskSettingsService, 'settingsOf'>
  /** The occurrences' holds (built later: `wireJobOccurrences`; called only after construction). */
  occurrenceHolds: NonNullable<JobServiceDeps['occurrenceHolds']>
  /** A deliverable place outside, answered by its connector (composition/google.ts; built later). */
  places: NonNullable<JobServiceDeps['places']>
  /** 「もう一度」 on an occurrence view (built later: `wireJobRetry`). */
  occurrenceRetry: NonNullable<JobServiceDeps['occurrenceRetry']>
  /** Event-triggered jobs: a business plugin step's 「AI の番」 states (built later: the plugins' lane). */
  aiStepStates: NonNullable<JobServiceDeps['aiStepStates']>
}

export function wireJobs<R extends { memberships: MembershipRepository }>(deps: JobsWiringDeps<R>) {
  const { repos, shared, permissionViews, push, taskSettings } = deps
  const companyFolders = { has: deps.hasCompanyFolder }

  // The Skill shelf of a company without the shared folder (plugins.md "The Skill shelf"); jobs pin its Skills (PR 5a).
  const skillShelf = createSkillShelfService({
    ...shared,
    hasCompanyFolder: companyFolders.has,
    managedFolders: permissionViews.managedFolders,
    skillEditing: permissionViews.skillEditing,
    sha256: sha256Bytes,
  })
  // 定期の仕事 (jobs.md): definitions and approval (PR 3a); occurrences and the server's operation later (PR 3b).
  const jobs = createJobService({
    ...repos, ...shared,
    skillTree: (companyId, name) => (companyFolders.has(companyId) ? companySkillTree(companyId, name) : Promise.resolve(null)),
    hasCompanyFolder: companyFolders.has,
    // A company without the shared folder pins a Skill of the shelf (jobs.md "A Skill from the shelf").
    shelfSkill: (who, itemId, version) => skillShelf.jobSkill(who, itemId, version),
    noticesChanged: (companyId, userIds) => push.notify(companyId, userIds, { kind: 'notifications', version: shared.ids.newToken().slice(0, 32) }),
    // A pause / the company's stop holds the occurrences (jobs.md "Held"); bound late: built later.
    occurrenceHolds: deps.occurrenceHolds,
    // A view's next slot (PR 4's screens): the clock's own zone and days off.
    timeZoneOf: () => DEFAULT_COMPANY_TIME_ZONE,
    holidaysOf: companyId => taskSettings.settingsOf(companyId).companyHolidays.map(h => h.date),
    // A deliverable place outside (jobs.md): its connector answers; bound late (built later).
    places: deps.places,
    // 「もう一度」 on an owner / admin's occurrence view (jobs.md "「もう一度」"); bound late (built later).
    occurrenceRetry: deps.occurrenceRetry,
    aiStepStates: deps.aiStepStates,
  })

  return { skillShelf, jobs }
}

export interface JobRetryWiringDeps {
  shared: CompositionShared
  jobs: JobService
  roleOf: (companyId: string, userId: string) => string | null
  agentStops: Pick<AgentStopService, 'policyFor'>
  aiRuns: Pick<AiRunService, 'reconcileFor'>
  taskSettings: Pick<TaskSettingsService, 'settingsOf'>
  /** A deliverable place outside is usable now (its connector answers; composition/google.ts). */
  placeUsable: NonNullable<JobOccurrenceDeps['placeUsable']>
}

export function wireJobRetry(deps: JobRetryWiringDeps) {
  const { shared, jobs, agentStops, aiRuns, taskSettings } = deps

  // 「もう一度」 of an occurrence (jobs.md, B PR 5b): owner / admin, the same stop and rights checks as a claim.
  const jobRetry = createJobRetry({
    ...shared, jobs,
    roleOf: deps.roleOf,
    aiStops: member => agentStops.policyFor(member),
    placeUsable: deps.placeUsable,
    reconcileFor: (companyId, runId, key, done, by) => aiRuns.reconcileFor(companyId, runId, key, done, by),
    // The clock's own slots (its zone and days off): the newest at or before now, and the next one.
    slotsOf: (companyId, definition) => {
      // An event job has no slots (stage 4a): each of its occurrences stands alone.
      if (!isTimeTrigger(definition.trigger)) return { latest: null, nextAt: null }
      const now = companyNow(shared.clock.nowMs(), DEFAULT_COMPANY_TIME_ZONE)
      const holidays = taskSettings.settingsOf(companyId).companyHolidays.map(h => h.date)
      const next = nextJobSlot(definition.trigger, now, holidays)
      return { latest: latestJobSlot(definition.trigger, now, holidays), nextAt: next ? companyTimeToUtc(next, DEFAULT_COMPANY_TIME_ZONE) : null }
    },
  })

  return { jobRetry }
}

export interface JobOccurrencesWiringDeps {
  shared: CompositionShared
  companies: Pick<CompanyRepository, 'allIds'>
  jobs: JobService
  /** The engine's service writer (records.md "Service writer"). */
  serviceRecords: ServiceRecordWriter
  roleOf: (companyId: string, userId: string) => string | null
  push: Pick<PushChannel, 'notify'>
  taskSettings: Pick<TaskSettingsService, 'settingsOf'>
  /** A deliverable place outside is usable now (its connector answers; composition/google.ts). */
  placeUsable: NonNullable<JobOccurrenceDeps['placeUsable']>
  /** Event-triggered jobs: a business plugin step's 「AI の番」 states (the plugins' lane). */
  aiStepStates: NonNullable<JobOccurrenceDeps['aiStepStates']>
}

export function wireJobOccurrences(deps: JobOccurrencesWiringDeps) {
  const { shared, jobs, serviceRecords, push, taskSettings } = deps
  const repos = { companies: deps.companies }

  // 定期の仕事の回 (jobs.md "The clock" / "The runner"): no AI — occurrences, and the server's operation (a やること).
  const jobOccurrences = createJobOccurrences({
    ...shared,
    // No per-company zone yet (calendar.md): the one place a setting would replace.
    timeZoneOf: () => DEFAULT_COMPANY_TIME_ZONE,
    holidaysOf: companyId => taskSettings.settingsOf(companyId).companyHolidays.map(h => h.date),
    roleOf: deps.roleOf,
    jobs,
    writer: serviceRecords,
    // A deliverable place no longer usable (a folder pick past its 90 days) sends the occurrence to a person at its slot.
    placeUsable: deps.placeUsable,
    aiStepStates: deps.aiStepStates,
    noticesChanged: (companyId, userIds) => push.notify(companyId, userIds, { kind: 'notifications', version: shared.ids.newToken().slice(0, 32) }),
  })
  const jobRunner = createJobRunner({
    companyIds: () => repos.companies.allIds(),
    occurrences: jobOccurrences,
    yieldNow: () => new Promise<void>(resolve => setImmediate(resolve)),
  })

  return { jobOccurrences, jobRunner }
}
