import type { PluginFieldValue, PluginOperationRecordView } from '../../shared/types/plugins'

/**
 * The chat's card for an outside system's write (milestone 3 P7,
 * `.claude/rules/plugins.md` "The app"): when the member's AI calls a
 * connector's update tool (`hubspot__update_deal`), main adds this record to
 * the reply as a data part; it is stored with the message
 * (`pluginOperations`), so the card — and its 「変更前の値を書き戻す」 button,
 * which the person presses with their own session — survives a restart.
 *
 * The outcome says only what is known (review §5.6): a write whose answer was
 * lost is `unknown`, a value seen in the outside system but not confirmed as
 * ACB's write is `observed`; neither is called a success.
 *
 * Milestone 4 adds creates (`hubspot__log_meeting`, `hubspot__create_deal`):
 * the card (`kind: 'create'`) shows what was made (title, time); a create
 * whose answer was lost is never re-sent — 「HubSpot で確かめてください」 and
 * 「もう一度確かめる」 (the server looks it up by ACB's correlation value); one
 * that needs approval says nothing was made yet.
 */
export const PLUGIN_OPERATION_PART_TYPE = 'data-plugin-operation'

export type PluginCardOutcome =
  /** ACB wrote it and confirmed it (state applied). */
  | 'applied'
  /** The outside system already held these values: nothing was sent. */
  | 'unchanged'
  /** ACB's rules refused it before sending (approval needed, not allowed, stopped…): nothing changed. */
  | 'refused'
  /** It could not be done (the outside system refused or could not be read): nothing changed. */
  | 'not-sent'
  /** Someone changed it first (in ACB or in the outside system): nothing changed. */
  | 'conflict'
  /** Sent, but whether it arrived is not known. */
  | 'unknown'
  /** The outside system shows these values, but ACB cannot confirm it wrote them. */
  | 'observed'

export interface PluginCardField {
  field: string
  label: string
  /** Known only for an applied write (from the ledger). */
  before?: PluginFieldValue
  after: PluginFieldValue
  /** For a conflict: the value there now. */
  current?: PluginFieldValue
  /** How this field's values are shown (a choice's labels from the type, e.g. a → A（高）). */
  valueLabels?: Record<string, string>
}

export interface PluginOperationCard {
  /** The card's own id (one per tool call). */
  id: string
  companyId: string
  conversationId: string | null
  pluginId: string
  /** The outside system's name (HubSpot). */
  systemLabel: string
  recordId: string
  recordTitle: string | null
  outcome: PluginCardOutcome
  /** Plain Japanese: what happened. */
  message: string
  /** The operation record, when there is one (undo / reconcile / refresh go by it). */
  operationId: string | null
  fields: PluginCardField[]
  /** The AI's reason (its note). */
  reason: string | null
  /** Who asked: the member's AI (the credential decided). */
  byAi: boolean
  undoable: boolean
  at: string
  /** update (default) or create (milestone 4). */
  kind?: 'update' | 'create'
  /** The server's word for undoing it (a create: 「作ったものを取り消す」). */
  undoLabel?: string
  /** Refused because a person must approve it first (APPROVAL_REQUIRED): nothing was sent. */
  needsApproval?: boolean
}

/** What the card always says next to an applied write (the server's UNDO_NOTICE, review §5.4). */
export const UNDO_NOTICE_FALLBACK = 'HubSpot のワークフローや通知など、変更のあとに HubSpot 側で起きたことは元に戻りません。'
export const UNDO_BUTTON_LABEL = '変更前の値を書き戻す'
/** Next to a create ACB made (the server's CREATE_UNDO_NOTICE). */
export const CREATE_UNDO_NOTICE_FALLBACK = 'HubSpot のごみ箱に移します。作ったあとに HubSpot 側で起きたこと（ワークフローや通知など）は元に戻りません。'
export const CREATE_UNDO_BUTTON_LABEL = '作ったものを取り消す'
/** The labels of a create's content (ACB words of `log_meeting`'s slots). */
export const CREATE_CONTENT_LABELS: Record<string, string> = { title: '件名', at: '日時', body: '内容', outcome: '結果' }

const REFUSAL_NOT_SENT = new Set(['WRITE_FAILED', 'OUTSIDE_UNAVAILABLE'])
const REFUSAL_CONFLICT = new Set(['VERSION_CONFLICT', 'CHANGED_OUTSIDE'])
/** The app could not tell whether the server (and through it the outside system) got the request. */
const REFUSAL_UNKNOWN = new Set(['OFFLINE', 'SERVER_ERROR'])

