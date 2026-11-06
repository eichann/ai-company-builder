/**
 * A business plugin's steps as work (plan C5 「プラグインの手順で AI の番を自動で
 * 進める」, `.claude/rules/plugin-steps.md`).
 *
 * - **Where a step applies**: a record of the step's `for.type` in `for.state`
 *   (contract 2, the installed version, the company switch on). `start:
 *   ai_turn` steps are the member's 「AI の番」 when they are its assignee or
 *   next actor (or cover them during an absence, `actsFor`) — what an
 *   execution run named `<pluginId>__<step>` may be claimed for
 *   (services/ai-runs.ts); `start: person` steps are a button on the card
 *   that opens a consultation (`startPerson`).
 * - **Pinned per work** (owner decision 2026-11-01 night): the step's first
 *   run for a record pins its procedure — the plugin's at the installed
 *   version + fingerprint, or, when the step is `overridable` and the company
 *   chose one of its Skills for it, that Skill by its tree id on the shared
 *   branch. Later runs of that work use the pin; it moves to a newer installed
 *   version only at that version's `upgrade.at` points (from `upgrade.from`
 *   on). The operator's stop of the pinned version (or of the installed one)
 *   stops the work: nothing pinned outlives a stop.
 * - **The ceiling**: the step's `tools` / `connector_roles` of the installed
 *   version, narrowed by the pinned version's — a company Skill never adds
 *   any, and an older pin never widens what the installed version allows.
 *
 * - **Starting by itself** (owner decisions 2026-11-06): a company may choose 「自動で始める」 for a
 *   `start: person` step (`plugin_step_settings`; the button by default). It is then the member's
 *   「AI の番」 only after a meeting of the record was read (`plugin_step_requests`, answered by the
 *   run that finishes), with the automatic ceiling: nothing that reaches outside
 *   (`automaticStepCeiling`). The declaration never changes.
 * - **The deliverable folder**: the step's folder under `<department>/.personal/` — the company's
 *   setting, else from its label — is handed to the app, which lets the step write only there.
 *
 * Read by the server, never taken from the app. Pins of open work keep their
 * versions listed for the apps (`pinnedVersions` → C2's distribution).
 */
import { isValidSkillName } from '../../shared/core/names'
import { parseAiRunProcedure } from '../../shared/core/ai-runs'
import {
  PLUGIN_CONTRACT_V2, companySkillOverrideProblem, comparePluginVersions,
  type PluginManifest, type PluginStep, type PluginStepProcedurePin,
} from '../../shared/core/plugins'
import { MEETING_BUNDLE_LINKED_ACTION } from '../../shared/core/minutes'
import { automaticStepCeiling, deliverableFolderOf, deliverableFolderProblem } from '../../shared/core/plugin-step-runs'
import { RECORD_ID_RE } from '../../shared/core/records'
import type { PluginStepContinuationView, PluginStepOnRecord, PluginStepSkillsView, PluginStepStartView, PluginStepTurn, PluginStepView } from '../../shared/types/plugins'
import type { Clock } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { RecordRow } from '../ports/records'
import type { ActorInput } from './record-engine/types'
import { requireFullAccess, type Member } from './access'
import type { AiTurnCheck } from './ai-runs'
import { ok, refuse, type Outcome } from './outcome'
import { parsePluginRunStep, stepOf } from './plugin-operation-checks'
import { PLUGIN_NOT_FOUND, PLUGINS_FORBIDDEN } from './plugin-service-common'
import type { PluginShelf } from './plugin-shelf'
import { recordReader } from './record-access'
import { currentTypes } from './record-index'

export const PLUGIN_STEP_NOT_FOUND = { error: 'この手順はありません', code: 'PLUGIN_STEP_NOT_FOUND' } as const
export const NOT_AT_STEP = { error: 'この記録はいま、この手順の状態ではありません', code: 'NOT_AT_STEP' } as const
export const PROCEDURE_STOPPED = { error: 'この手順は運用担当者が止めています', code: 'PROCEDURE_STOPPED' } as const
export const PROCEDURE_UNAVAILABLE = {
  error: 'この仕事が使う手順の版がもう使えません。運用担当者に確かめてもらってください', code: 'PROCEDURE_UNAVAILABLE',
} as const
export const STEP_SKILL_MISSING = {
  error: '会社のスキルが見つかりません。.claude/skills/ に置いて同期してから、もう一度ためしてください', code: 'STEP_SKILL_MISSING',
} as const
const RECORDS_DISABLED = { error: 'この会社では記録の機能が有効になっていません', code: 'RECORDS_DISABLED' } as const
const RECORD_NOT_FOUND = { error: '記録が見つかりません', code: 'RECORD_NOT_FOUND' } as const
/** Work listed per call (a member's 「AI の番」 of plugin steps). */
const TURNS_SHOWN = 500
/** A やること in these states waits for nobody: no 「続きをする」. */
const CLOSED_TASK_STATES: readonly string[] = ['done', 'cancelled', 'dismissed']

