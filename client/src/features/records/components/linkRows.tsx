// The rows of 「つながっているもの」 built from a card's links: a record opens its card, a file
// opens in the editor. Both card kinds (the generic one, the task's) use these.
import type { RecordCardLink, RecordViewSummary } from '../../../../shared/record-views'
import { runCommand } from '../../../shared/commands/commands'
import type { LinkedRow } from '../../../shared/ui/LinkedColumn'
import { RecordMarks } from './RecordRows'
import { isPersonalPath, PERSONAL_FILE_WORDS } from '../../../../shared/today-folder'

export function recordRow(record: RecordViewSummary, linkLabel?: string): LinkedRow {
  return {
    key: record.id, name: record.typeLabel, kind: record.thing, label: record.title,
    // The link's own name only where it says more than the kind (「もとの会議」).
    ...(linkLabel && linkLabel !== record.typeLabel ? { sub: linkLabel } : {}),
    ...(record.finished ? { done: true } : {}),
    marks: <RecordMarks record={record} />,
    onOpen: () => runCommand('record.open', { recordId: record.id }),
  }
}

/**
 * `here`: for a file inside a `.personal/` folder (never synced, so the server always calls it
 * broken) whether it is on this computer — 「あなたの Mac だけにあるファイル」, else whose Mac it is on.
 */
export function fileRow(rootPath: string, path: string, broken?: boolean, here?: boolean): LinkedRow {
  const personal = isPersonalPath(path)
  const missing = personal ? here === false : broken
  return {
    key: `file:${path}`, name: 'ファイル', kind: 'file', label: path.split('/').pop() ?? path,
    sub: personal ? (here === false ? PERSONAL_FILE_WORDS.elsewhere : PERSONAL_FILE_WORDS.here) : broken ? 'つながりが切れています' : path,
    ...(missing ? {} : { onOpen: () => runCommand('file.open', { path: `${rootPath}/${path}` }) }),
  }
}

export function linkRows(links: RecordCardLink[], rootPath: string): LinkedRow[] {
  return links.flatMap(l => {
    if (l.record) return [recordRow(l.record, l.label)]
    if (l.path !== undefined) return [fileRow(rootPath, l.path, l.broken)]
    return []
  })
}
