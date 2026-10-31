/**
 * Record files of the light ontology (stage 4-1): a Markdown file whose
 * frontmatter has only `id`, `type` and `links` (owner decision 0.3-8: state,
 * assignee, due date… are never written to files — the company map on the
 * server holds them, changed only by the state engine). The text is the
 * record's content; its first `# ` heading is the title, the first paragraph
 * after it the summary (what the map searches, 0.23-1).
 *
 * Records name people and customers by id, never by name (13.10): a file
 * keeps everything git ever saw.
 *
 * The server's indexer, the app's id assignment and the chat write guard use
 * this one parser.
 */
import { normalizeRepoPath } from './paths'
import { ONTOLOGY_NAME_RE } from './record-types'
import { isYamlMap, parseYamlLite, splitFrontmatter } from './yaml-lite'

/** `<type prefix>-<6–32 lower-case letters or digits>`, e.g. `task-3f2a9c0b`. */
export const RECORD_ID_RE = /^[a-z][a-z0-9_]{0,39}-[0-9a-z]{6,32}$/

/** The only keys a record file's frontmatter holds. */
export const RECORD_FILE_KEYS = ['id', 'type', 'links'] as const

export const MAX_TITLE_LENGTH = 200
export const MAX_SUMMARY_LENGTH = 300
/** Links per record file that are read (more are reported and ignored). */
export const MAX_LINKS_PER_RECORD = 200

export interface ParsedRecordFile {
  id: string
  type: string
  /** link name → targets as written (record ids, or company paths for file links). */
  links: Record<string, string[]>
  title: string
  summary: string
  /** What was ignored or wrong but did not stop the file from being a record (Japanese, for admins). */
  problems: string[]
}

export type RecordFileResult =
  | { kind: 'record'; record: ParsedRecordFile }
  /** Has `id` / `type` but they are unusable: reported, not indexed. */
  | { kind: 'invalid'; problems: string[] }
  /** Not a record (no frontmatter, or no `type`). */
  | { kind: 'none' }

/** `name.md` → `name` (the title when the text has no heading). */
function baseName(path: string): string {
  const last = path.split('/').pop() ?? path
  return last.replace(/\.md$/i, '')
}

/** Title and summary from the text of a record (first `# ` heading, first paragraph after it). */
export function titleAndSummary(body: string, path: string): { title: string; summary: string } {
  const lines = body.split(/\r\n|\r|\n/)
  let title = ''
  let i = 0
  let inFence = false
  for (; i < lines.length; i++) {
    const l = lines[i]
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence
    if (inFence) continue
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(l)
    if (m) { title = m[1]; i++; break }
  }
  if (!title) { title = baseName(path); i = 0 }
  const para: string[] = []
  inFence = false
  for (; i < lines.length; i++) {
    const l = lines[i].trim()
    if (/^(```|~~~)/.test(l)) { inFence = !inFence; if (para.length > 0) break; continue }
    if (inFence) continue
    if (l === '') { if (para.length > 0) break; continue }
    if (/^(#|[-*+] |\d+\. |>|\||<!--)/.test(l)) { if (para.length > 0) break; continue }
    para.push(l)
  }
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
  return {
    title: clip(title.normalize('NFC').replace(/\s+/g, ' ').trim(), MAX_TITLE_LENGTH),
    summary: clip(para.join(' ').normalize('NFC').replace(/\s+/g, ' ').trim(), MAX_SUMMARY_LENGTH),
  }
}

/**
 * Read one Markdown file as a record. `path` is the company path (used for
 * the title fallback and to resolve nothing else).
 */
export function parseRecordFile(path: string, text: string): RecordFileResult {
  const fm = splitFrontmatter(text)
  if (!fm) return { kind: 'none' }
  const yaml = parseYamlLite(fm.yaml, fm.yamlFirstLine)
  if (!yaml.ok) {
    // Only a file that claims to be a record is reported.
    return /^(id|type)\s*:/m.test(fm.yaml) && /^type\s*:/m.test(fm.yaml)
      ? { kind: 'invalid', problems: [`${yaml.line} 行目: ${yaml.error}`] }
      : { kind: 'none' }
  }
  const v = yaml.value
  if (!isYamlMap(v) || v.type === undefined) return { kind: 'none' }
  const problems: string[] = []
  if (typeof v.type !== 'string' || !ONTOLOGY_NAME_RE.test(v.type)) return { kind: 'invalid', problems: ['type は型の名前（英小文字）で書いてください'] }
  if (v.id === undefined || v.id === null || v.id === '') return { kind: 'invalid', problems: ['id がありません（アプリが自動で付けます）'] }
  if (typeof v.id !== 'string' || !RECORD_ID_RE.test(v.id)) return { kind: 'invalid', problems: [`id「${String(v.id).slice(0, 60)}」の形が正しくありません`] }
  for (const k of Object.keys(v)) {
    if (!(RECORD_FILE_KEYS as readonly string[]).includes(k)) problems.push(`先頭の「${k}」は読みません（状態・担当・期限などはサーバーが持ちます）`)
  }
  const links: Record<string, string[]> = {}
  let count = 0
  if (v.links !== undefined && v.links !== null) {
    if (!isYamlMap(v.links)) problems.push('links は「名前: 相手」の形で書いてください')
    else {
      for (const [name, raw] of Object.entries(v.links)) {
        if (!ONTOLOGY_NAME_RE.test(name)) { problems.push(`つながりの名前「${name}」は英小文字で書いてください`); continue }
        const items = raw === null ? [] : Array.isArray(raw) ? raw : [raw]
        const targets: string[] = []
        for (const item of items) {
          if (typeof item !== 'string' || item.trim() === '') { problems.push(`つながり「${name}」の相手を読めません`); continue }
          if (count >= MAX_LINKS_PER_RECORD) { problems.push(`つながりは ${MAX_LINKS_PER_RECORD} 件までしか読みません`); break }
          targets.push(item.trim().normalize('NFC'))
          count++
        }
        if (targets.length > 0) links[name] = targets
      }
    }
  }
  return { kind: 'record', record: { id: v.id, type: v.type, links, ...titleAndSummary(fm.body, path), problems } }
}

/**
 * A link target as a file of the company folder: the normalized company path,
 * or null when it is not a usable path (absolute, `..`, empty).
 */
export function fileLinkPath(target: string): string | null {
  if (target.startsWith('/') || /^[a-z]+:/i.test(target)) return null
  const p = normalizeRepoPath(target)
  if (p === null || p === '' || p.split('/').some(s => s === '..' || s === '.')) return null
  return p
}

/** A new record id for a type: `<type>-<random>` (`random`: 6–32 of [0-9a-z], e.g. from crypto). */
export function newRecordId(type: string, random: string): string {
  const id = `${type.slice(0, 40)}-${random.toLowerCase().replace(/[^0-9a-z]/g, '').slice(0, 32)}`
  if (!RECORD_ID_RE.test(id)) throw new Error('newRecordId: needs a type name and at least 6 random letters or digits')
  return id
}
