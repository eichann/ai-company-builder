// A meeting's card from its summary down (minutes.md "Meetings for their attendees"): the records
// feature's parts, the minutes feature's buttons and the tasks feature's proposals, composed here
// because features do not import each other. Also the meeting's まとまり chooser (the tasks feature's).
import { declineMeetingBundle } from '../features/minutes/api'
import { MeetingPanel } from '../features/minutes/components/MeetingPanel'
import type { MeetingCardParts } from '../features/records/components/RecordCard'
import { actOnTask, createTask, linkMeetingBundle, undoTaskAction } from '../features/tasks/api'
import { BundleChooser } from '../features/tasks/components/BundleChooser'
import { MinutesReview } from '../features/tasks/components/MinutesReview'

export function renderMeetingPanel(companyId: string, meetingId: string, opts: {
  members: ReadonlyArray<{ id: string; name: string }>
  onConsult: (meeting: { id: string; title: string }) => void
  onChanged: () => void
  parts: MeetingCardParts
}) {
  const { parts } = opts
  return (
    <MeetingPanel key={meetingId} companyId={companyId} meetingId={meetingId} members={opts.members} onConsult={opts.onConsult} onChanged={opts.onChanged}
      summary={parts.summary} outputs={parts.outputs} bundle={parts.bundle}
      renderReview={review => (
        <MinutesReview companyId={companyId} review={review} busy={false} onMeetingCard made={parts.tasks}
          onAct={async (id, action, at, note) => { const r = await actOnTask(companyId, id, { action, expectedVersion: at, ...(note ? { note } : {}) }); opts.onChanged(); parts.onChanged(); return r.success ? null : r.error }}
          onCreate={async title => { const r = await createTask(companyId, { title, meetingId }); opts.onChanged(); parts.onChanged(); return r }}
          onUndo={async (id, at) => { const r = await undoTaskAction(companyId, id, at, at); opts.onChanged(); parts.onChanged(); return r.success ? null : r.error }} />
      )} />
  )
}

/** 「どのまとまりの会議ですか？」 chosen from the title bar or the list: the tasks feature's chooser over the meeting's link. */
export function renderMeetingBundleChooser(companyId: string, meeting: { id: string; title: string }, opts: {
  word: string
  /** After a choice: the list reads again, then an open meeting card. */
  onChosen: () => void
  onClose: () => void
}) {
  return (
    <BundleChooser
      companyId={companyId} meetingTitle={meeting.title} word={opts.word}
      onChoose={async b => {
        const r = await linkMeetingBundle(companyId, meeting.id, b.id)
        opts.onChosen()
        return r?.success ? null : (r?.error ?? 'できませんでした。')
      }}
      onNoBundle={async () => {
        const r = await declineMeetingBundle(companyId, meeting.id)
        opts.onChosen()
        return r.success ? null : r.error
      }}
      onClose={opts.onClose}
    />
  )
}