/** A refusal's code → outcome. Anything the app cannot place is `refused` only when the server said so (4xx). */
export function refusalOutcome(code: string): PluginCardOutcome {
  if (REFUSAL_NOT_SENT.has(code)) return 'not-sent'
  if (REFUSAL_CONFLICT.has(code)) return 'conflict'
  if (REFUSAL_UNKNOWN.has(code)) return 'unknown'
  return 'refused'
}

/** An operation record's state → outcome. */
export function stateOutcome(state: PluginOperationRecordView['state']): PluginCardOutcome {
  switch (state) {
    case 'applied': return 'applied'
    case 'observed': return 'observed'
    case 'failed': return 'not-sent'
    default: return 'unknown'
  }
}

/** The plain-Japanese line for an outcome (a refusal adds the server's own sentence). */
export function outcomeMessage(outcome: PluginCardOutcome, system: string, state?: PluginOperationRecordView['state']): string {
  switch (outcome) {
    case 'applied': return `${system} を更新しました。`
    case 'unchanged': return `${system} はすでにこの値でした。何も送っていません。`
    case 'refused': return '変更しませんでした。'
    case 'not-sent': return `${system} に書けませんでした。何も変わっていません。`
    case 'conflict': return '先にほかの変更があったため、変更しませんでした。最新の値を確かめてから、もう一度お願いしてください。'
    case 'unknown': return state === 'external-ok'
      ? `${system} は受け付けましたが、ACB の記録への反映を確かめられていません。`
      : `${system} に届いたか分かりません。自動で送り直すことはしません。${system} の画面で確かめるか、「もう一度確かめる」を押してください。`
    case 'observed': return `${system} はこの値になっていますが、ACB が書いたとは確かめられませんでした（同じ値をほかの人が入れた可能性があります）。このため書き戻しはできません。`
  }
}

/** The plain-Japanese line for a create's outcome (milestone 4). */
export function createOutcomeMessage(outcome: PluginCardOutcome, system: string, reason?: string | null): string {
  switch (outcome) {
    case 'applied': return `${system} に作りました。`
    case 'unchanged': return '何も作っていません。'
    case 'refused': return 'まだ作っていません。'
    case 'not-sent': return `${system} に作れませんでした。何も作っていません。`
    case 'conflict': return '先にほかの変更があったため、作っていません。'
    case 'unknown': return reason === 'not-found'
      ? `${system} で見つかりませんでした（無いとは限りません）。自動で作り直すことはしません。${system} で確かめてください。`
      : `${system} に作れたか分かりません。自動で作り直すことはしません。${system} で確かめてください（「もう一度確かめる」でも確かめられます）。`
    case 'observed': return `${system} にはありますが、ACB が作ったとは確かめられませんでした。`
  }
}

/** Server sentences are Japanese; an English one is a request-shape message meant for the AI, not the member. */
const forMember = (text: string | undefined): string | null => text && /[぀-ヿ一-鿿]/.test(text) ? text : null

export interface CardContext {
  id: string
  companyId: string
  conversationId: string | null
  pluginId: string
  systemLabel: string
  recordId: string
  /** ACB field name → its label. */
  labels: Record<string, string>
  /** ACB field name → value → how it is shown (choices; the server's answer may add more). */
  valueLabels?: Record<string, Record<string, string>>
  asked: Record<string, PluginFieldValue>
  reason: string | null
  byAi: boolean
  at: string
  /** update (default) or create. */
  kind?: 'update' | 'create'
}

const label = (ctx: Pick<CardContext, 'labels'>, field: string) => ctx.labels[field] ?? field
const isCreate = (ctx: Pick<CardContext, 'kind'>) => ctx.kind === 'create'

/** A card field with its label and, for a choice, how its values are shown. */
function cardField(ctx: Pick<CardContext, 'labels' | 'valueLabels'>, field: string, values: Omit<PluginCardField, 'field' | 'label' | 'valueLabels'>, server?: Record<string, Record<string, string>>): PluginCardField {
  const shown = server?.[field] ?? ctx.valueLabels?.[field]
  return { field, label: label(ctx, field), ...values, ...(shown && Object.keys(shown).length > 0 ? { valueLabels: { ...shown } } : {}) }
}

