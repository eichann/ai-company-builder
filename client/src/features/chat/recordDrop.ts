// A record (やること, 案件, 会議…) dropped on the consultation's input (owner, 2026-11-03 #5): the
// consultation becomes one about it, and the AI gets the record's summary once, with the next message.
// Pure: the composer, the conversation and tests use it.
import { MAX_DROPPED_RECORDS, type DroppedRecordRef } from '../../../shared/record-drop'
import { draggedRecordWord, FILE_PATHS_DRAG_TYPE, RECORD_DRAG_TYPE } from '../../shared/lib/dragTypes'

/** What is being dragged over the input: a file (the AI reads it), a record (the consultation is about it), or nothing it takes. */
export type ComposerDrag = { kind: 'file' } | { kind: 'record'; word: string } | null

/** Read while dragging (only the types are readable then). A record wins over files when a source puts both. */
export function composerDragOf(data: Pick<DataTransfer, 'types'>): ComposerDrag {
  const types = Array.from(data.types)
  if (types.includes(RECORD_DRAG_TYPE)) return { kind: 'record', word: draggedRecordWord(data) ?? '記録' }
  if (types.includes('Files') || types.includes(FILE_PATHS_DRAG_TYPE)) return { kind: 'file' }
  return null
}

/** The words in the drop frame: what happens when it is dropped here. */
export function dropFrameText(drag: Exclude<ComposerDrag, null>): string {
  return drag.kind === 'record' ? `ここに落とすと、この${drag.word}の相談になります` : 'ここに落とすと、AI が読みます'
}

// The topic rule and its question are shared with a consultation dropped on a record's card.
export { switchTopicQuestion, topicOnDrop } from '../../../shared/consultation-topics'

/** Adds a dropped record to those waiting for the next message (once each; at most five, as main reads at most five). */
export function withPendingRecord(list: readonly DroppedRecordRef[], record: DroppedRecordRef): DroppedRecordRef[] {
  if (list.some(r => r.id === record.id)) return [...list]
  return [...list, record].slice(-MAX_DROPPED_RECORDS)
}

/** The line in the member's message bubble (and the composer chip): 「やること『見積を直す』を AI に渡しました」. */
export function droppedRecordLine(r: Pick<DroppedRecordRef, 'title' | 'word'>, sent: boolean): string {
  return `${r.word}『${r.title || '（名前なし）'}』を AI に${sent ? '渡しました' : '渡します'}`
}
