// 「自分で読み取る」 (minutes.md "The app"): the person starts the reading once, from the task list's
// row of a received meeting the AI has not started (design §9 q6).
import { minutesConsultationTitle, minutesFirstMessage, type MinutesNotice } from '../../../shared/minutes-app'
import type { CompanyFeatures } from '../../../../shared/core/features'
import { runCommand } from '../../shared/commands/commands'

/**
 * A new consultation 「<件名> のあと（M/D）」 linked to the minutes, whose first message (the
 * member's, composed by the app) names the record — never its text.
 */
export function startMinutesReading(notice: MinutesNotice, features?: Pick<CompanyFeatures, 'decisions'>): void {
  void runCommand('chat.newConsultation', { message: minutesFirstMessage(notice, features), title: minutesConsultationTitle(notice), minutesId: notice.id })
}