/** The card for a successful answer of the server (`{ operation, record }`). */
export function cardFromAnswer(ctx: CardContext, answer: { operation: PluginOperationRecordView | null; record?: { id: string } }): PluginOperationCard {
  const op = answer.operation
  const base = {
    id: ctx.id, companyId: ctx.companyId, conversationId: ctx.conversationId, pluginId: ctx.pluginId, systemLabel: ctx.systemLabel, recordId: ctx.recordId,
    reason: ctx.reason, byAi: ctx.byAi, at: ctx.at, ...(isCreate(ctx) ? { kind: 'create' as const } : {}),
  }
  if (!op) {
    return { ...base, recordTitle: null, outcome: 'unchanged', message: isCreate(ctx) ? createOutcomeMessage('unchanged', ctx.systemLabel) : outcomeMessage('unchanged', ctx.systemLabel), operationId: null, undoable: false,
      fields: Object.entries(ctx.asked).map(([field, after]) => cardField(ctx, field, { after })) }
  }
  const outcome = stateOutcome(op.state)
  // A create shows what it carries (title, time…), never its long body.
  const created = isCreate(ctx) || op.kind === 'create'
  const fields: PluginCardField[] = op.changes && !created
    ? op.changes.map(c => cardField(ctx, c.field, { before: c.before, after: c.after }, op.valueLabels))
    : Object.entries(op.fields).filter(([field]) => !created || field !== 'body').map(([field, after]) => cardField(ctx, field, { after }, op.valueLabels))
  const message = created ? createOutcomeMessage(outcome, ctx.systemLabel, op.reason) : outcomeMessage(outcome, ctx.systemLabel, op.state)
  return {
    ...base, ...(created ? { kind: 'create' as const, undoLabel: op.undoLabel } : {}), recordId: op.recordId ?? ctx.recordId,
    recordTitle: op.recordTitle, outcome, message, operationId: op.id, undoable: op.undoable, fields,
  }
}

/** The card for a refusal (or a failure to reach the server). */
export function cardFromRefusal(ctx: CardContext, code: string, error: string | undefined, details: Record<string, unknown> = {}): PluginOperationCard {
  const outcome = refusalOutcome(code)
  const operation = details.operation as PluginOperationRecordView | undefined
  const current = details.current && typeof details.current === 'object' ? details.current as Record<string, PluginFieldValue> : {}
  const said = outcome === 'refused' || outcome === 'conflict' ? forMember(error) : null
  const created = isCreate(ctx)
  const message = outcome === 'refused' && said
    ? `${created ? '作っていません' : '変更しませんでした'}。${said}`
    : created ? createOutcomeMessage(outcome, ctx.systemLabel) : outcomeMessage(outcome, ctx.systemLabel)
  return {
    id: ctx.id, companyId: ctx.companyId, conversationId: ctx.conversationId, pluginId: ctx.pluginId, systemLabel: ctx.systemLabel, recordId: ctx.recordId,
    recordTitle: operation?.recordTitle ?? null, outcome, message, operationId: operation?.id ?? null, reason: ctx.reason, byAi: ctx.byAi, undoable: false, at: ctx.at,
    ...(created ? { kind: 'create' as const } : {}), ...(code === 'APPROVAL_REQUIRED' ? { needsApproval: true } : {}),
    fields: Object.entries(ctx.asked).filter(([field]) => !created || field !== 'body')
      .map(([field, after]) => cardField(ctx, field, { after, ...(field in current ? { current: current[field] } : {}) }, operation?.valueLabels)),
  }
}

/**
 * What the AI is told (it must not claim more than the card): the outcome
 * in words it relays, never "updated" unless it was applied.
 */
export function aiSummaryOf(card: PluginOperationCard): Record<string, unknown> {
  const told: Record<PluginCardOutcome, string> = {
    applied: 'Written and confirmed. Tell the member it was updated; a person can press 「変更前の値を書き戻す」 on the card.',
    unchanged: 'Nothing was sent: the outside system already had these values.',
    refused: 'Not written: refused before sending. Nothing changed. Explain why in plain words; do not retry the same request.',
    'not-sent': 'Not written: nothing changed.',
    conflict: 'Not written: someone changed it first. Read the record again (records_get) and ask the member before trying again.',
    unknown: 'Result UNKNOWN: it may or may not have been written. Do NOT say it succeeded and do NOT send it again; tell the member to check.',
    observed: 'The outside system shows these values, but ACB cannot confirm it wrote them. Do NOT say it succeeded.',
  }
  let told1 = told[card.outcome]
  if (card.needsApproval) {
    told1 = 'Not done: a person must approve this first (APPROVAL_REQUIRED). Nothing was sent. Tell the member it needs approval; do not retry or work around it.'
  } else if (card.kind === 'create') {
    if (card.outcome === 'applied') told1 = 'Created and confirmed. Tell the member it was created; a person can press 「作ったものを取り消す」 on the card.'
    if (card.outcome === 'unknown') told1 = 'Result UNKNOWN: it may or may not have been created. Do NOT say it was created and NEVER call the tool again for it (that could make a duplicate); tell the member to check in the outside system or press 「もう一度確かめる」.'
  }
  // Values as the member sees them on the card (「A（高）」, not `a`); the raw value stays for the next call.
  const fields = card.fields.map(f => ({
    field: f.field, label: f.label,
    ...(f.before !== undefined ? { before: f.before, beforeShown: shownValue(f.before, f.valueLabels) } : {}),
    after: f.after, afterShown: shownValue(f.after, f.valueLabels),
    ...(f.current !== undefined ? { current: f.current, currentShown: shownValue(f.current, f.valueLabels) } : {}),
  }))
  return {
    outcome: card.outcome, message: card.message, instruction: `${told1} Say the values as shown (…Shown) and call the record by its title; keep ids out of the reply unless asked.`,
    recordTitle: card.recordTitle, operationId: card.operationId, fields,
  }
}

