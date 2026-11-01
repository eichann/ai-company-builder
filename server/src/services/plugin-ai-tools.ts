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
import type { PluginServiceDeps } from './plugin-service-common'

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
     */
    async aiTools(member: Member, scope: 'read' | 'act'): Promise<Outcome<PluginAiTools>> {
      const out: PluginAiTools['plugins'] = []
      for (const install of companyData.forCompany(member.companyId).plugins.installs()) {
        const evaluated = await evaluation.evaluate(member.companyId, install)
        if (!evaluated.active) continue
        const { manifest, mapping, types } = evaluated.active
        const operations: PluginAiOperation[] = []
        for (const [name, op] of Object.entries(manifest.operations)) {
          if (!op.who.includes('ai')) continue
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
