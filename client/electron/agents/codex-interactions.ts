import path from 'node:path'
import type { AgentInteraction, AgentQuestion } from '../../shared/agent-interaction'

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
export function readQuestions(value: unknown): AgentQuestion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new Error('Codexの質問形式に対応できません。通常の文章で質問するよう依頼してください。')
  const ids = new Set<string>()
  return value.map(q => {
    if (!object(q) || typeof q.id !== 'string' || !q.id || Object.prototype.hasOwnProperty.call(Object.prototype, q.id) || ids.has(q.id) || typeof q.question !== 'string' || typeof q.header !== 'string' || typeof q.isOther !== 'boolean' || typeof q.isSecret !== 'boolean') throw new Error('Codexの質問形式が不正です')
    ids.add(q.id)
    if (q.options !== null && (!Array.isArray(q.options) || !q.options.every(o => object(o) && typeof o.label === 'string' && typeof o.description === 'string'))) throw new Error('Codexの選択肢形式が不正です')
    return q as unknown as AgentQuestion
  })
}

// Unknown permission shapes are visible but cannot be approved: never grant unrendered access.
export function describePermissions(value: unknown, reason: unknown, cwd: unknown): Extract<AgentInteraction, { kind: 'permissions' }> {
  const result: Extract<AgentInteraction, { kind: 'permissions' }> = { kind: 'permissions', reason: typeof reason === 'string' ? reason : '', cwd: typeof cwd === 'string' ? cwd : '', entries: [], network: false, supported: true }
  const unsupported = () => { result.supported = false }
  if (!object(value)) { unsupported(); return result }
  if (Object.keys(value).some(k => !['network', 'fileSystem'].includes(k))) unsupported()
  if (value.network != null) {
    if (!object(value.network) || Object.keys(value.network).some(k => k !== 'enabled') || ![null, true, false].includes(value.network.enabled as boolean | null)) unsupported()
    else result.network = value.network.enabled === true
  }
  if (value.fileSystem != null) {
    const fs = value.fileSystem
    if (!object(fs)) { unsupported(); return result }
    if (Object.keys(fs).some(k => !['read', 'write', 'entries', 'globScanMaxDepth'].includes(k))) unsupported()
    if (fs.globScanMaxDepth !== undefined) unsupported() // Glob access is not supported in this first UI.
    const add = (label: unknown, access: unknown) => {
      if (typeof label !== 'string' || Array.from(label).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || !path.isAbsolute(label) || !['read', 'write', 'deny'].includes(String(access))) { unsupported(); return }
      result.entries.push({ label, access: String(access) })
    }
    for (const access of ['read', 'write']) {
      if (fs[access] != null) {
        if (!Array.isArray(fs[access])) unsupported()
        else for (const item of fs[access]) add(item, access)
      }
    }
    if (fs.entries != null) {
      if (!Array.isArray(fs.entries)) unsupported()
      else for (const entry of fs.entries) {
        if (!object(entry) || Object.keys(entry).some(k => !['path', 'access'].includes(k)) || !object(entry.path) || entry.path.type !== 'path' || Object.keys(entry.path).some(k => !['type', 'path'].includes(k))) { unsupported(); continue }
        add(entry.path.path, entry.access)
      }
    }
  }
  if (!result.entries.length && !result.network) unsupported()
  return result
}
