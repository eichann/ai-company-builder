// A meeting's or a 来た連絡's 案件・プロジェクト field on the record card (新しい画面のデモ J): the tasks
// feature's field, chooser and 「新しい〇〇にする」 window, composed here because the records feature
// does not import tasks. A meeting is linked through the minutes route (so its 案件's step follows,
// minutes.md); anything else through the record links.
import type { BundleKind } from '../../../shared/types/records'
import type { BundleFieldContext } from '../features/records/components/RecordCard'
import { BundleField } from '../features/tasks/components/BundleField'
import { createBundle, linkMeetingBundle, setRecordLink } from '../features/tasks/api'

/** `kind`: what the department on screen makes (`tasks:bundleKinds`); null until known (no 「新しい〇〇にする」). */
export function renderRecordBundleField(companyId: string, ctx: BundleFieldContext, kind: BundleKind | null, folder: string | null) {
  const { record, version, bundle, removable, counterpart, homework, onChanged } = ctx
  const link = async (b: { id: string; title: string }): Promise<string | null> => {
    if (record.type === 'meeting') {
      const r = await linkMeetingBundle(companyId, record.id, b.id)
      return r.success ? null : r.error
    }
    const r = await setRecordLink(companyId, record.id, { link: 'bundle', target: b.id, expectedVersion: version }, false)
    return r.success ? null : r.error
  }
  return (
    <BundleField companyId={companyId} bundle={bundle} word={kind?.name ?? 'プロジェクト'} canSet canRemove={!!removable} busy={false}
      onSet={async b => {
        const failure = await link(b)
        if (!failure) onChanged(`「${b.title}」につなぎました`, null)
        return failure
      }}
      onRemove={async () => {
        if (!bundle || !removable) return null
        const r = await setRecordLink(companyId, removable.source, { link: removable.link, target: removable.target, expectedVersion: removable.sourceVersion }, true)
        if (!r.success) return r.error
        onChanged(`「${bundle.title}」から外しました`, r.entryVersion ? { recordId: removable.source, version: r.entryVersion } : null)
        return null
      }}
      {...(kind ? {
        newFrom: {
          title: record.title, titleNote: record.type === 'meeting' ? '会議の名前から入れました' : '連絡の件名から入れました',
          counterpart, homework: homework.length,
        },
        onCreate: async (title: string, withHomework: boolean) => {
          const made = await createBundle(companyId, { type: kind.type, title, folder, counterpart: counterpart?.id ?? null })
          if (!made.success) return made.error
          const failure = await link({ id: made.recordId, title })
          if (failure) return failure
          // The meeting's 宿題 go in too, each at its own version; one that fails is left as it was.
          let moved = 0
          if (withHomework) {
            for (const t of homework) {
              const r = await setRecordLink(companyId, t.id, { link: 'bundle', target: made.recordId, expectedVersion: t.version }, false)
              if (r.success) moved++
            }
          }
          onChanged(`「${title}」を作り、つなぎました${moved > 0 ? `（宿題 ${moved}件も入れました）` : ''}`, null)
          return null
        },
      } : {})} />
  )
}