const OUTCOMES = new Set<PluginCardOutcome>(['applied', 'unchanged', 'refused', 'not-sent', 'conflict', 'unknown', 'observed'])
const isValue = (v: unknown): v is PluginFieldValue => v === null || ['string', 'number', 'boolean'].includes(typeof v)
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** A stored / streamed card, validated (undefined when malformed). */
export function readPluginOperationCard(data: unknown): PluginOperationCard | undefined {
  if (!data || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  // recordId may be empty: a create of a record that was not made.
  if (!str(d.id, 200) || !str(d.companyId, 200) || !str(d.pluginId, 40) || !str(d.systemLabel, 100) || typeof d.recordId !== 'string' || d.recordId.length > 80 || !str(d.message, 2000) || !str(d.at, 40)) return undefined
  if (!OUTCOMES.has(d.outcome as PluginCardOutcome) || !Array.isArray(d.fields) || d.fields.length > 30) return undefined
  const fields: PluginCardField[] = []
  for (const f of d.fields as unknown[]) {
    if (!f || typeof f !== 'object') return undefined
    const x = f as Record<string, unknown>
    if (!str(x.field, 60) || !str(x.label, 100) || !isValue(x.after)) return undefined
    if (x.before !== undefined && !isValue(x.before)) return undefined
    if (x.current !== undefined && !isValue(x.current)) return undefined
    const shown = x.valueLabels && typeof x.valueLabels === 'object' && !Array.isArray(x.valueLabels)
      ? Object.entries(x.valueLabels as Record<string, unknown>).filter((e): e is [string, string] => str(e[1], 100)).slice(0, 50)
      : []
    fields.push({
      field: x.field, label: x.label, after: x.after, ...(x.before !== undefined ? { before: x.before as PluginFieldValue } : {}), ...(x.current !== undefined ? { current: x.current as PluginFieldValue } : {}),
      ...(shown.length > 0 ? { valueLabels: Object.fromEntries(shown) } : {}),
    })
  }
  return {
    id: d.id, companyId: d.companyId, conversationId: typeof d.conversationId === 'string' ? d.conversationId : null, pluginId: d.pluginId, systemLabel: d.systemLabel,
    recordId: d.recordId, recordTitle: typeof d.recordTitle === 'string' ? d.recordTitle : null, outcome: d.outcome as PluginCardOutcome, message: d.message,
    operationId: typeof d.operationId === 'string' && d.operationId.length <= 100 ? d.operationId : null, fields,
    reason: typeof d.reason === 'string' ? d.reason.slice(0, 2000) : null, byAi: d.byAi === true, undoable: d.undoable === true, at: d.at,
    ...(d.kind === 'create' ? { kind: 'create' as const } : {}),
    ...(typeof d.undoLabel === 'string' && d.undoLabel.length > 0 && d.undoLabel.length <= 40 ? { undoLabel: d.undoLabel } : {}),
    ...(d.needsApproval === true ? { needsApproval: true } : {}),
  }
}

export const PLUGIN_OPERATIONS_OFFLINE_TEXT = 'サーバーに接続できないため、いまは操作できません（オフラインの可能性があります）。'

/** The answer of the card's own actions (IPC `pluginOperations:*`), sent with the person's session. */
export type PluginOperationResult =
  | { success: true; operation: PluginOperationRecordView }
  | { success: false; offline: boolean; code: string | null; error: string; current?: Record<string, PluginFieldValue> }

/** What the card shows after the person's 「変更前の値を書き戻す」 or 「もう一度確かめる」. */
export interface CardActionView {
  /** The undo / reconcile is settled: hide its button. */
  done: boolean
  tone: 'ok' | 'warn' | 'error'
  message: string
  /** For a refusal because the outside system changed meanwhile: the values there now. */
  current?: Array<{ label: string; value: PluginFieldValue }>
  /** A create the outside system did not show (reconcile: not found): 「もう一度作る」 may be offered. */
  recreatable?: boolean
}

/** The button for a create reconciling did not find (the server's `recreatable`). */
export const RECREATE_BUTTON_LABEL = 'もう一度作る'
/** The server answers this, with its warning, until the person confirms. */
export const RECREATE_NEEDS_CONFIRMATION = 'RECREATE_NEEDS_CONFIRMATION'

/** The undo's answer, in the card's words. */
export function undoResultView(card: Pick<PluginOperationCard, 'systemLabel' | 'fields' | 'kind'>, result: PluginOperationResult): CardActionView {
  const sys = card.systemLabel
  const labelOf = (field: string) => card.fields.find(f => f.field === field)?.label ?? field
  const shownOf = (field: string, value: PluginFieldValue) => shownValue(value, card.fields.find(f => f.field === field)?.valueLabels)
  if (result.success) {
    const op = result.operation
    if (op.state === 'applied') return { done: true, tone: 'ok', message: card.kind === 'create' ? `${sys} のごみ箱に移しました。` : `変更前の値を ${sys} に書き戻しました。` }
    if (op.state === 'failed') return { done: false, tone: 'error', message: `${sys} に書けませんでした。何も変わっていません。` }
    // The undo's own answer was lost: not known to have happened (never claimed).
    return { done: true, tone: 'warn', message: `書き戻しが ${sys} に届いたか分かりません。${sys} の画面で確かめてください。` }
  }
  if (result.offline) return { done: false, tone: 'warn', message: `${result.error} 書き戻せたかどうかは分かりません。もう一度押すと、サーバーが確かめてから書き戻します。` }
  switch (result.code) {
    case 'CHANGED_OUTSIDE': return {
      done: true, tone: 'warn', message: `${sys} 側でそのあとに変わっているため、書き戻していません。`,
      current: Object.entries(result.current ?? {}).map(([field, value]) => ({ label: labelOf(field), value: shownOf(field, value) })),
    }
    case 'NOT_UNDOABLE': return { done: true, tone: 'warn', message: result.error }
    default: return { done: false, tone: 'error', message: result.error }
  }
}

/** The reconcile's answer (a write whose answer was lost), in the card's words. */
export function reconcileResultView(card: Pick<PluginOperationCard, 'systemLabel' | 'kind'>, result: PluginOperationResult): CardActionView {
  if (!result.success) return { done: false, tone: result.offline ? 'warn' : 'error', message: result.error }
  const outcome = stateOutcome(result.operation.state)
  const message = card.kind === 'create' || result.operation.kind === 'create'
    ? createOutcomeMessage(outcome, card.systemLabel, result.operation.reason)
    : outcomeMessage(outcome, card.systemLabel, result.operation.state)
  return {
    done: outcome !== 'unknown', tone: outcome === 'observed' ? 'warn' : outcome === 'unknown' ? 'warn' : 'ok', message,
    ...(result.operation.recreatable === true ? { recreatable: true } : {}),
  }
}

/** 「もう一度作る」's answer (after the person confirmed), in the card's words: what the new create did. */
export function recreateResultView(card: Pick<PluginOperationCard, 'systemLabel'>, result: PluginOperationResult): CardActionView {
  if (!result.success) return { done: false, tone: result.offline ? 'warn' : 'error', message: result.error }
  const outcome = stateOutcome(result.operation.state)
  const message = outcome === 'applied' ? `もう一度作りました。${card.systemLabel} で二つになっていないか確かめてください。` : createOutcomeMessage(outcome, card.systemLabel, result.operation.reason)
  return { done: true, tone: outcome === 'applied' ? 'ok' : outcome === 'not-sent' ? 'error' : 'warn', message }
}

/** A field value as the card shows it: a choice by its label when the type gives one. */
export function shownValue(v: PluginFieldValue | undefined, valueLabels?: Record<string, string>): string {
  if (v === undefined || v === null || v === '') return '（空）'
  if (typeof v === 'boolean') return v ? 'はい' : 'いいえ'
  if (typeof v === 'string' && valueLabels && Object.prototype.hasOwnProperty.call(valueLabels, v)) return valueLabels[v]
  return String(v)
}
