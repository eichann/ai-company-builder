/**
 * The AI's plugin tools (P7, plugins.md "The app (P7)"): which connector
 * operations of the running business plugins the member's AI may call, with
 * the fields it may write now or a create's policy and content slots. What
 * the member may do on a record is still decided per call (P6).
 */
import { effectiveFieldPolicy, effectiveOperationPolicy } from '../../shared/core/plugins'
import type { PluginCall, PluginCallRequest, PluginManifest, PluginStep } from '../../shared/core/plugins'
import type { PluginAiCall, PluginAiField, PluginAiOperation, PluginAiTools } from '../../shared/types/plugins'
import type { Member } from './access'
import { ok, type Outcome } from './outcome'
import type { PluginEvaluation } from './plugin-evaluation'
import { boundStepOf, parsePluginRunStep, stepAllowsCall, stepAllowsConnectorRole, stepAllowsOperation, stepOf, type RunStepOf } from './plugin-operation-checks'
import type { PluginServiceDeps } from './plugin-service-common'
import type { PluginShelf } from './plugin-shelf'

/**
 * The connector-role half of the business × operation gate (plan C4,
 * plugins.md "The gate of a step's run"): an AI whose token is bound to a run
 * of a business plugin's step may use only the connector roles (`mail.read`,
 * `calendar.read`…) that step declares, and only while the plugin is installed
 * here, on, on the shelf and not stopped by the operator. A consultation (no
 * run) or a core step (minutes reading) keeps what it had. Fails closed: a
 * run that cannot be read, or anything unknown, is refused. Lanes A / B call
 * it through `routes/record-ai-auth.ts` `connectorRoleRefusal` before an AI
 * route uses a role.
 */
export function createPluginRunGate(deps: Pick<PluginServiceDeps, 'companyData'> & { shelf: Pick<PluginShelf, 'find' | 'isStopped'>; runStepOf?: RunStepOf }) {
  const { companyData, shelf } = deps
  return {
    async allowsConnectorRole(member: Member, runId: string | null, role: string, conversationId: string | null = null): Promise<boolean> {
      const handle = companyData.forCompany(member.companyId)
      const run = boundStepOf(handle, member.userId, { runId, conversationId })
      if (run === null) return true
      if (run === 'missing') return false
      const bound = parsePluginRunStep(run.step)
      if (!bound) return true
      const install = handle.plugins.install(bound.pluginId)
      if (!install?.enabled) return false
      const manifest = shelf.find(member.companyId, bound.pluginId, install.version)?.pkg.manifest
      if (!manifest || manifest.role !== 'business' || await shelf.isStopped(bound.pluginId, install.version)) return false
      const installed = stepOf(manifest, bound.step)
      if (!installed) return false
      // The work's pinned version narrows the step (C5); its stop refuses everything.
      const step = deps.runStepOf ? await deps.runStepOf(member.companyId, run) : installed
      return step !== null && step !== false && stepAllowsConnectorRole(step, role)
    },
  }
}
export type PluginRunGate = ReturnType<typeof createPluginRunGate>

const inputsOf = (r: PluginCallRequest): PluginAiCall['inputs'] =>
  Object.entries(r.inputs).map(([name, i]) => ({ name, kind: i.kind, required: i.required, label: i.label }))

const toolsOfCall = (name: string, c: PluginCall): PluginAiCall[] => {
  if (c.kind === 'act') return []
  if (c.kind === 'read') return [{ name, part: null, label: c.label, inputs: inputsOf(c), cursor: false }]
  if (c.kind === 'search') return [{ name, part: null, label: c.label, inputs: inputsOf(c), cursor: c.cursor !== null }]
  return [
    { name, part: 'page' as const, label: c.label, inputs: inputsOf(c.page), cursor: false },
    ...(c.list ? [{ name, part: 'list' as const, label: c.label, inputs: inputsOf(c.list), cursor: c.list.cursor !== null }] : []),
    ...(c.search ? [{ name, part: 'search' as const, label: c.label, inputs: inputsOf(c.search), cursor: c.search.cursor !== null }] : []),
  ]
}

/**
 * The calls the member's AI may ask now: `mayCall` (the gate's own `who`, bound once), and
 * inside a consultation of a step `stepAllowsCall`, the gate's own rule. The gate still
 * decides each call.
 */
function aiCallsOf(manifest: Pick<PluginManifest, 'calls'>, step: PluginStep | null, mayCall: (who: string[]) => boolean): PluginAiCall[] {
  return Object.entries(manifest.calls ?? {})
    .filter(([name, c]) => mayCall(c.who) && (!step || stepAllowsCall(step, manifest, name)))
    .flatMap(([name, c]) => toolsOfCall(name, c))
}

/** Whether this member's AI passes a call's `who`. Until bound, no call is listed. */
export type AiCallAccess = (member: Member, pluginId: string, who: string[]) => boolean

