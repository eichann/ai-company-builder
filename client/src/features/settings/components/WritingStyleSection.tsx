// 「返事の下書きを、わたしの書き方に合わせる」 on 「仕事の道具をつなぐ」 (writing-style.md): one optional check (no settings
// screen of its own: owner, 設定が多すぎると使われなくなる), and below it the member's summaries, each word corrected
// where it is shown (InlineText; owner: no editing box apart), each summary or all of them removable.
import { useState, type ReactNode } from 'react'
import type { WritingStyleStatus } from '../../../../shared/writing-style'
import type { WritingStyle } from '../../../../../shared/core/writing-style'
import { InlineText } from '../../../shared/ui/InlineText'
import { Button, Card } from '../../../shared/ui/primitives'
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog'
import {
  WRITING_CHECK_LABEL, WRITING_CHOICES, WRITING_FIELD_LABEL, withWritingChoice, withWritingText, writingCheckHint,
  writingEntriesView, writingFieldText, writingStatusLine, type WritingChoiceField, type WritingEntryView, type WritingTextField,
} from '../writingStyle'
import type { useWritingStyle } from '../hooks/useWritingStyle'

type WritingStyleState = ReturnType<typeof useWritingStyle>

export function WritingStyleSection({ writing, status }: { writing: WritingStyleState; status: WritingStyleStatus }) {
  const [confirmAll, setConfirmAll] = useState(false)
  const line = writingStatusLine(status)
  const entries = status.enabled ? writingEntriesView(status.styles) : []
  return (
    <section aria-label={WRITING_CHECK_LABEL} className="space-y-3">
      <label className="flex items-start gap-2 text-body text-text">
        <input type="checkbox" className="mt-0.5" checked={status.enabled} disabled={writing.busy}
          onChange={e => void writing.setEnabled(e.target.checked)} />
        <span>
          <span className="font-strong">{WRITING_CHECK_LABEL}</span>
          <span className="mt-0.5 block text-small text-text-muted">{writingCheckHint(status)}</span>
        </span>
      </label>
      {line && <p role="status" className="pl-6 text-small text-text-muted">{line}</p>}
      {writing.error && <p role="alert" className="pl-6 text-small text-danger-text">{writing.error}</p>}
      {entries.map(entry => <WritingEntry key={entry.key} entry={entry} writing={writing} />)}
      {status.enabled && (
        <div className="flex flex-wrap gap-2 pl-6">
          <Button size="sm" disabled={writing.busy || status.building || !status.available} onClick={() => void writing.rebuild()}>作り直す</Button>
          {entries.length > 0 && <Button size="sm" variant="ghost" disabled={writing.busy} onClick={() => setConfirmAll(true)}>まとめをすべて消す</Button>}
        </div>
      )}
      <ConfirmDialog
        isOpen={confirmAll}
        title="書き方のまとめをすべて消しますか？"
        message="この PC にある書き方のまとめを消し、チェックも外します。送ったメッセージには何もしません。"
        confirmText="すべて消す"
        danger
        onConfirm={() => { setConfirmAll(false); void writing.remove() }}
        onCancel={() => setConfirmAll(false)}
      />
    </section>
  )
}

function WritingEntry({ entry, writing }: { entry: WritingEntryView; writing: WritingStyleState }) {
  const save = (style: WritingStyle) => writing.update(entry.connectorId, entry.audience, style)
  const text = (field: WritingTextField, multiline = false) => {
    const value = writingFieldText(entry.style, field)
    const label = `${WRITING_FIELD_LABEL[field]}を直す`
    return (
      <InlineText value={value} label={label} fieldLabel={WRITING_FIELD_LABEL[field]} busy={writing.busy} multiline={multiline}
        note={field === 'phrases' ? '「／」で区切って書きます' : undefined}
        onSave={async draft => {
          if (draft.trim() === value) return null
          const next = withWritingText(entry.style, field, draft)
          if ('problem' in next) return next.problem
          return save(next.style)
        }}>
        {value || <span className="text-text-subtle">なし</span>}
      </InlineText>
    )
  }
  const choice = <F extends WritingChoiceField>(field: F) => (
    <InlineChoice label={WRITING_FIELD_LABEL[field]} value={entry.style[field]} options={WRITING_CHOICES[field]} busy={writing.busy}
      onSave={value => { const next = withWritingChoice(entry.style, field, value); if (next) void save(next) }} />
  )
  const rows: [string, ReactNode][] = [
    [WRITING_FIELD_LABEL.greeting, text('greeting')],
    [WRITING_FIELD_LABEL.closing, text('closing')],
    [WRITING_FIELD_LABEL.sentenceLength, choice('sentenceLength')],
    [WRITING_FIELD_LABEL.politeness, choice('politeness')],
    [WRITING_FIELD_LABEL.emoji, choice('emoji')],
    [WRITING_FIELD_LABEL.phrases, text('phrases')],
    [WRITING_FIELD_LABEL.notes, text('notes', true)],
  ]
  return (
    <div role="group" aria-label={entry.title} className="ml-6">
    <Card className="space-y-2 p-3">
      <div className="flex items-baseline gap-2">
        <h3 className="text-body font-strong text-text">{entry.title}</h3>
        <span className="text-caption text-text-subtle">{entry.meta}</span>
        <Button size="sm" variant="ghost" className="ml-auto" disabled={writing.busy} aria-label={`${entry.title}のまとめを消す`}
          onClick={() => void writing.remove(entry.connectorId, entry.audience)}>消す</Button>
      </div>
      <dl className="space-y-1 text-body">
        {rows.map(([name, value]) => (
          <div key={name} className="flex gap-3">
            <dt className="w-28 shrink-0 text-text-muted">{name}</dt>
            <dd className="min-w-0 text-text">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-caption text-text-subtle">文字を押すと、その場で直せます。</p>
    </Card>
    </div>
  )
}

/** A choice shown as its words; pressed, the same place becomes a list of the choices (picking one saves). */
function InlineChoice<T extends string>({ label, value, options, busy, onSave }: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  busy: boolean
  onSave: (value: T) => void
}) {
  const [open, setOpen] = useState(false)
  const shown = options.find(o => o.value === value)?.label ?? value
  if (!open) {
    return (
      <button type="button" disabled={busy} aria-label={`${label}を直す（いまは「${shown}」）`} onClick={() => setOpen(true)}
        className="-mx-1 rounded-small px-1 text-left hover:bg-surface-sunken disabled:opacity-disabled">{shown}</button>
    )
  }
  return (
    <select aria-label={label} autoFocus defaultValue={value}
      className="rounded-small border border-border-control bg-bg px-1 text-text focus:border-focus-border focus:outline-none"
      onChange={e => { setOpen(false); if (e.target.value !== value) onSave(e.target.value as T) }}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false) } }}
      onBlur={() => setOpen(false)}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}
