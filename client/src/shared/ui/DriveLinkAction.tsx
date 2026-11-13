// ACB foundation: a card's ［Google Drive のファイルをつなぐ］ — the task card (tasks) and the 案件・プロジェクト card
// (records), every company (owner decision 2026-11-13) — and the box a
// Drive link is pasted into. The button first offers the member's own picked / put files (DriveFiles),
// else Google's own file chooser, where the member's 「選択」 is the pick (google-drive.md); a pasted link
// goes straight to that chooser and only decides what it shows first.
import { useState } from 'react'
import type { TaskDriveChoice } from '../../../shared/tasks'
import { DRIVE_PICKING_TEXT } from '../../../shared/drive-links'
import { DriveFiles } from './DriveFiles'

export function DriveLinkAction({ companyId, linked, busy, usable, note, hint, onLink, onLinkText, picking = false, onStop }: {
  companyId: string
  /** Drive files already linked to this record. */
  linked: readonly string[]
  busy: boolean
  /** False when the company has not set Drive up: the button is off and `note` says who can. */
  usable: boolean
  note: string | null
  /** After the chooser opened on a pasted link ended with nothing chosen: why it may have been empty. */
  hint: string | null
  /** `chosen` = files from the member's own list; absent = Google's chooser. null = done; else why not. */
  onLink: (chosen?: TaskDriveChoice[]) => Promise<string | null>
  /** A pasted link (or links): the caller reads the Drive ids and opens the chooser with them. */
  onLinkText: (text: string) => void
  /** Google's chooser is open in the member's browser: said, with ［やめる］ (`onStop`), never frozen silently. */
  picking?: boolean
  onStop?: () => void
}) {
  const [text, setText] = useState('')
  const send = (value: string) => { if (value.trim() !== '') { setText(''); onLinkText(value) } }
  return (
    <div className="mt-0.5 flex flex-col items-start gap-1">
      <DriveFiles companyId={companyId} linked={linked} busy={busy} usable={usable} onLink={onLink} />
      {usable && (
        <input type="text" value={text} disabled={busy} data-drive-link-paste aria-label="Google Drive のリンクを貼りつけてつなぐ"
          placeholder="Drive のリンクを貼りつけてもつなげます"
          onChange={e => setText(e.target.value)}
          onPaste={e => { const pasted = e.clipboardData.getData('text'); if (pasted.trim() !== '') { e.preventDefault(); send(pasted) } }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); send(text) } }}
          className="w-full rounded border border-gray-200 bg-transparent px-1.5 py-0.5 text-[11px] placeholder:text-gray-400 dark:border-zinc-700" />
      )}
      {picking && (
        <div role="status" data-drive-picking className="flex flex-wrap items-center gap-1.5 text-[11px] text-gray-600 dark:text-zinc-300">
          <span>{DRIVE_PICKING_TEXT}</span>
          {onStop && <button type="button" onClick={onStop} className="rounded border border-gray-300 px-1.5 py-0.5 text-[11px] dark:border-zinc-600">やめる</button>}
        </div>
      )}
      {hint && <p role="status" data-drive-link-hint className="text-[11px] text-amber-700 dark:text-amber-300">{hint}</p>}
      {note && <p data-drive-link-note className="text-[11px] text-gray-500 dark:text-zinc-400">{note}</p>}
    </div>
  )
}

