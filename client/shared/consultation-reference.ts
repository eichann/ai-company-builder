export interface ConsultationReference { id: string; title: string }
export function referenceFromTool(name: string, output: unknown): ConsultationReference | undefined {
  if (name !== 'mcp__acb_consultations__read_consultation') return
  function read(value: unknown, depth: number): ConsultationReference | undefined {
    if (depth > 5) return
    if (typeof value === 'string') { try { return read(JSON.parse(value), depth + 1) } catch { return } }
    if (!value || typeof value !== 'object') return
    const obj = value as Record<string, unknown>
    if (typeof obj.id === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(obj.id) && typeof obj.title === 'string' && typeof obj.content === 'string' && (obj.view === 'memo' || obj.view === 'messages')) return { id: obj.id, title: obj.title.slice(0, 200) }
    if (Array.isArray(value)) for (const item of value) { const ref = read(item, depth + 1); if (ref) return ref }
    for (const key of ['content', 'text', 'result']) { const ref = read(obj[key], depth + 1); if (ref) return ref }
  }
  return read(output, 0)
}
