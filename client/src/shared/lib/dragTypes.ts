import { thingName } from '../../../shared/thing-words'

/** The drag data the file tree puts on its rows: a JSON array of the dragged absolute paths. */
export const FILE_PATHS_DRAG_TYPE = 'application/x-file-paths'

/** The absolute paths a drag from the file tree carries (none for anything else). */
export function draggedFilePaths(data: Pick<DataTransfer, 'getData'>): string[] {
  try {
    const v: unknown = JSON.parse(data.getData(FILE_PATHS_DRAG_TYPE) || '[]')
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

/** Whether a drag over a target comes from the file tree (its data is readable only on drop). */
export function isFileTreeDrag(data: Pick<DataTransfer, 'types'>): boolean {
  return Array.from(data.types).includes(FILE_PATHS_DRAG_TYPE)
}

/**
 * What a drag from the file tree allows: moving onto a folder, linking onto a record (its card's
 * 「つながっているもの」 uses `link`). A drop whose dropEffect the source does not allow never fires.
 */
export const FILE_TREE_EFFECT_ALLOWED = 'linkMove'

/** Whether a drop target's `dropEffect` is one the drag source allows (the browser drops nothing otherwise). */
export function dropEffectAllowed(effectAllowed: string, dropEffect: 'copy' | 'move' | 'link'): boolean {
  if (effectAllowed === 'all' || effectAllowed === 'uninitialized') return true
  return effectAllowed.toLowerCase().includes(dropEffect)
}

/**
 * Added to a drag that starts on a middle tab: the tab bar takes it to reorder (the record or file data
 * beside it still links it wherever it is dropped). Its value is not read: the bar knows its own tab.
 */
export const TAB_DRAG_TYPE = 'application/x-acb-tab'
export const isTabDrag = (data: Pick<DataTransfer, 'types'>): boolean => Array.from(data.types).includes(TAB_DRAG_TYPE)

/** A record dragged from a list row, a 探す row or its tab in the middle: `{ id, title }` as JSON. */
export const RECORD_DRAG_TYPE = 'application/x-acb-record'
/** One of 「AIへの相談」 dragged from the conversation list or 探す: `{ sessionId, title }` as JSON. */
export const CONSULTATION_DRAG_TYPE = 'application/x-acb-consultation'
/** What a record or consultation drag allows: dropping links it, nothing moves. */
export const LINK_EFFECT_ALLOWED = 'link'

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/
/** `RECORD_ID_RE` of shared/core/records.ts, kept here so the renderer does not bundle the record-file parser. */
const RECORD_ID_RE = /^[a-z][a-z0-9_]{0,39}-[0-9a-z]{6,32}$/
const titleOf = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 200) : '')

export interface DraggedRecord {
  id: string
  title: string
  /** The kind in members' words (やること, 案件, 会議の記録…; thing-words.ts), shown while dragging. */
  word?: string
}
/** `topicRecordId`: the record it is about now (取り消す puts it back). */
export interface DraggedConsultation { sessionId: string; title: string; topicRecordId?: string }
type DragStart = Pick<DataTransfer, 'setData' | 'effectAllowed'>

/** `application/x-acb-record-word.<UTF-8 hex>`: hex because browsers lower-case drag types. */
const RECORD_WORD_TYPE_PREFIX = 'application/x-acb-record-word.'
const hexOf = (s: string): string => Array.from(new TextEncoder().encode(s), b => b.toString(16).padStart(2, '0')).join('')

/** Puts a record on a drag (its row's `onDragStart`). */
export function startRecordDrag(data: DragStart, record: DraggedRecord): void {
  data.setData(RECORD_DRAG_TYPE, JSON.stringify({ id: record.id, title: record.title }))
  // Only the types are readable while dragging: the kind's word rides in one (the chat's drop frame says it).
  const word = record.word?.trim() || thingName({ type: record.id.split('-')[0] ?? '' })
  data.setData(`${RECORD_WORD_TYPE_PREFIX}${hexOf(word.slice(0, 20))}`, '')
  data.setData('text/plain', record.title)
  data.effectAllowed = LINK_EFFECT_ALLOWED
}

/** Puts a consultation on a drag. */
export function startConsultationDrag(data: DragStart, c: DraggedConsultation): void {
  data.setData(CONSULTATION_DRAG_TYPE, JSON.stringify({ sessionId: c.sessionId, title: c.title, ...(c.topicRecordId ? { topicRecordId: c.topicRecordId } : {}) }))
  data.setData('text/plain', c.title)
  data.effectAllowed = LINK_EFFECT_ALLOWED
}

/** The kind's word a record drag carries, readable while dragging (null: not a record drag, or none). */
export function draggedRecordWord(data: Pick<DataTransfer, 'types'>): string | null {
  const type = Array.from(data.types).find(t => t.startsWith(RECORD_WORD_TYPE_PREFIX))
  const hex = type?.slice(RECORD_WORD_TYPE_PREFIX.length) ?? ''
  if (!hex || hex.length % 2 || !/^[0-9a-f]+$/.test(hex)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(hex.match(/../g)!, h => parseInt(h, 16))) || null
  } catch {
    return null
  }
}

function parsed(data: Pick<DataTransfer, 'getData'>, type: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(data.getData(type) || 'null')
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** The record a drag carries (null for anything else, or a malformed id). */
export function draggedRecord(data: Pick<DataTransfer, 'getData'>): DraggedRecord | null {
  const v = parsed(data, RECORD_DRAG_TYPE)
  return v && typeof v.id === 'string' && RECORD_ID_RE.test(v.id) ? { id: v.id, title: titleOf(v.title) } : null
}

/** The consultation a drag carries (null for anything else). */
export function draggedConsultation(data: Pick<DataTransfer, 'getData'>): DraggedConsultation | null {
  const v = parsed(data, CONSULTATION_DRAG_TYPE)
  if (!v || typeof v.sessionId !== 'string' || !SESSION_ID.test(v.sessionId)) return null
  return { sessionId: v.sessionId, title: titleOf(v.title), ...(typeof v.topicRecordId === 'string' && RECORD_ID_RE.test(v.topicRecordId) ? { topicRecordId: v.topicRecordId } : {}) }
}

/**
 * Whether a drag is one a record's 「つながっているもの」 takes: a file or folder from the tree, a
 * record, a consultation (while dragging only the kinds are readable; what it is, on drop).
 */
export function isLinkableDrag(data: Pick<DataTransfer, 'types'>): boolean {
  const types = Array.from(data.types)
  return types.includes(FILE_PATHS_DRAG_TYPE) || types.includes(RECORD_DRAG_TYPE) || types.includes(CONSULTATION_DRAG_TYPE)
}
