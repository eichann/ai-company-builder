/**
 * Field and operation policies at run time (0.21; milestone 4 for approvers):
 * who approves a `prior` request (`approverFor`), the policy that applies to
 * a written field (`effectiveFieldPolicy`) and to a create
 * (`effectiveOperationPolicy`) — never `auto` where the declaration's rules
 * forbid it, whatever is stored — and the one rule that depends on the value
 * written: a move to or from a closing stage asks first (`closingMoveFields`).
 */
import { stricterApprover, type ApproverSpec } from './approvals'
import { CLOSING_FIELDS, asksFirst, moneyField, writeAsksFirst, type FieldPolicy, type PluginManifest } from './plugin-declaration'
import type { TypeDefinition } from './record-types'
import { DEFAULT_APPROVERS, type PluginMapping } from './plugin-mapping'
import { acbToExternal, type AcbValue } from './plugin-values'

/**
 * Who approves a request to run `operationName` with these ACB values
 * (update: the fields asked; create: none) — the strictest of the fields'
 * approvers; a move to or from a closing stage (`closing`: the fields
 * `closingMoveFields` names, or `stage` asked to a closing value) needs at
 * least a department manager (design §9 q2/q3). Only asked for `prior`
 * fields / operations.
 */
export function approverFor(
  manifest: PluginManifest, mapping: PluginMapping, operationName: string, fields: Record<string, AcbValue>, closing: readonly string[] = [],
): ApproverSpec {
  const op = manifest.operations[operationName]
  if (op?.kind === 'create') return mapping.approvalBy[operationName] ?? (op.createsRecord ? 'self' : 'dept_manager')
  let rule: ApproverSpec | null = null
  for (const [field, value] of Object.entries(fields)) {
    let r: ApproverSpec = mapping.approvalBy[field] ?? DEFAULT_APPROVERS[field] ?? 'dept_manager'
    const closes = closing.includes(field) || (CLOSING_FIELDS.includes(field) && typeof value === 'string' && mapping.closingStages.includes(value))
    if (closes) r = stricterApprover(r, 'dept_manager')
    rule = rule === null ? r : stricterApprover(rule, r)
  }
  return rule ?? 'dept_manager'
}

/**
 * The policy that applies when operation `operationName` writes `field`:
 * `off` unless the mapping writes it, else the company's choice, else the
 * declaration's default, else `prior` — and at least as strict as any other
 * field read from the same outside property; never `auto` for a closing
 * field (`CLOSING_FIELDS`) while the mapping names no `closing_stages`, for a write that asks first (`writeAsksFirst`: an
 * operation that reaches people outside the company or moves money, or a
 * money field — `money: true` on the type), whatever the settings say (0.21).
 */
export function effectiveFieldPolicy(
  pkg: { manifest: PluginManifest; types: Record<string, Pick<TypeDefinition, 'fields'>> }, mapping: PluginMapping, operationName: string, field: string,
): FieldPolicy {
  const { manifest } = pkg
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
    if ((closingUnknown(mapping, other) || moneyField(pkg, op.object, other)) && theirs === 'auto') theirs = 'prior'
    if (POLICY_STRICTNESS[theirs] > POLICY_STRICTNESS[chosen]) chosen = theirs
  }
  return (writeAsksFirst(pkg, operationName, field) || closingUnknown(mapping, field)) && chosen === 'auto' ? 'prior' : chosen
}

/** A closing field whose closing values the mapping does not name: it cannot be told apart, so it asks first. */
const closingUnknown = (mapping: Pick<PluginMapping, 'closingStages'>, field: string) => CLOSING_FIELDS.includes(field) && mapping.closingStages.length === 0

/**
 * The outside properties a write moves to or from a closing stage (owner decision 2026-11-06):
 * for every closing field (`CLOSING_FIELDS`, i.e. `stage`) the mapping reads on `objectName`, a
 * written property that is its outside property, when the value written stands for one of
 * `closing_stages` (through that field's `values`) or the record's current value of the field is
 * one. Judged on the outside property, so another field mapped to the same property (div's 確度 on
 * HubSpot's `dealstage`) cannot move a deal to won without asking. `outside`: the raw values to
 * write (property → value); `current`: the record's ACB values now.
 */
export function closingMoveProperties(
  mapping: PluginMapping, objectName: string, outside: Record<string, unknown>, current: Record<string, unknown>,
): string[] {
  if (mapping.closingStages.length === 0) return []
  const fields = mapping.objects[objectName]?.fields ?? {}
  const out = new Set<string>()
  for (const [name, rule] of Object.entries(fields)) {
    if (!CLOSING_FIELDS.includes(name) || !Object.prototype.hasOwnProperty.call(outside, rule.from)) continue
    const raw = outside[rule.from]
    const to = rule.values ? (typeof raw === 'string' || typeof raw === 'number' ? rule.values[String(raw)] : undefined) : raw
    const from = current[name]
    if ((typeof to === 'string' && mapping.closingStages.includes(to)) || (typeof from === 'string' && mapping.closingStages.includes(from))) out.add(rule.from)
  }
  return [...out]
}

/**
 * The asked fields of an update whose write moves to or from a closing stage
 * (`closingMoveProperties` over what each would write). A value with no
 * translation is left to the translation's own refusal.
 */
export function closingMoveFields(
  pkg: { manifest: PluginManifest; types: Record<string, TypeDefinition> }, mapping: PluginMapping, operationName: string,
  asked: Record<string, AcbValue>, current: Record<string, unknown>,
): string[] {
  const op = pkg.manifest.operations[operationName]
  if (!op || op.kind !== 'update' || mapping.closingStages.length === 0) return []
  const rules = mapping.objects[op.object]?.fields ?? {}
  const outside: Record<string, string> = {}
  for (const [field, value] of Object.entries(asked)) {
    const t = acbToExternal(pkg, mapping, op.object, { [field]: value })
    if (t.ok) Object.assign(outside, t.properties)
  }
  const props = closingMoveProperties(mapping, op.object, outside, current)
  return Object.keys(asked).filter(f => rules[f] && props.includes(rules[f].from))
}

const POLICY_STRICTNESS: Record<FieldPolicy, number> = { auto: 0, prior: 1, off: 2 }

/**
 * An operation's own policy (create): the company's choice in the mapping,
 * else the declaration's; never `auto` when it reaches outside people, moves money or
 * creates a record (create_deal), whatever is stored.
 */
export function effectiveOperationPolicy(manifest: PluginManifest, operationName: string, mapping?: Pick<PluginMapping, 'policy'> | null): FieldPolicy {
  const op = manifest.operations[operationName]
  if (!op) return 'off'
  const chosen = (op.kind === 'create' ? mapping?.policy[operationName] : undefined) ?? op.policy
  return asksFirst(op) && chosen === 'auto' ? 'prior' : chosen
}
