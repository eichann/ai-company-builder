// A meeting's or a 来た連絡's 案件・プロジェクト field on the record card (新しい画面のデモ J): the tasks
// feature's field and chooser, composed here because the records feature does not import tasks. A
// meeting is linked through the minutes route (so its 案件's step follows, minutes.md); anything
// else through the record links.
import type { BundleFieldContext } from '../features/records/components/RecordCard'
import { BundleField } from '../features/tasks/components/BundleField'
import { linkMeetingBundle, setRecordLink } from '../features/tasks/api'

export function renderRecordBundleField(companyId: string, ctx: BundleFieldContext, word: string) {
  const { record, version, bundle, removable, onChanged } = ctx
  return (
    <BundleField companyId={companyId} bundle={bundle} word={word} canSet canRemove={!!removable} busy={false}
      onSet={async b => {
        if (record.type === 'meeting') {
          const r = await linkMeetingBundle(companyId, record.id, b.id)
          if (!r.success) return r.error
          onChanged(`「${b.title}」につなぎました`, null)
          return null
        }
        const r = await setRecordLink(companyId, record.id, { link: 'bundle', target: b.id, expectedVersion: version }, false)
        if (!r.success) return r.error
        onChanged(`「${b.title}」につなぎました`, r.entryVersion ? { recordId: record.id, version: r.entryVersion } : null)
        return null
      }}
      onRemove={async () => {
        if (!bundle || !removable) return null
        const r = await setRecordLink(companyId, removable.source, { link: removable.link, target: removable.target, expectedVersion: removable.sourceVersion }, true)
        if (!r.success) return r.error
        onChanged(`「${bundle.title}」から外しました`, r.entryVersion ? { recordId: removable.source, version: r.entryVersion } : null)
        return null
      }} />
  )
}