export interface PluginStepDeps {
  companyData: CompanyDataSource
  clock: Clock
  shelf: Pick<PluginShelf, 'find' | 'isStopped'>
  /** The tree id of the company Skill `name` on the shared branch (lib/skill-trees.ts), or null. */
  skillTree: (companyId: string, name: string) => Promise<string | null>
  /** Absentees a member stands in for today (services/absences.ts). */
  actsFor: (companyId: string, userId: string) => string[]
  /** The record engine's action (its `who`, `mayAct`, compare-and-set): how a meeting read moves its まとまり. */
  act?: (member: Member, actor: ActorInput, recordId: string, action: string, body: unknown) => Promise<Outcome<unknown>>
}

/**
 * The meeting's changes after which its まとまり moves: its reading finished, or a まとまり linked to
 * a meeting already read without one (the minutes service tells only that first link; the meeting
 * stays read, minutes.md "A まとまり chosen later").
 */
const MEETING_READ_ACTIONS: readonly string[] = ['finish_reading', MEETING_BUNDLE_LINKED_ACTION]

interface InstalledStep {
  manifest: PluginManifest
  version: string
  fingerprint: string
  step: PluginStep
}

/** The step's ceiling: the installed declaration, narrowed by the pinned one (never widened). */
function narrowed(installed: PluginStep, pinned: PluginStep | null): PluginStep {
  if (!pinned) return installed
  return {
    ...pinned,
    tools: installed.tools.filter(t => pinned.tools.includes(t)),
    connectorRoles: installed.connectorRoles.filter(r => pinned.connectorRoles.includes(r)),
  }
}

const parseFields = (raw: string | undefined): Record<string, unknown> => {
  try { return raw ? JSON.parse(raw) as Record<string, unknown> : {} } catch { return {} }
}

