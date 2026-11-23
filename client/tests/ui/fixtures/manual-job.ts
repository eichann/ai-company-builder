// The user manual's scheduled job (manual/README.md, chapter 26): 山田さん's 「週報をまとめる」 every Monday
// at 09:00, proposed from 「AIへの相談」. Built by the core's own parser, as the server would answer it, for the
// preview pages that show it with `?manual=1` (the chat's proposal card, settings →「定期の仕事」). Fictional data only.
import { proposalDefinition } from '../../../../shared/core/job-proposals'
import { parseJobDefinition, type JobDefinition } from '../../../../shared/core/jobs'

export const MANUAL_JOB_CANDIDATE = `jc.${'3f9c2a71'.repeat(4)}`
export const MANUAL_JOB_FINGERPRINT = `sha256:${'f'.repeat(64)}`

export const MANUAL_JOB_DEFINITION: JobDefinition = (parseJobDefinition(proposalDefinition(
  {
    skill: 'weekly-report', trigger: { every: 'week', weekday: 'mon', at: '09:00', businessDaysBefore: 0 },
    check: { kind: 'new_files', path: '営業部/訪問メモ' }, reads: ['営業部/提案書'], deliverable: '営業部/週報',
    readRecords: false, mailDrafts: false, minutes: 15, missed: { policy: 'latest_only', expiresAfterMinutes: 120 },
  },
  { actingUser: 'u-yamada', procedure: { source: 'company_skill', skill: 'weekly-report', fingerprint: 'c'.repeat(40) }, skillName: 'weekly-report', candidateId: MANUAL_JOB_CANDIDATE },
)) as { definition: JobDefinition }).definition
