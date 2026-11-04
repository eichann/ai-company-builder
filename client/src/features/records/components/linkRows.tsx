// The rows of 「つながっているもの」 built from a card's links: a record opens its card, a file
// opens in the editor. Both card kinds (the generic one, the task's) use these.
import type { ReactNode } from 'react'
import { Microphone, NotePencil } from '@phosphor-icons/react'
import type { MeetingDetailView, OpenLink } from '../../../../shared/record-details'
import type { RecordCardLink, RecordViewSummary } from '../../../../shared/record-views'
import { runCommand } from '../../../shared/commands/commands'
import type { LinkedRow } from '../../../shared/ui/LinkedColumn'
import { SourceIcon } from '../../../shared/ui/ThingIcon'
import { openOutside } from '../api'
import { RecordMarks } from './RecordRows'
import { isPersonalPath, PERSONAL_FILE_WORDS } from '../../../../shared/today-folder'

export const OPEN_ICON: Record<OpenLink['kind'], ReactNode> = {
  transcript: <Microphone size={12} className="text-emerald-600" />,
  notes: <NotePencil size={12} className="text-sky-600" />,
  calendar: <SourceIcon source="calendar" />,
  gmail: <SourceIcon source="gmail" />,
  slack: <SourceIcon source="slack" />,
}

/** A meeting's documents and calendar day, as one group of 「つながっているもの」. */
export function meetingOpenRows(m: MeetingDetailView): LinkedRow[] {
  return m.opens.map(l => ({ key: `open:${l.kind}`, name: 'Google で開く', kind: 'other', icon: OPEN_ICON[l.kind], label: l.label, onOpen: () => void openOutside(l.url) }))
}

export function recordRow(record: RecordViewSummary, linkLabel?: string): LinkedRow {
  return {
    key: record.id, name: record.typeLabel, kind: record.thing, label: record.title,
    // The link's own name only where it says more than the kind (「もとの会議」).
    ...(linkLabel && linkLabel !== record.typeLabel ? { sub: linkLabel.replace(/タスク/g, 'やること') } : {}),
    ...(record.finished ? { done: true } : {}),
    marks: <RecordMarks record={record} />,
    onOpen: () => runCommand('record.open', { recordId: record.id }),
  }
}

/**
 * `here`: for a file inside a `.personal/` folder (never synced, so the server always calls it
 * broken) whether it is on this computer — 「あなたの Mac だけにあるファイル」, else whose Mac it is on.
 */
/** What else a file link's row says: a folder, left out on this computer, how many cannot open it. */
export interface PathFacts { folder?: boolean; notDownloaded?: boolean; cannotOpen?: number }

/** 「2人はこのファイルを開けません」: only a count — never who, nor which private folder. */
export const cannotOpenWords = (n: number, folder: boolean) => `${n}人はこの${folder ? 'フォルダ' : 'ファイル'}を開けません`
export const NOT_DOWNLOADED_WORDS = 'この Mac には未ダウンロード'

export function fileRow(rootPath: string, path: string, broken?: boolean, here?: boolean, facts: PathFacts = {}): LinkedRow {
  if (facts.folder) return folderRow(rootPath, path, broken, facts)
  const plain = fileRowOf(rootPath, path, broken, here)
  if (facts.notDownloaded && !broken) return { ...plain, sub: NOT_DOWNLOADED_WORDS, onOpen: undefined }
  return facts.cannotOpen ? { ...plain, sub: cannotOpenWords(facts.cannotOpen, false) } : plain
}

/** A linked folder: opens in the file tree (`folder.reveal`); a folder not downloaded stays linkable and says so. */
function folderRow(rootPath: string, path: string, broken: boolean | undefined, facts: PathFacts): LinkedRow {
  const sub = broken ? 'つながりが切れています' : facts.notDownloaded ? NOT_DOWNLOADED_WORDS : facts.cannotOpen ? cannotOpenWords(facts.cannotOpen, true) : path
  return {
    key: `file:${path}`, name: 'フォルダ', kind: 'folder', label: path.split('/').pop() ?? path, sub,
    ...(broken ? {} : { onOpen: () => runCommand('folder.reveal', { path: `${rootPath}/${path}` }) }),
  }
}

function fileRowOf(rootPath: string, path: string, broken?: boolean, here?: boolean): LinkedRow {
  const personal = isPersonalPath(path)
  const missing = personal ? here === false : broken
  return {
    key: `file:${path}`, name: 'ファイル', kind: 'file', label: path.split('/').pop() ?? path,
    sub: personal ? (here === false ? PERSONAL_FILE_WORDS.elsewhere : PERSONAL_FILE_WORDS.here) : broken ? 'つながりが切れています' : path,
    ...(missing ? {} : { onOpen: () => runCommand('file.open', { path: `${rootPath}/${path}` }) }),
  }
}

/**
 * The not-downloaded folder holding a company path, or null (`useSparseCheckout`'s
 * `notDownloadedFolderOf`): a link to the left-out folder itself is a folder even before the server says.
 */
export type NotDownloadedFolderOf = (path: string) => string | null

export function pathFacts(l: { path: string; folder?: true; cannotOpen?: number }, notDownloadedFolderOf?: NotDownloadedFolderOf): PathFacts {
  const out = notDownloadedFolderOf?.(l.path) ?? null
  return { folder: !!l.folder || out === l.path, notDownloaded: out !== null, ...(l.cannotOpen ? { cannotOpen: l.cannotOpen } : {}) }
}

export function linkRows(links: RecordCardLink[], rootPath: string, notDownloadedFolderOf?: NotDownloadedFolderOf): LinkedRow[] {
  return links.flatMap(l => {
    if (l.record) return [recordRow(l.record, l.label)]
    if (l.path !== undefined) return [fileRow(rootPath, l.path, l.broken, undefined, pathFacts({ ...l, path: l.path }, notDownloadedFolderOf))]
    return []
  })
}
