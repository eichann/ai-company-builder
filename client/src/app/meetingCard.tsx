// A meeting's own part of its card (minutes.md "Meetings for their attendees"): the minutes
// feature's buttons with the tasks feature's proposals, composed here because features do not
// import each other.
import { MeetingPanel } from '../features/minutes/components/MeetingPanel'
import { actOnTask } from '../features/tasks/api'
import { MinutesReview } from '../features/tasks/components/MinutesReview'

export function renderMeetingPanel(companyId: string, meetingId: string, opts: {
  members: ReadonlyArray<{ id: string; name: string }>
  onConsult: (meeting: { id: string; title: string }) => void
  onChanged: () => void
}) {
  return (
    <MeetingPanel key={meetingId} companyId={companyId} meetingId={meetingId} members={opts.members} onConsult={opts.onConsult} onChanged={opts.onChanged}
      renderReview={review => (
        <MinutesReview companyId={companyId} review={review} busy={false} onMeetingCard
          onAct={async (id, action, at) => { const r = await actOnTask(companyId, id, { action, expectedVersion: at }); opts.onChanged(); return r.success ? null : r.error }} />
      )} />
  )
}
