// A meeting's or a 来た連絡's 案件・プロジェクト field on the record card (新しい画面のデモ J): the tasks
// feature's field, chooser and 「新しい〇〇にする」 window, composed here because the records feature
// does not import tasks. A meeting is linked through the minutes route (so its 案件's step follows,
// minutes.md); anything else through the record links. A meeting is seen by its attendees only, so
// linking it says first who will see part of it (design §2/§5) and links only on ［つなぐ］. While a
// meeting has none, the same field asks 「どの〇〇の会議ですか？」 (the server decides whether it may).
import { useState } from 'react'
import type { BundleKind } from '../../../shared/types/records'
import { meetingLinkSentence } from '../../shared/minutes-app'
import { meetingBundleWords, meetingSuggestedBundleText } from '../../shared/tasks'
import { bundleViewers, declineMeetingBundle } from '../features/minutes/api'
import { useMeetingBundleQuestion } from '../features/minutes/hooks/useMeetingBundleQuestion'
import { ConfirmDialog } from '../shared/ui/ConfirmDialog'
import type { BundleFieldContext } from '../features/records/components/RecordCard'
import { BundleField, type BundleQuestion } from '../features/tasks/components/BundleField'
import { createBundle, linkMeetingBundle, setRecordLink } from '../features/tasks/api'
import type { NewBundlePlaces } from '../features/tasks/components/NewBundleDialog'
import type { BundlePlace } from '../features/tasks/model'

/** Waiting for the member's answer to 「…に見えます」: the link goes on only with ［つなぐ］. */
type Asking = { title: string; message: string; answer: (yes: boolean) => void }

export function RecordBundleFieldBox({ companyId, ctx, kind, folder, onListChanged, places }: {
  companyId: string; ctx: BundleFieldContext; kind: BundleKind | null; folder: string | null
  /** 「新しい〇〇にする」's departments, the member's own first (records.md "A task and its 案件・プロジェクト"). */
  places?: NewBundlePlaces
  /** The meeting's question was answered: 「どの〇〇の会議か」 leaves あなたの番. */
  onListChanged?: () => void
}) {
  const { record, version, bundle, removable, counterpart, homework, onChanged } = ctx
  const [asking, setAsking] = useState<Asking | null>(null)
  const isMeeting = record.type === 'meeting'
  const asked = useMeetingBundleQuestion(companyId, isMeeting ? record.id : null, bundle?.id ?? null)
  const [declined, setDeclined] = useState(false)
  const ask = (title: string, message: string) => new Promise<boolean>(resolve => setAsking({ title, message, answer: yes => { setAsking(null); resolve(yes) } }))
  /** A meeting: true once the member agreed to show part of it to the 案件's people. */
  const agreed = async (b: { id: string; title: string; typeLabel?: string } | null, name: string): Promise<boolean> => {
    if (!isMeeting) return true
    const viewers = b ? await bundleViewers(companyId, b.id) : null
    return ask(b ? `「${b.title}」につなぐ` : `新しい${name}につなぐ`, meetingLinkSentence(b?.typeLabel ?? name, viewers))
  }
  const link = async (b: { id: string; title: string }): Promise<string | null> => {
    if (record.type === 'meeting') {
      const r = await linkMeetingBundle(companyId, record.id, b.id)
      return r.success ? null : r.error
    }
    const r = await setRecordLink(companyId, record.id, { link: 'bundle', target: b.id, expectedVersion: version }, false)
    return r.success ? null : r.error
  }
  const name = kind?.name ?? 'プロジェクト'
  const set = async (b: { id: string; title: string; typeLabel?: string }): Promise<string | null> => {
    if (!await agreed(b, name)) return null
    const failure = await link(b)
    if (!failure) { onChanged(`「${b.title}」につなぎました`, null); onListChanged?.() }
    return failure
  }
  const decline = async (): Promise<string | null> => {
    const r = await declineMeetingBundle(companyId, record.id)
    if (!r.success) return r.error
    setDeclined(true)
    onListChanged?.()
    return null
  }
  const question = (): BundleQuestion | undefined => {
    if (!asked?.success || !asked.canChoose) return undefined
    const words = meetingBundleWords(name)
    if (declined || asked.noBundle) return { text: words.declined }
    const s = asked.suggested
    return {
      text: s ? meetingSuggestedBundleText(s.title) : words.question,
      none: { label: words.noneLong, press: decline },
      ...(s ? { yes: () => set(s), pick: 'ちがう／選ぶ' } : {}),
    }
  }
  return (<>
    <BundleField companyId={companyId} bundle={bundle} word={kind?.name ?? 'プロジェクト'} canSet canRemove={!!removable} busy={false} question={question()}
      onSet={set}
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
        ...(places ? { places } : {}),
        onCreate: async (title: string, withHomework: boolean, place: BundlePlace | null) => {
          const madeKind = place?.kind ?? kind
          if (!await agreed(null, madeKind.name)) return null
          const made = await createBundle(companyId, { type: madeKind.type, title, folder: place ? place.folder : folder, counterpart: counterpart?.id ?? null })
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
    <ConfirmDialog isOpen={asking !== null} title={asking?.title ?? ''} message={asking?.message ?? ''} confirmText="つなぐ" cancelText="やめる"
      confirmOnEnter={false} onConfirm={() => asking?.answer(true)} onCancel={() => asking?.answer(false)} />
  </>)
}