export function createPluginAiTools(deps: Pick<PluginServiceDeps, 'companyData'> & { evaluation: Pick<PluginEvaluation, 'evaluate'> }) {
  const { companyData, evaluation } = deps
  let callAccess: AiCallAccess = () => false

  return {
    useCallAccess(f: AiCallAccess) { callAccess = f },

    /**
     * GET /api/records-ai/plugins (P7) — the operations of the running business
     * plugins' connector use the member's AI may call (the tool is named by the
     * business plugin, labelled by the outside system): only operations whose
     * `who` lists `ai`, and with a `read` token (Codex) no write at all. An
     * update lists the fields it may write now (`off` left out); a create
     * (milestone 4) its policy now (an `off` create is left out) and its
     * content slots, or — creating a record — the fields it may fill. Any
     * member: what they may do on a record is decided per call (P6).
     *
     * A token bound to a run of a business plugin's step (`runId`, plan C4)
     * sees only that plugin's operations its step allows (`stepAllowsOperation`,
     * the gate's own rule — the gate still decides each call); a run that
     * cannot be read sees none. A core step's run: reads only. An ordinary consultation: as before.
     * A contract-3 call is listed only where a person is there: never for a run.
     */
    async aiTools(member: Member, scope: 'read' | 'act', runId: string | null = null, conversationId: string | null = null): Promise<Outcome<PluginAiTools>> {
      const out: PluginAiTools['plugins'] = []
      const handle = companyData.forCompany(member.companyId)
      let bound: { pluginId: string; step: string } | null = null
      const run = boundStepOf(handle, member.userId, { runId, conversationId })
      if (run === 'missing') return ok({ plugins: [] })
      if (run) bound = parsePluginRunStep(run.step)
      // A core step's run lists a business plugin's reads only (the gate refuses the rest).
      const coreStep = run !== null && bound === null
      for (const install of handle.plugins.installs()) {
        if (bound && install.pluginId !== bound.pluginId) continue
        const evaluated = await evaluation.evaluate(member.companyId, install)
        if (!evaluated.active) continue
        const { manifest, mapping, types } = evaluated.active
        const step = bound ? stepOf(manifest, bound.step) : null
        if (bound && !step) continue
        const operations: PluginAiOperation[] = []
        for (const [name, op] of Object.entries(manifest.operations)) {
          if (!op.who.includes('ai')) continue
          if (step && !stepAllowsOperation(step, manifest, name)) continue
          if (op.kind !== 'read' && (scope !== 'act' || coreStep)) continue
          if (op.kind === 'create') {
            const policy = effectiveOperationPolicy(manifest, name, mapping)
            if (policy !== 'auto' && policy !== 'prior') continue
            const recordType = manifest.objects[op.attachTo ?? op.object]?.recordType
            const def = recordType ? types[recordType] : undefined
            if (!recordType || !def) continue
            const fields: PluginAiField[] = []
            if (op.createsRecord) {
              for (const [field, rule] of Object.entries(mapping.objects[op.object]?.fields ?? {})) {
                const f = def.fields[field]
                if (!rule.write || !f) continue
                fields.push({ name: field, label: f.label, kind: f.kind, ...(f.options ? { options: [...f.options] } : {}), ...(f.optionLabels ? { optionLabels: { ...f.optionLabels } } : {}), policy: 'prior' })
              }
            }
            operations.push({
              name, label: op.label, kind: 'create', recordType, decision: op.decision, fields,
              policy: op.createsRecord ? 'prior' : policy, content: Object.keys(op.content), createsRecord: op.createsRecord,
            })
            continue
          }
          const recordType = manifest.objects[op.object]?.recordType
          const def = recordType ? types[recordType] : undefined
          if (!recordType || !def) continue
          const fields: PluginAiField[] = []
          if (op.kind === 'update') {
            for (const [field, rule] of Object.entries(mapping.objects[op.object]?.fields ?? {})) {
              const f = def.fields[field]
              if (!rule.write || !f) continue
              const policy = effectiveFieldPolicy({ manifest, types }, mapping, name, field)
              if (policy !== 'auto' && policy !== 'prior') continue
              fields.push({ name: field, label: f.label, kind: f.kind, ...(f.options ? { options: [...f.options] } : {}), ...(f.optionLabels ? { optionLabels: { ...f.optionLabels } } : {}), policy })
            }
            if (fields.length === 0) continue
          }
          operations.push({ name, label: op.label, kind: op.kind, recordType, decision: op.decision, fields })
        }
        // An execution run is automatic: no person is there, so no call is listed (the gate refuses them too).
        const calls = runId ? [] : aiCallsOf(manifest, step, who => callAccess(member, install.pluginId, who))
        if (operations.length > 0 || calls.length > 0) out.push({ id: install.pluginId, label: manifest.label, operations, ...(calls.length > 0 ? { calls } : {}) })
      }
      return ok({ plugins: out })
    },
  }
}
