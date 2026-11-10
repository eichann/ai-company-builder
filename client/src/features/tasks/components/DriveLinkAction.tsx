// The card's ［Google Drive のファイルをつなぐ］ (a company without the shared folder) and the box a
// Drive link is pasted into: either opens Google's own file chooser, where the member's 「選択」 is
// the pick (google-drive.md); a pasted link only decides what that chooser shows first.
import { useState } from 'react'
import { Plus } from '@phosphor-icons/react'

export function DriveLinkAction({ busy, usable, note, onPick, onLinkText }: {
  busy: boolean
  /** False when the company has not set Drive up: the button is off and `note` says who can. */
  usable: boolean
  note: string | null
  onPick: () => void
  /** A pasted link (or links): the caller reads the Drive ids and opens the chooser with them. */
  onLinkText: (text: string) => void
}) {
  const [text, setText] = useState('')
  const send = (value: string) => { if (value.trim() !== '') { setText(''); onLinkText(value) } }
  return (
    <div className="mt-0.5 flex flex-col items-start gap-1">
      <button type="button" disabled={busy || !usable} onClick={onPick} data-link-drive
        className="inline-flex items-center gap-0.5 rounded px-1 text-[11.5px] text-accent hover:underline disabled:opacity-50"><Plus size={10} />Google Drive のファイルをつなぐ</button>
      {usable && (
        <input type="text" value={text} disabled={busy} data-drive-link-paste aria-label="Google Drive のリンクを貼りつけてつなぐ"
          placeholder="Drive のリンクを貼りつけてもつなげます"
          onChange={e => setText(e.target.value)}
          onPaste={e => { const pasted = e.clipboardData.getData('text'); if (pasted.trim() !== '') { e.preventDefault(); send(pasted) } }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); send(text) } }}
          className="w-full rounded border border-gray-200 bg-transparent px-1.5 py-0.5 text-[11px] placeholder:text-gray-400 dark:border-zinc-700" />
      )}
      {note && <p data-drive-link-note className="text-[11px] text-gray-500 dark:text-zinc-400">{note}</p>}
    </div>
  )
}
