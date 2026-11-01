/**
 * Field and operation policies at run time (0.21; milestone 4 for approvers):
 * who approves a `prior` request (`approverFor`), the policy that applies to
 * a written field (`effectiveFieldPolicy`) and to a create
 * (`effectiveOperationPolicy`) — never `auto` where the declaration's rules
 * forbid it, whatever is stored.
 */
import { stricterApprover, type ApproverRule } from './approvals'
import { PRIOR_ONLY_FIELDS, type FieldPolicy, type PluginManifest } from './plugin-declaration'
import { DEFAULT_APPROVERS, type PluginMapping } from './plugin-mapping'
import type { AcbValue } from './plugin-values'

/**
 * Who approves a request to run `operationName` with these ACB values
 * (update: the fields asked; create: none) — the strictest of the fields'
 * approvers; moving `stage` to a closing stage needs at least a department
 * manager (design §9 q2/q3). Only asked for `prior` fields / operations.
 */
export function approverFor(manifest: PluginManifest, mapping: PluginMapping, operationName: string, fields: Record<string, AcbValue>): ApproverRule {
  const op = manifest.operations[operationName]
  if (op?.kind === 'create') return mapping.approvalBy[operationName] ?? (op.createsRecord ? 'self' : 'dept_manager')
  let rule: ApproverRule | null = null
  for (const [field, value] of Object.entries(fields)) {
    let r = mapping.approvalBy[field] ?? DEFAULT_APPROVERS[field] ?? 'dept_manager'
    if (field === 'stage' && typeof value === 'string' && mapping.closingStages.includes(value)) r = stricterApprover(r, 'dept_manager')
    rule = rule === null ? r : stricterApprover(rule, r)
  }
  return rule ?? 'dept_manager'
}

/**
 * The policy that applies when operation `operationName` writes `field`:
 * `off` unless the mapping writes it, else the company's choice, else the
 * declaration's default, else `prior` — and at least as strict as any other
 * field read from the same outside property; never `auto` for
 * `PRIOR_ONLY_FIELDS` nor for an operation that reaches people outside the
 * company, whatever the settings say (0.21).
 */
export function effectiveFieldPolicy(manifest: PluginManifest, mapping: PluginMapping, operationName: string, field: string): FieldPolicy {
  const op = manifest.operations[operationName]
  if (!op || op.kind !== 'update') return 'off'
  const rule = mapping.objects[op.object]?.fields[field]
  if (!rule?.write) return 'off'
  // Judged on the outside property written, not only the ACB field (review §5.3): every field read
  // from the same property brings its own policy, and the strictest wins (a field another field
  // reads as `prior` cannot be reached through an `auto` one).
  let chosen: FieldPolicy = mapping.policy[field] ?? manifest.fieldPolicyDefaults[field] ?? 'prior'
  for (const [other, r] of Object.entries(mapping.objects[op.object]?.fields ?? {})) {
    if (other === field || r.from !== rule.from) continue
    let theirs: FieldPolicy = mapping.policy[other] ?? manifest.fieldPolicyDefaults[other] ?? 'prior'
    if (PRIOR_ONLY_FIELDS.includes(other) && theirs === 'auto') theirs = 'prior'
    if (POLICY_STRICTNESS[theirs] > POLICY_STRICTNESS[chosen]) chosen = theirs
  }
  return (op.reaches === 'external' || PRIOR_ONLY_FIELDS.includes(field)) && chosen === 'auto' ? 'prior' : chosen
}

const POLICY_STRICTNESS: Record<FieldPolicy, number> = { auto: 0, prior: 1, off: 2 }

/**
 * An operation's own policy (create): the company's choice in the mapping,
 * else the declaration's; never `auto` when it reaches outside people or
 * creates a record (create_deal), whatever is stored.
 */
export function effectiveOperationPolicy(manifest: PluginManifest, operationName: string, mapping?: Pick<PluginMapping, 'policy'> | null): FieldPolicy {
  const op = manifest.operations[operationName]
  if (!op) return 'off'
  const chosen = (op.kind === 'create' ? mapping?.policy[operationName] : undefined) ?? op.policy
  return (op.reaches === 'external' || op.createsRecord) && chosen === 'auto' ? 'prior' : chosen
}