export function createPluginStepService(deps: PluginStepDeps) {
  const { companyData, clock, shelf } = deps
  const repo = (companyId: string) => companyData.forCompany(companyId).pluginSteps

  /** The installed, switched-on contract-2 business plugin's step, or null. */
  function installedStep(companyId: string, pluginId: string, stepName: string): InstalledStep | null {
    if (typeof pluginId !== 'string' || pluginId.length > 40 || typeof stepName !== 'string' || stepName.length > 40) return null
    const install = companyData.forCompany(companyId).plugins.install(pluginId)
    if (!install?.enabled) return null
    const found = shelf.find(companyId, pluginId, install.version)
    const m = found?.pkg.manifest
    if (!found || !m || m.role !== 'business' || m.contract < PLUGIN_CONTRACT_V2 || found.fingerprint !== install.fingerprint) return null
    const step = stepOf(m, stepName)
    return step ? { manifest: m, version: install.version, fingerprint: found.fingerprint, step } : null
  }

  /** A record the member may read, with its state now; null when not (unreadable = missing). */
  function readable(member: Member, recordId: string): { row: RecordRow; state: string; fields: Record<string, unknown>; version: number } | null {
    if (typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId)) return null
    const handle = companyData.forCompany(member.companyId)
    const row = handle.records.byIds([recordId])[0]
    if (!row || row.removedAt !== null || !recordReader(member, handle.scopes.listWithRules()).record(row)) return null
    const s = handle.records.states([recordId])[0]
    return { row, state: s?.state ?? '', fields: parseFields(s?.fields), version: s?.version ?? 0 }
  }

  /** The company's setting of a step (absent: the button, the folder from the label). */
  const settingOf = (companyId: string, pluginId: string, name: string) =>
    repo(companyId).stepSettings(pluginId)[name] ?? { autoStart: false, deliverableFolder: null }
  /** A `start: person` step the company starts by itself. */
  const startsByItself = (companyId: string, pluginId: string, name: string, step: PluginStep) =>
    step.start === 'person' && settingOf(companyId, pluginId, name).autoStart

  /**
   * 「続きをする」 (owner decision 2026-11-06, option B): the newest open やること linked to the record
   * (or the やること itself) that carries a preparation and was **made by a run** of a business
   * plugin's `start: person` step on that record — only an automatic run makes one (a person's
   * consultation has no run). Marked by what is already kept: the task's first ledger entry's
   * `runId` and that run's step. Offered only while the record is at the step's state, the step
   * installed and the member may read both.
   */
  function continuationOf(member: Member, rec: { row: RecordRow; state: string; fields: Record<string, unknown> }): PluginStepContinuationView | null {
    const handle = companyData.forCompany(member.companyId)
    const isTask = rec.row.type === 'task'
    const bundleId = isTask
      ? handle.records.linksFrom([rec.row.id]).find(l => l.name === 'bundle' && l.targetId !== null)?.targetId ?? null
      : rec.row.id
    if (!bundleId) return null
    const bundle = isTask ? readable(member, bundleId) : rec
    if (!bundle) return null
    const taskIds = isTask ? [rec.row.id] : handle.records.linksTo([bundleId]).filter(l => l.name === 'bundle').map(l => l.sourceId)
    const found: Array<{ view: PluginStepContinuationView; at: string }> = []
    for (const taskId of [...new Set(taskIds)].slice(0, 200)) {
      const task = taskId === rec.row.id ? rec : readable(member, taskId)
      if (!task || task.row.type !== 'task' || CLOSED_TASK_STATES.includes(task.state)) continue
      const prep = task.fields.prep_summary
      if (typeof prep !== 'string' || prep.trim() === '') continue
      const runId = handle.records.ledger(taskId)[0]?.runId
      const run = runId ? handle.aiRuns.byId(runId) : null
      const bound = run ? parsePluginRunStep(run.step) : null
      if (!run || !bound || run.recordId !== bundleId) continue
      const inst = installedStep(member.companyId, bound.pluginId, bound.step)
      if (!inst || inst.step.start !== 'person' || !atStep(bundle, inst.step)) continue
      found.push({ view: { recordId: bundleId, pluginId: bound.pluginId, step: bound.step, label: inst.step.label, taskId }, at: task.row.updatedAt })
    }
    found.sort((a, b) => b.at.localeCompare(a.at))
    return found[0]?.view ?? null
  }

  const atStep = (rec: { row: RecordRow; state: string }, step: PluginStep) => rec.row.type === step.for.type && rec.state === step.for.state
  const turnPeople = (member: Member) => [member.userId, ...deps.actsFor(member.companyId, member.userId)]
  const isMine = (member: Member, fields: Record<string, unknown>) => {
    const ids = turnPeople(member)
    return ids.includes(fields.assignee as string) || ids.includes(fields.next_actor as string)
  }

  /** The pinned version's step when it may still run; false when the pin may not run now. */
  async function pinnedVersionStep(companyId: string, pin: Extract<PluginStepProcedurePin, { source: 'plugin' }>, stepName: string): Promise<PluginStep | false> {
    const found = shelf.find(companyId, pin.pluginId, pin.version)
    if (!found || found.fingerprint !== pin.fingerprint) return false
    if (await shelf.isStopped(pin.pluginId, pin.version)) return false
    return stepOf(found.pkg.manifest, stepName) ?? false
  }

  /**
   * The procedure a work runs for a step (pinning it at the first run) and
   * the step's ceiling. `rec` is the record as the caller read it now.
   */
  async function pinFor(
    member: Member, rec: { row: RecordRow; state: string }, pluginId: string, stepName: string, depth = 0,
  ): Promise<Outcome<{ pin: PluginStepProcedurePin; step: PluginStep }>> {
    const inst = installedStep(member.companyId, pluginId, stepName)
    if (!inst) return refuse('not-found', PLUGIN_STEP_NOT_FOUND.error, { code: PLUGIN_STEP_NOT_FOUND.code })
    // The operator's stop of the installed version stops every work of the plugin, pinned or not.
    if (await shelf.isStopped(pluginId, inst.version)) return refuse('conflict', PROCEDURE_STOPPED.error, { code: PROCEDURE_STOPPED.code })
    const r = repo(member.companyId)
    const at = clock.now()
    const existing = r.pin(rec.row.id, pluginId, stepName)
    if (existing) {
      const pin = existing.pin
      if (pin.source === 'company_skill') return ok({ pin, step: inst.step })
      if (pin.version === inst.version) {
        if (pin.fingerprint !== inst.fingerprint) return refuse('conflict', PROCEDURE_UNAVAILABLE.error, { code: PROCEDURE_UNAVAILABLE.code })
        return ok({ pin, step: inst.step })
      }
      // An upgrade point of the installed version: the work moves to it here.
      const up = inst.manifest.upgrade
      if (up && comparePluginVersions(pin.version, up.from) >= 0 && comparePluginVersions(pin.version, inst.version) < 0
        && up.at.some(p => p.type === rec.row.type && p.state === rec.state)) {
        const next: PluginStepProcedurePin = { source: 'plugin', pluginId, version: inst.version, fingerprint: inst.fingerprint }
        if (r.movePin(rec.row.id, pluginId, stepName, pin, next, at)) return ok({ pin: next, step: inst.step })
        return depth < 2 ? pinFor(member, rec, pluginId, stepName, depth + 1) : refuse('conflict', PROCEDURE_UNAVAILABLE.error, { code: PROCEDURE_UNAVAILABLE.code })
      }
      const pinned = await pinnedVersionStep(member.companyId, pin, stepName)
      if (pinned === false) return refuse('conflict', PROCEDURE_STOPPED.error, { code: PROCEDURE_STOPPED.code })
      return ok({ pin, step: narrowed(inst.step, pinned) })
    }
    // The first run: the company's Skill when it chose one for an overridable step, else the plugin's procedure.
    let pin: PluginStepProcedurePin = { source: 'plugin', pluginId, version: inst.version, fingerprint: inst.fingerprint }
    const skill = r.stepSkills(pluginId)[stepName]
    if (skill && inst.step.procedure.overridable && isValidSkillName(skill)) {
      const tree = await deps.skillTree(member.companyId, skill)
      if (!tree) return refuse('conflict', STEP_SKILL_MISSING.error, { code: STEP_SKILL_MISSING.code })
      pin = { source: 'company_skill', skill, fingerprint: tree }
    }
    if (r.insertPin({ recordId: rec.row.id, pluginId, step: stepName, pin, pinnedAt: at, updatedAt: at })) return ok({ pin, step: inst.step })
    // Another PC's first run won: use what it pinned.
    return depth < 2 ? pinFor(member, rec, pluginId, stepName, depth + 1) : refuse('conflict', PROCEDURE_UNAVAILABLE.error, { code: PROCEDURE_UNAVAILABLE.code })
  }

  const stepView = (companyId: string, pluginId: string, name: string, step: PluginStep): PluginStepView => ({
    pluginId, step: name, label: step.label, start: step.start, procedure: step.procedure.default, tools: [...step.tools], connectorRoles: [...step.connectorRoles],
    deliverableFolder: deliverableFolderOf(name, step.label, settingOf(companyId, pluginId, name).deliverableFolder),
  })

  /** A record's pin of a step (none before its first run) and the step it runs: the installed one narrowed by the pinned version's. */
  function pinnedOn(companyId: string, recordId: string, pluginId: string, name: string, installed: PluginStep): { pin: PluginStepProcedurePin | null; step: PluginStep } {
    const pin = repo(companyId).pin(recordId, pluginId, name)?.pin ?? null
    if (!pin || pin.source !== 'plugin') return { pin, step: installed }
    const found = shelf.find(companyId, pin.pluginId, pin.version)
    const pinned = found && found.fingerprint === pin.fingerprint ? stepOf(found.pkg.manifest, name) : null
    return { pin, step: narrowed(installed, pinned) }
  }

  /** GET /plugins/:pluginId/step-skills — owner / admin: each step, whether it is overridable, the company's Skill. */
  function stepSkills(member: Member, pluginId: string): Outcome<PluginStepSkillsView> {
    const allowed = requireFullAccess(member, PLUGINS_FORBIDDEN)
    if (!allowed.ok) return allowed
    const m = installedManifest(member.companyId, pluginId)
    if (!m) return refuse('not-found', PLUGIN_NOT_FOUND.error, { code: PLUGIN_NOT_FOUND.code })
    const chosen = repo(member.companyId).stepSkills(pluginId)
    const settings = repo(member.companyId).stepSettings(pluginId)
    const own = <T>(o: Record<string, T>, k: string): T | null => Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null
    return ok({
      steps: Object.entries(m.steps).map(([name, s]) => ({
        step: name, label: s.label, overridable: s.procedure.overridable, skill: own(chosen, name),
        start: s.start, autoStart: s.start === 'person' && (own(settings, name)?.autoStart ?? false),
        deliverableFolder: deliverableFolderOf(name, s.label, own(settings, name)?.deliverableFolder),
        deliverableFolderChosen: own(settings, name)?.deliverableFolder ?? null,
      })),
    })
  }

  /** The installed business plugin's declaration (any switch position), or null. */
  function installedManifest(companyId: string, pluginId: string): PluginManifest | null {
    const install = typeof pluginId === 'string' && pluginId.length <= 40 ? companyData.forCompany(companyId).plugins.install(pluginId) : null
    const m = install ? shelf.find(companyId, pluginId, install.version)?.pkg.manifest : undefined
    return m && m.role === 'business' ? m : null
  }

  return {
    stepSkills,

    /**
     * After a meeting became `read`, or its まとまり was chosen after the reading (the record
     * engine's after-act, plan C5; the minutes service's link): its まとまり moves to
     * a business plugin's `ai_turn` step, so that step (e.g. 「会議を案件に反映する」) becomes the
     * AI's turn. The まとまり's type must be one an enabled contract-2 business plugin has an
     * `ai_turn` step for; exactly one action of that type must lead there (`to` = a step's state,
     * the current state in `from`, `ai` in `who`). It runs as the same AI for the member who read
     * the meeting or chose its まとまり (the engine's `who` / `mayAct` apply), its note naming the meeting (not an owner-only or members-only one). Zero or two
     * or more such actions, already at a step's state, no permission or a version conflict →
     * nothing: no guessing. The core never names a business operation (owner rule).
     */
    async afterAct(member: Member, actor: ActorInput, done: { recordId: string; type: string; action: string; toState: string | null }): Promise<void> {
      if (done.type !== 'meeting' || done.toState !== 'read' || !MEETING_READ_ACTIONS.includes(done.action) || !deps.act) return
      const handle = companyData.forCompany(member.companyId)
      const bundleId = handle.records.linksFrom([done.recordId]).find(l => l.name === 'bundle' && l.targetId)?.targetId
      const bundle = bundleId ? readable(member, bundleId) : null
      if (!bundleId || !bundle) return
      // A person's step the company starts by itself is asked for now; it runs once the まとまり is at its state.
      for (const i of handle.plugins.installs()) {
        if (!i.enabled) continue
        const m = shelf.find(member.companyId, i.pluginId, i.version)?.pkg.manifest
        if (!m || m.role !== 'business' || m.contract < PLUGIN_CONTRACT_V2) continue
        for (const [name, step] of Object.entries(m.steps)) {
          if (step.for.type !== bundle.row.type || !startsByItself(member.companyId, i.pluginId, name, step)) continue
          repo(member.companyId).request({ recordId: bundleId, pluginId: i.pluginId, step: name, at: clock.now(), meetingId: done.recordId })
        }
      }
      const states = new Set<string>()
      for (const i of handle.plugins.installs()) {
        if (!i.enabled) continue
        const m = shelf.find(member.companyId, i.pluginId, i.version)?.pkg.manifest
        if (!m || m.role !== 'business' || m.contract < PLUGIN_CONTRACT_V2 || await shelf.isStopped(i.pluginId, i.version)) continue
        for (const step of Object.values(m.steps)) if (step.start === 'ai_turn' && step.for.type === bundle.row.type) states.add(step.for.state)
      }
      if (states.size === 0 || states.has(bundle.state)) return
      const def = currentTypes(handle.records).get(bundle.row.type)?.definition
      const moves = Object.entries(def?.actions ?? {}).filter(([, a]) =>
        a.to !== null && a.to !== undefined && states.has(a.to) && (a.from?.includes(bundle.state) ?? false) && a.who.includes('ai'))
      if (moves.length !== 1) return
      const row = handle.records.byIds([done.recordId])[0]
      // The まとまり's readers see this note: an owner-only or members-only meeting is not named there
      // (records.md "Members-only records" — its title and id stay with its own readers).
      const restricted = !row || row.personalOwner !== null || row.members !== null
      const note = restricted ? '会議を読んだあと' : `会議「${row.title.slice(0, 80)}」（${done.recordId}）を読んだあと`.slice(0, 200)
      // A person's choice moves it as their AI too: the step it leads to is the AI's turn.
      const ai: ActorInput = actor.kind === 'ai' ? actor : { kind: 'ai', conversationId: null, runId: null }
      await deps.act(member, ai, bundleId, moves[0][0], { expectedVersion: bundle.version, note })
    },

    /**
     * Whether a record is in the member's 「AI の番」 for a plugin step's run
     * (`<pluginId>__<step>`): readable, at the step's state, the step `start:
     * ai_turn`, the member (or whom they cover) its assignee or next actor.
     */
    turnOf(member: Member, recordId: string, runStep: string): AiTurnCheck {
      if (!companyData.forCompany(member.companyId).records.settings().enabled) return 'disabled'
      const rec = readable(member, recordId)
      if (!rec) return 'not-found'
      const bound = parsePluginRunStep(runStep)
      const inst = bound ? installedStep(member.companyId, bound.pluginId, bound.step) : null
      if (!inst || !atStep(rec, inst.step) || !isMine(member, rec.fields)) return 'not-ai-turn'
      if (inst.step.start === 'ai_turn') return 'yes'
      // A person's step: only when the company starts it by itself and a meeting asked for it.
      return bound && startsByItself(member.companyId, bound.pluginId, bound.step, inst.step)
        && repo(member.companyId).openRequest(recordId, bound.pluginId, bound.step) ? 'yes' : 'not-ai-turn'
    },

    /** A run of a plugin step finished as done: it answers the request that started it (a later meeting's stays open). */
    afterDoneRun(member: Member, run: { recordId: string; step: string; createdAt: string }): void {
      const bound = parsePluginRunStep(run.step)
      if (bound) repo(member.companyId).answerRequest(run.recordId, bound.pluginId, bound.step, run.createdAt, clock.now())
    },

    /** The pin a claim of `<pluginId>__<step>` runs with (pinned now when it is the work's first run). */
    async pinForRun(member: Member, recordId: string, runStep: string): Promise<Outcome<PluginStepProcedurePin>> {
      const bound = parsePluginRunStep(runStep)
      const rec = readable(member, recordId)
      if (!bound || !rec) return refuse('not-found', PLUGIN_STEP_NOT_FOUND.error, { code: PLUGIN_STEP_NOT_FOUND.code })
      const r = await pinFor(member, rec, bound.pluginId, bound.step)
      return r.ok ? ok(r.value.pin) : r
    },

    /**
     * The step a run-bound token may use (the C4 gate): the installed step,
     * narrowed by the run's pinned version; null when the run is not a plugin
     * step's; false when its pinned version may not run now (stopped, gone).
     */
    async stepOfRun(companyId: string, run: { step: string; procedure: string | null }): Promise<PluginStep | null | false> {
      const bound = parsePluginRunStep(run.step)
      if (!bound) return null
      const inst = installedStep(companyId, bound.pluginId, bound.step)
      if (!inst) return false
      // A run of a `start: person` step is always the automatic one: nothing that reaches outside.
      const ceiling = (s: PluginStep) => s.start === 'person' || inst.step.start === 'person' ? automaticStepCeiling(s) : s
      const pin = parseAiRunProcedure(run.procedure)?.pin
      if (!pin || pin.source !== 'plugin' || pin.version === inst.version) return ceiling(inst.step)
      const pinned = await pinnedVersionStep(companyId, pin, bound.step)
      return pinned === false ? false : ceiling(narrowed(inst.step, pinned))
    },

    /**
     * GET /me/plugin-step-turns — the member's 「AI の番」 of plugin steps:
     * records at a `start: ai_turn` step's state, readable, the member (or
     * whom they cover) its assignee or next actor.
     */
    turns(member: Member): Outcome<{ turns: PluginStepTurn[] }> {
      const handle = companyData.forCompany(member.companyId)
      if (!handle.records.settings().enabled) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const steps: Array<{ pluginId: string; name: string; step: PluginStep }> = []
      const byItself: Array<{ pluginId: string; name: string; step: PluginStep }> = []
      for (const i of handle.plugins.installs()) {
        if (!i.enabled) continue
        const m = shelf.find(member.companyId, i.pluginId, i.version)?.pkg.manifest
        if (!m || m.role !== 'business' || m.contract < PLUGIN_CONTRACT_V2) continue
        for (const [name, step] of Object.entries(m.steps)) {
          if (step.start === 'ai_turn') steps.push({ pluginId: i.pluginId, name, step })
          else if (startsByItself(member.companyId, i.pluginId, name, step)) byItself.push({ pluginId: i.pluginId, name, step })
        }
      }
      // A person's step the company starts by itself: the records a meeting asked it for, at its state, the member's.
      const asked: PluginStepTurn[] = []
      for (const st of byItself) {
        for (const recordId of handle.pluginSteps.openRequests(st.pluginId, st.name)) {
          const rec = readable(member, recordId)
          if (!rec || !atStep(rec, st.step) || !isMine(member, rec.fields)) continue
          asked.push({ recordId, version: rec.version, ...stepView(member.companyId, st.pluginId, st.name, automaticStepCeiling(st.step)), auto: true })
        }
      }
      if (steps.length === 0) return ok({ turns: asked.slice(0, TURNS_SHOWN) })
      const ids = turnPeople(member)
      const reader = recordReader(member, handle.scopes.listWithRules())
      const types = [...new Set(steps.map(s => s.step.for.type))]
      const statesWanted = [...new Set(steps.map(s => s.step.for.state))]
      const seen = new Set<string>()
      const rows = ['assignee', 'next_actor']
        .flatMap(field => handle.records.candidates({ types, states: statesWanted, fields: [{ name: field, values: ids }] }, TURNS_SHOWN))
        .filter(r => !seen.has(r.id) && (seen.add(r.id), true) && reader.record(r))
      const states = new Map(handle.records.states(rows.map(r => r.id)).map(s => [s.recordId, s]))
      const turns: PluginStepTurn[] = []
      for (const row of rows) {
        const s = states.get(row.id)
        for (const st of steps) {
          if (row.type !== st.step.for.type || (s?.state ?? '') !== st.step.for.state) continue
          turns.push({ recordId: row.id, version: s?.version ?? 0, ...stepView(member.companyId, st.pluginId, st.name, st.step) })
        }
      }
      return ok({ turns: [...turns, ...asked].slice(0, TURNS_SHOWN) })
    },

    /**
     * GET /me/plugin-steps/records/:recordId — the steps that apply to a record now (its card's
     * buttons; the app's automatic run reads its step here after the claim): each with the work's
     * pin (null before its first run) and the step it runs (narrowed by the pinned version); and
     * `continuation` — where an automatic run of a person's step prepared something (「続きをする」).
     */
    stepsOn(member: Member, recordId: string): Outcome<{ steps: PluginStepOnRecord[]; continuation: PluginStepContinuationView | null }> {
      if (!companyData.forCompany(member.companyId).records.settings().enabled) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const rec = readable(member, recordId)
      if (!rec) return refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
      const out: PluginStepOnRecord[] = []
      for (const i of companyData.forCompany(member.companyId).plugins.installs()) {
        if (!i.enabled) continue
        const m = shelf.find(member.companyId, i.pluginId, i.version)?.pkg.manifest
        if (!m || m.role !== 'business' || m.contract < PLUGIN_CONTRACT_V2) continue
        for (const [name, step] of Object.entries(m.steps)) {
          if (!atStep(rec, step)) continue
          const on = pinnedOn(member.companyId, recordId, i.pluginId, name, step)
          out.push({ ...stepView(member.companyId, i.pluginId, name, on.step), pin: on.pin })
        }
      }
      return ok({ steps: out, continuation: continuationOf(member, rec) })
    },

    /**
     * POST /me/plugin-steps/records/:recordId/:pluginId/:step/start — a
     * person starts a `start: person` step: the record must be readable and
     * at the step's state. Pins the work's procedure (its first run) and
     * answers it with the step's ceiling; the app opens a consultation with it.
     */
    async startPerson(member: Member, recordId: string, pluginId: string, stepName: string): Promise<Outcome<PluginStepStartView>> {
      if (!companyData.forCompany(member.companyId).records.settings().enabled) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const rec = readable(member, recordId)
      if (!rec) return refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
      const inst = installedStep(member.companyId, pluginId, stepName)
      if (!inst || inst.step.start !== 'person') return refuse('not-found', PLUGIN_STEP_NOT_FOUND.error, { code: PLUGIN_STEP_NOT_FOUND.code })
      if (!atStep(rec, inst.step)) return refuse('conflict', NOT_AT_STEP.error, { code: NOT_AT_STEP.code })
      const pinned = await pinFor(member, rec, pluginId, stepName)
      if (!pinned.ok) return pinned
      return ok({ recordId, version: rec.version, pin: pinned.value.pin, ...stepView(member.companyId, pluginId, stepName, pinned.value.step) })
    },

    /**
     * POST /me/plugin-steps/consultations { conversationId, recordId, pluginId, step } — the
     * member's consultation opened from a person's start (coordinator decision 2026-11-02): its
     * AI keeps the member's ordinary consultation tools, but its plugin power is that step's —
     * the C4 gate treats every token of this consultation like the step's run (its plugin's
     * operations the step allows, its connector roles, narrowed by the pinned version; a company
     * Skill never widens it). For good: a consultation is bound once and never unbound or rebound.
     * Only a `start: person` step whose work was started (pinned) on a record the member reads.
     */
    bindConsultation(member: Member, body: unknown): Outcome<{ bound: true }> {
      const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : null
      const conversationId = b?.conversationId
      if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 200 || /[\u0000-\u001f\u007f]/.test(conversationId)) { // eslint-disable-line no-control-regex
        return refuse('bad-request', 'conversationId is required (1–200 characters)')
      }
      if (typeof b?.recordId !== 'string' || typeof b.pluginId !== 'string' || typeof b.step !== 'string') return refuse('bad-request', 'recordId, pluginId and step are names')
      const { recordId, pluginId, step } = b as { recordId: string; pluginId: string; step: string }
      const rec = readable(member, recordId)
      if (!rec) return refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
      const inst = installedStep(member.companyId, pluginId, step)
      const r = repo(member.companyId)
      if (!inst || inst.step.start !== 'person' || !r.pin(recordId, pluginId, step)) {
        return refuse('not-found', PLUGIN_STEP_NOT_FOUND.error, { code: PLUGIN_STEP_NOT_FOUND.code })
      }
      if (r.bindConsultation({ userId: member.userId, conversationId, recordId, pluginId, step, at: clock.now() })) return ok({ bound: true })
      const was = r.consultationStep(member.userId, conversationId)
      if (was && was.recordId === recordId && was.pluginId === pluginId && was.step === step) return ok({ bound: true })
      return refuse('conflict', 'この相談はもう別の手順のための相談です', { code: 'CONSULTATION_BOUND' })
    },

    /**
     * GET /me/plugin-steps/consultations/:conversationId — the step the member's consultation is
     * bound to, with its deliverable folder (the app lets that consultation write only there), or
     * null: not bound, someone else's, another company's — one answer.
     */
    consultationOf(member: Member, conversationId: string): Outcome<{ step: { recordId: string; pluginId: string; step: string; deliverableFolder: string } | null }> {
      if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 200) return ok({ step: null })
      const bound = repo(member.companyId).consultationStep(member.userId, conversationId)
      if (!bound) return ok({ step: null })
      const inst = installedStep(member.companyId, bound.pluginId, bound.step)
      // The plugin turned off or gone: the folder from the step's name (writes stay narrow).
      const folder = deliverableFolderOf(bound.step, inst?.step.label ?? bound.step, settingOf(member.companyId, bound.pluginId, bound.step).deliverableFolder)
      return ok({ step: { ...bound, deliverableFolder: folder } })
    },

    /**
     * Versions some open work of the company is pinned to (C2's
     * `pinnedVersions`): pins whose record still exists and is not in a final
     * state of its type.
     */
    pinnedVersions(companyId: string, pluginId: string): Array<{ version: string; fingerprint: string }> {
      const handle = companyData.forCompany(companyId)
      const pins = handle.pluginSteps.pluginPins(pluginId)
      if (pins.length === 0) return []
      const recordIds = [...new Set(pins.map(p => p.recordId))]
      const rows = new Map(handle.records.byIds(recordIds).map(r => [r.id, r]))
      const states = new Map(handle.records.states(recordIds).map(s => [s.recordId, s.state ?? '']))
      const types = currentTypes(handle.records)
      const out = new Map<string, { version: string; fingerprint: string }>()
      for (const p of pins) {
        const row = rows.get(p.recordId)
        if (!row || row.removedAt !== null) continue
        if (types.get(row.type)?.definition.final.includes(states.get(p.recordId) ?? '')) continue
        out.set(`${p.version}\n${p.fingerprint}`, { version: p.version, fingerprint: p.fingerprint })
      }
      return [...out.values()]
    },

    /**
     * PUT /plugins/:pluginId/step-skills/:step { skill: name | null } — owner /
     * admin: the company's Skill for an overridable step (null: the plugin's
     * own). The Skill must be on the shared branch. Work already pinned keeps
     * its pin; only work whose first run comes later uses the change.
     */
    async setStepSkill(member: Member, pluginId: string, stepName: string, body: unknown): Promise<Outcome<PluginStepSkillsView>> {
      const allowed = requireFullAccess(member, PLUGINS_FORBIDDEN)
      if (!allowed.ok) return allowed
      const m = installedManifest(member.companyId, pluginId)
      if (!m) return refuse('not-found', PLUGIN_NOT_FOUND.error, { code: PLUGIN_NOT_FOUND.code })
      if (typeof body !== 'object' || body === null || !('skill' in body)) return refuse('bad-request', 'skill is a Skill name or null')
      const skill = (body as { skill: unknown }).skill
      if (skill !== null && typeof skill !== 'string') return refuse('bad-request', 'skill is a Skill name or null')
      if (!stepOf(m, stepName)) return refuse('not-found', PLUGIN_STEP_NOT_FOUND.error, { code: PLUGIN_STEP_NOT_FOUND.code })
      if (skill !== null) {
        const problem = companySkillOverrideProblem(m, stepName, skill)
        if (problem) return refuse('bad-request', problem, { code: 'STEP_NOT_OVERRIDABLE' })
        if (!await deps.skillTree(member.companyId, skill)) return refuse('conflict', STEP_SKILL_MISSING.error, { code: STEP_SKILL_MISSING.code })
      }
      repo(member.companyId).setStepSkill(pluginId, stepName, skill, clock.now(), member.userId)
      return stepSkills(member, pluginId)
    },

    /**
     * PUT /plugins/:pluginId/step-settings/:step { autoStart?: boolean, deliverableFolder?: name | null } —
     * owner / admin: how the company runs a step. `autoStart` only for a `start: person` step (400
     * `STEP_NOT_PERSON`; an `ai_turn` step starts by itself already); the folder one folder name
     * (400 `DELIVERABLE_FOLDER_INVALID`), null = from the step's label. A value left out is kept.
     */
    setStepSettings(member: Member, pluginId: string, stepName: string, body: unknown): Outcome<PluginStepSkillsView> {
      const allowed = requireFullAccess(member, PLUGINS_FORBIDDEN)
      if (!allowed.ok) return allowed
      const m = installedManifest(member.companyId, pluginId)
      if (!m) return refuse('not-found', PLUGIN_NOT_FOUND.error, { code: PLUGIN_NOT_FOUND.code })
      const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : null
      if (!b || Object.keys(b).some(k => k !== 'autoStart' && k !== 'deliverableFolder') || Object.keys(b).length === 0) {
        return refuse('bad-request', 'autoStart (true / false) and / or deliverableFolder (a folder name or null)')
      }
      if (b.autoStart !== undefined && typeof b.autoStart !== 'boolean') return refuse('bad-request', 'autoStart is true or false')
      const step = stepOf(m, stepName)
      if (!step) return refuse('not-found', PLUGIN_STEP_NOT_FOUND.error, { code: PLUGIN_STEP_NOT_FOUND.code })
      if (b.autoStart === true && step.start !== 'person') {
        return refuse('bad-request', 'この手順はもともと自動で始まります', { code: 'STEP_NOT_PERSON' })
      }
      if (b.deliverableFolder !== undefined && b.deliverableFolder !== null) {
        const problem = deliverableFolderProblem(b.deliverableFolder)
        if (problem) return refuse('bad-request', problem, { code: 'DELIVERABLE_FOLDER_INVALID' })
      }
      const was = settingOf(member.companyId, pluginId, stepName)
      repo(member.companyId).setStepSetting(pluginId, stepName, {
        autoStart: b.autoStart === undefined ? was.autoStart : b.autoStart,
        deliverableFolder: b.deliverableFolder === undefined ? was.deliverableFolder : b.deliverableFolder as string | null,
      }, clock.now(), member.userId)
      return stepSkills(member, pluginId)
    },
  }
}

export type PluginStepService = ReturnType<typeof createPluginStepService>
