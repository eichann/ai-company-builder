/**
 * Reading the body of a typed operation (plugins.md "Typed operations",
 * "Creates"): a create attached to a record (`{ title, body, at, outcome }` →
 * the declared content slots), a create of a record (`{ title, fields }` →
 * the mapping's outside properties) and the note / reason. Pure: nothing is
 * read or written here.
 */
import { acbToExternal, type AcbValue, type CreateContentSlot, type PluginOperation } from '../../shared/core/plugins'
import { isObj, type OperationActor } from './plugin-operation-common'
import { refuse, type Outcome } from './outcome'
import type { ActivePlugin } from './plugins'

const NOTE_MAX = 2000
export const TITLE_MAX = 200
const BODY_MAX = 20_000
const OUTCOME_MAX = 100

/** The ACB words of a create attached to a record (`{ title, body, at, outcome }`) → the declared outside properties. */
export function attachedInput(op: PluginOperation, b: Record<string, unknown>): { ok: true; fields: Record<string, AcbValue>; properties: Record<string, string> } | { ok: false; error: string } {
  const fields: Record<string, AcbValue> = {}
  const properties: Record<string, string> = {}
  for (const [slot, property] of Object.entries(op.content) as Array<[CreateContentSlot, string]>) {
    const v = b[slot]
    if (slot === 'title') {
      if (typeof v !== 'string' || v.trim() === '' || v.length > TITLE_MAX) return { ok: false, error: `title: 1–${TITLE_MAX} characters` }
      fields.title = v.normalize('NFC'); properties[property] = fields.title
    } else if (slot === 'body') {
      if (v !== undefined && (typeof v !== 'string' || v.length > BODY_MAX)) return { ok: false, error: `body: up to ${BODY_MAX} characters` }
      fields.body = typeof v === 'string' ? v.normalize('NFC') : ''; properties[property] = fields.body as string
    } else if (slot === 'at') {
      const ms = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? Date.parse(v) : NaN
      if (!Number.isFinite(ms)) return { ok: false, error: 'at: an ISO date and time (2026-11-05T15:00:00+09:00)' }
      fields.at = new Date(ms).toISOString(); properties[property] = String(ms)
    } else if (v !== undefined && v !== null) {
      if (typeof v !== 'string' || v.trim() === '' || v.length > OUTCOME_MAX) return { ok: false, error: `outcome: up to ${OUTCOME_MAX} characters` }
      fields.outcome = v; properties[property] = v
    }
  }
  return { ok: true, fields, properties }
}

/** A create of a record: `{ title, fields }` (ACB words) → the outside properties (title through the mapping's `title.from`). */
export function recordInput(plugin: ActivePlugin, op: PluginOperation, b: Record<string, unknown>): { ok: true; fields: Record<string, AcbValue>; properties: Record<string, string> } | { ok: false; error: string; errors?: string[] } {
  if (typeof b.title !== 'string' || b.title.trim() === '' || b.title.length > TITLE_MAX) return { ok: false, error: `title: 1–${TITLE_MAX} characters` }
  const titleFrom = plugin.mapping.objects[op.object]?.fields.title?.from
  if (!titleFrom) return { ok: false, error: '読み替え表に件名（title）の項目がありません' }
  const asked = b.fields === undefined ? {} : b.fields
  if (!isObj(asked) || Object.keys(asked).length > 30 || 'title' in asked || 'summary' in asked) return { ok: false, error: 'fields: { <field>: value } (up to 30; not title)' }
  const translated = acbToExternal({ manifest: plugin.manifest, types: plugin.types }, plugin.mapping, op.object, asked as Record<string, AcbValue>)
  if (!translated.ok) return { ok: false, error: '書けない値があります（何も送っていません）', errors: translated.errors }
  const title = b.title.normalize('NFC')
  return { ok: true, fields: { title, ...(asked as Record<string, AcbValue>) }, properties: { ...translated.properties, [titleFrom]: title } }
}

/** Note / reason of a body (people may leave it out; the AI must give it for a decision). */
export function noteOf(b: Record<string, unknown>, op: PluginOperation, actor: OperationActor): { ok: true; note: string } | { ok: false; refusal: Outcome<never> } {
  const note = b.note === undefined ? '' : b.note
  if (typeof note !== 'string' || note.length > NOTE_MAX) return { ok: false, refusal: refuse('bad-request', `note: up to ${NOTE_MAX} characters`) }
  if (op.decision && actor.kind === 'ai' && note.trim() === '') {
    return { ok: false, refusal: refuse('bad-request', 'AI が書き換えるときは、相談のどこからそう判断したか（理由と根拠）を note に書いてください', { code: 'REASON_REQUIRED' }) }
  }
  if (op.note === 'required' && note.trim() === '') return { ok: false, refusal: refuse('bad-request', 'この操作にはひとことのメモが要ります', { code: 'NOTE_REQUIRED' }) }
  return { ok: true, note }
}
