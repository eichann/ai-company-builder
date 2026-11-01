/**
 * The AI's plugin tools (P7, plugins.md "The app (P7)"): which connector
 * operations of the running business plugins the member's AI may call, with
 * the fields it may write now or a create's policy and content slots. What
 * the member may do on a record is still decided per call (P6).
 */
import { effectiveFieldPolicy, effectiveOperationPolicy } from '../../shared/core/plugins'
import type { PluginAiField, PluginAiOperation, PluginAiTools } from '../../shared/types/plugins'
import type { Member } from './access'
import { ok, type Outcome } from './outcome'
import type { PluginEvaluation } from './plugin-evaluation'
import { parsePluginRunStep, stepAllowsConnectorRole, stepAllowsOperation, stepOf, type RunStepOf } from './plugin-operation-checks'
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
    async allowsConnectorRole(member: Member, runId: string | null, role: string): Promise<boolean> {
      if (!runId) return true
      const handle = companyData.forCompany(member.companyId)
      const run = handle.aiRuns.byId(runId)
      if (!run) return false
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

export function createPluginAiTools(deps: Pick<PluginServiceDeps, 'companyData'> & { evaluation: Pick<PluginEvaluation, 'evaluate'> }) {
  const { companyData, evaluation } = deps

  return {
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
     * cannot be read sees none. A consultation or a core step: as before.
     */
    async aiTools(member: Member, scope: 'read' | 'act', runId: string | null = null): Promise<Outcome<PluginAiTools>> {
      const out: PluginAiTools['plugins'] = []
      const handle = companyData.forCompany(member.companyId)
      let bound: { pluginId: string; step: string } | null = null
      if (runId) {
        const run = handle.aiRuns.byId(runId)
        if (!run) return ok({ plugins: [] })
        bound = parsePluginRunStep(run.step)
      }
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
          if (op.kind !== 'read' && scope !== 'act') continue
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
              const policy = effectiveFieldPolicy(manifest, mapping, name, field)
              if (policy !== 'auto' && policy !== 'prior') continue
              fields.push({ name: field, label: f.label, kind: f.kind, ...(f.options ? { options: [...f.options] } : {}), ...(f.optionLabels ? { optionLabels: { ...f.optionLabels } } : {}), policy })
            }
            if (fields.length === 0) continue
          }
          operations.push({ name, label: op.label, kind: op.kind, recordType, decision: op.decision, fields })
        }
        if (operations.length > 0) out.push({ id: install.pluginId, label: manifest.label, operations })
      }
      return ok({ plugins: out })
    },
  }
}
