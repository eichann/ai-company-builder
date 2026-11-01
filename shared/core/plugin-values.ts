/**
 * Translating values both ways through a mapping: outside properties → ACB
 * field values (`externalToAcb`, untranslatable values left out and named)
 * and ACB values → the outside properties to write (`acbToExternal`, all or
 * nothing).
 */
import type { PluginManifest } from './plugin-declaration'
import { mappableField, type PluginMapping } from './plugin-mapping'
import type { FieldDef, TypeDefinition } from './record-types'

export type AcbValue = string | number | boolean | null

/** Outside values as the API returns them (HubSpot: strings). */
export type ExternalProperties = Record<string, unknown>

function toAcb(kind: FieldDef['kind'], raw: unknown): AcbValue | undefined {
  if (raw === null || raw === undefined || raw === '') return null
  const s = typeof raw === 'string' ? raw : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : undefined
  if (s === undefined) return undefined
  switch (kind) {
    case 'number': { const n = Number(s); return Number.isFinite(n) ? n : undefined }
    case 'boolean': return s === 'true' ? true : s === 'false' ? false : undefined
    case 'date': {
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
      if (/^\d{10,15}$/.test(s)) return new Date(Number(s)).toISOString().slice(0, 10)
      return undefined
    }
    default: return s
  }
}

function toExternal(value: AcbValue): string {
  if (value === null) return ''
  return typeof value === 'string' ? value : String(value)
}

/**
 * Outside properties → ACB field values through the mapping. Values the
 * mapping cannot translate are left out and reported (`problems`: field
 * names only, never the value).
 */
export function externalToAcb(
  pkg: { manifest: PluginManifest; types: Record<string, TypeDefinition> },
  mapping: PluginMapping,
  objectName: string,
  properties: ExternalProperties,
): { values: Record<string, AcbValue>; problems: string[] } {
  const obj = mapping.objects[objectName]
  const type = pkg.types[pkg.manifest.objects[objectName]?.recordType ?? '']
  const values: Record<string, AcbValue> = {}
  const problems: string[] = []
  if (!obj || !type) return { values, problems: [`「${objectName}」は読み替え表にありません`] }
  for (const [field, rule] of Object.entries(obj.fields)) {
    const def = mappableField(type, field)!
    const raw = properties[rule.from]
    if (raw === undefined) continue
    if (raw === null || raw === '') { values[field] = null; continue }
    if (rule.values) {
      const v = typeof raw === 'string' || typeof raw === 'number' ? rule.values[String(raw)] : undefined
      if (v === undefined) problems.push(`欄「${field}」: 読み替え表にない値です`)
      else values[field] = v
      continue
    }
    if (rule.people) {
      const member = typeof raw === 'string' || typeof raw === 'number' ? mapping.people[rule.people]?.[String(raw)] : undefined
      if (member === undefined) problems.push(`欄「${field}」: 担当者の対応表にない番号です`)
      else values[field] = member
      continue
    }
    const v = toAcb(def.kind, raw)
    if (v === undefined) problems.push(`欄「${field}」: 値を読めません`)
    else values[field] = v
  }
  return { values, problems }
}

/**
 * ACB field values → the outside properties to write. Only fields the
 * mapping writes; anything else is refused (no partial write).
 */
export function acbToExternal(
  pkg: { manifest: PluginManifest; types: Record<string, TypeDefinition> },
  mapping: PluginMapping,
  objectName: string,
  changes: Record<string, AcbValue>,
): { ok: true; properties: Record<string, string> } | { ok: false; errors: string[] } {
  const obj = mapping.objects[objectName]
  const type = pkg.types[pkg.manifest.objects[objectName]?.recordType ?? '']
  if (!obj || !type) return { ok: false, errors: [`「${objectName}」は読み替え表にありません`] }
  const properties: Record<string, string> = {}
  const errors: string[] = []
  for (const [field, value] of Object.entries(changes)) {
    const rule = obj.fields[field]
    if (!rule?.write) { errors.push(`欄「${field}」は書き戻さない欄です`); continue }
    const def = mappableField(type, field)!
    if (rule.values) {
      const ext = Object.entries(rule.values).find(([, acb]) => acb === value)?.[0]
      if (ext === undefined) errors.push(`欄「${field}」: 読み替え表にない値です`)
      else properties[rule.from] = ext
      continue
    }
    if (rule.people) {
      const ext = Object.entries(mapping.people[rule.people] ?? {}).find(([, m]) => m === value)?.[0]
      if (ext === undefined) errors.push(`欄「${field}」: 担当者の対応表にないメンバーです`)
      else properties[rule.from] = ext
      continue
    }
    const kindOk = value === null
      || (def.kind === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : def.kind === 'boolean' ? typeof value === 'boolean'
          : def.kind === 'date' ? typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
            : typeof value === 'string')
    if (!kindOk) { errors.push(`欄「${field}」の値の種類が違います（${def.kind}）`); continue }
    properties[rule.from] = toExternal(value)
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, properties }
}
