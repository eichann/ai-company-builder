// A meeting's card from its summary down (minutes.md "Meetings for their attendees"): the records
// feature's parts, the minutes feature's buttons and the tasks feature's proposals, composed here
// because features do not import each other.
import { MeetingPanel } from '../features/minutes/components/MeetingPanel'
import type { MeetingCardParts } from '../features/records/components/RecordCard'
import { actOnTask } from '../features/tasks/api'
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
          onAct={async (id, action, at) => { const r = await actOnTask(companyId, id, { action, expectedVersion: at }); opts.onChanged(); parts.onChanged(); return r.success ? null : r.error }} />
      )} />
  )
}
