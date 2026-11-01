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
 * Read by the server, never taken from the app. Pins of open work keep their
 * versions listed for the apps (`pinnedVersions` → C2's distribution).
 */
import { isValidSkillName } from '../../shared/core/names'
import { parseAiRunProcedure } from '../../shared/core/ai-runs'
import {
  PLUGIN_CONTRACT_V2, companySkillOverrideProblem, comparePluginVersions,
  type PluginManifest, type PluginStep, type PluginStepProcedurePin,
} from '../../shared/core/plugins'
import { RECORD_ID_RE } from '../../shared/core/records'
import type { PluginStepOnRecord, PluginStepSkillsView, PluginStepStartView, PluginStepTurn, PluginStepView } from '../../shared/types/plugins'
import type { Clock } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { RecordRow } from '../ports/records'
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

export interface PluginStepDeps {
  companyData: CompanyDataSource
  clock: Clock
  shelf: Pick<PluginShelf, 'find' | 'isStopped'>
  /** The tree id of the company Skill `name` on the shared branch (lib/skill-trees.ts), or null. */
  skillTree: (companyId: string, name: string) => Promise<string | null>
  /** Absentees a member stands in for today (services/absences.ts). */
  actsFor: (companyId: string, userId: string) => string[]
}

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

  const stepView = (pluginId: string, name: string, step: PluginStep): PluginStepView => ({
    pluginId, step: name, label: step.label, start: step.start, procedure: step.procedure.default, tools: [...step.tools], connectorRoles: [...step.connectorRoles],
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
    return ok({
      steps: Object.entries(m.steps).map(([name, s]) => ({
        step: name, label: s.label, overridable: s.procedure.overridable, skill: Object.prototype.hasOwnProperty.call(chosen, name) ? chosen[name] : null,
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
      if (!inst || inst.step.start !== 'ai_turn' || !atStep(rec, inst.step) || !isMine(member, rec.fields)) return 'not-ai-turn'
      return 'yes'
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
      const pin = parseAiRunProcedure(run.procedure)?.pin
      if (!pin || pin.source !== 'plugin' || pin.version === inst.version) return inst.step
      const pinned = await pinnedVersionStep(companyId, pin, bound.step)
      return pinned === false ? false : narrowed(inst.step, pinned)
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
      for (const i of handle.plugins.installs()) {
        if (!i.enabled) continue
        const m = shelf.find(member.companyId, i.pluginId, i.version)?.pkg.manifest
        if (!m || m.role !== 'business' || m.contract < PLUGIN_CONTRACT_V2) continue
        for (const [name, step] of Object.entries(m.steps)) if (step.start === 'ai_turn') steps.push({ pluginId: i.pluginId, name, step })
      }
      if (steps.length === 0) return ok({ turns: [] })
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
          turns.push({ recordId: row.id, version: s?.version ?? 0, ...stepView(st.pluginId, st.name, st.step) })
        }
      }
      return ok({ turns: turns.slice(0, TURNS_SHOWN) })
    },

    /**
     * GET /me/plugin-steps/records/:recordId — the steps that apply to a record now (its card's
     * buttons; the app's automatic run reads its step here after the claim): each with the work's
     * pin (null before its first run) and the step it runs (narrowed by the pinned version).
     */
    stepsOn(member: Member, recordId: string): Outcome<{ steps: PluginStepOnRecord[] }> {
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
          out.push({ ...stepView(i.pluginId, name, on.step), pin: on.pin })
        }
      }
      return ok({ steps: out })
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
      return ok({ recordId, version: rec.version, pin: pinned.value.pin, ...stepView(pluginId, stepName, pinned.value.step) })
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
  }
}

export type PluginStepService = ReturnType<typeof createPluginStepService>
