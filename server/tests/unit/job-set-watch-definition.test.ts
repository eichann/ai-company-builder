/**
 * The set watch's definition (schema 5, 4b-4 PR1; owner memo 「4b-4 商談から提案書」 第6版 §2-1 / §2-6 / 付録 B, T8 / T22;
 * jobs.md "The set watch (schema 5)"). Guards (each mutation-checked):
 * - the trigger is a combination of fixed words, never a free condition: a word outside its list is refused, and a combination
 *   of valid words that is not exactly one of `JOB_SET_WATCH_OPENED` is refused (`trigger.NOT_OPENED`) — also once a line is
 *   taken out of the list;
 * - every piece of schema 5 is schema 5's alone (a department Skill, the Skills it reads, the matched-record check, the
 *   reasons), and schema 5 takes only them (案A: no mail draft, no place outside, the minutes route only, its one やること);
 * - the reasons of `decision.json` are strict (codes, labels, duplicates, size);
 * - what the responsible person consents to includes the combination, the check, the Skills it reads and the reasons (T8),
 *   and never a name; the consent of schemas 1–4 is byte for byte what it was (sha256 of the canonical text, computed by
 *   origin/main's core before this change);
 * - the department Skills are places the responsible person must read (`jobDefinitionPaths`).
 */
import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import {
  JOB_MINUTES_ROUTE, JOB_SET_WATCH_OPENED, jobConsentCanonical, jobDefinitionPaths, jobPinnedDepartmentSkills, jobSetWatchLine, parseJobDecisionFile,
  parseJobDefinition, type JobDefinition, type JobSetTrigger,
} from '../../shared/core/jobs'
import { jobTriggerText, setWatchConditionLines, setWatchMissedText, setWatchSummaryLines } from '../../shared/core/job-words'

const TREE = 'b'.repeat(40)
const TREE2 = 'c'.repeat(40)
const OPENED: JobSetTrigger = {
  kind: 'record_set', recordType: 'task', taskKind: 'minutes_review', origin: 'meeting', causes: ['human'], causeRule: 'ledger_v1',
  assignee: 'responsible_from_creation', event: 'first_done', unit: 'record',
  guards: ['after_acceptance', 'attendee_responsible', 'outside_attendee', 'people_only_meeting', 'plugin_step_exclusive'],
}
const DECISION = { reasons: [{ code: 'internal_meeting', label: '社内の会議' }, { code: 'requested', label: '提案を求められた' }, { code: 'other', label: 'その他' }] }

function setWatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 5, name: '提案書のたたき台（商談のあと）', actingUser: 'u-sales',
    trigger: OPENED,
    check: { kind: 'matched_record' },
    run: { kind: 'procedure', procedure: { source: 'department_skill', place: '法人ソリューション', skill: 'sales-proposal-auto', fingerprint: TREE } },
    placement: 'a',
    missed: { policy: 'skip', expiresAfterMinutes: 1440 },
    grant: {
      tools: ['files_read', 'files_write', 'records'], creates: ['task'], routes: [JOB_MINUTES_ROUTE],
      reads: { paths: ['法人ソリューション/提案書'], calls: [], skills: [{ place: '法人ソリューション', skill: 'sales-proposal-v1', fingerprint: TREE2 }] },
      writes: { area: 'deliverable', place: '法人ソリューション', folder: '提案書' }, outbound: 'none', limits: { minutes: 30, runsPerDay: 10 },
    },
    decision: DECISION,
    ...overrides,
  }
}
const grantWith = (g: Record<string, unknown>) => ({ ...(setWatch().grant as Record<string, unknown>), ...g })
const readsWith = (r: Record<string, unknown>) => grantWith({ reads: { ...((setWatch().grant as Record<string, unknown>).reads as Record<string, unknown>), ...r } })
const parsed = (v: unknown): JobDefinition => {
  const r = parseJobDefinition(v)
  if (!r.ok) throw new Error(r.problems.join())
  return r.definition
}
const problems = (v: unknown): string[] => {
  const r = parseJobDefinition(v)
  return r.ok ? [] : r.problems
}
/** A time job run by the PC (schema 1), to put schema 5's pieces where they do not belong. */
function pcJob(): Record<string, unknown> {
  return {
    schema: 1, name: '面談報告書の下書き', actingUser: 'u-mentor',
    trigger: { every: 'day', at: '09:00', businessDaysOnly: true },
    check: { kind: 'new_meetings', titleWords: [] },
    run: { kind: 'procedure', procedure: { source: 'company_skill', skill: 'interview-report', fingerprint: TREE } },
    placement: 'a', missed: { policy: 'latest_only', expiresAfterMinutes: 60 },
    grant: {
      tools: ['records'], creates: ['task'], routes: [JOB_MINUTES_ROUTE], reads: { paths: [], calls: [] }, writes: { area: 'none' },
      outbound: 'none', limits: { minutes: 30, runsPerDay: 1 },
    },
  }
}

describe('the trigger is a combination of fixed words, and only an opened one (T22)', () => {
  it('4b-4’s combination is read exactly, with its reasons and both Skills', () => {
    const d = parsed(setWatch())
    expect(d.trigger).toEqual(OPENED)
    expect(d.decision).toEqual(DECISION)
    expect(jobPinnedDepartmentSkills(d).map(p => p.skill)).toEqual(['sales-proposal-auto', 'sales-proposal-v1'])
  })

  it('a word outside its list is refused, key by key', () => {
    const words: Array<[keyof JobSetTrigger, unknown]> = [
      ['recordType', 'decision'], ['taskKind', 'other'], ['origin', 'mail'], ['causeRule', 'ledger_v2'], ['assignee', 'anyone'],
      ['event', 'any_done'], ['unit', 'meeting'], ['causes', ['human', 'run']], ['causes', []], ['guards', ['no_such_guard']],
      ['causes', 'human'], ['guards', ['outside_attendee', 'outside_attendee']],
    ]
    for (const [key, value] of words) expect(problems(setWatch({ trigger: { ...OPENED, [key]: value } })), key).toEqual([`trigger.${key}.BAD`])
    // An unknown key, a missing one: the parser's strictness, never a condition of its own.
    expect(problems(setWatch({ trigger: { ...OPENED, title: '提案' } }))).toEqual(['trigger.UNKNOWN_KEY'])
    const noEvent: Record<string, unknown> = { ...OPENED }
    delete noEvent.event
    expect(problems(setWatch({ trigger: noEvent }))).toEqual(['trigger.event.MISSING'])
  })

  it('valid words that are not exactly an opened combination are refused: a guard dropped, the order changed', () => {
    expect(problems(setWatch({ trigger: { ...OPENED, guards: OPENED.guards.slice(1) } }))).toEqual(['trigger.NOT_OPENED'])
    expect(problems(setWatch({ trigger: { ...OPENED, guards: [...OPENED.guards].reverse() } }))).toEqual(['trigger.NOT_OPENED'])
    expect(problems(setWatch({ trigger: { ...OPENED, guards: [] } }))).toEqual(['trigger.NOT_OPENED'])
  })

  it('a line taken out of the list closes its combination (nothing else opens it)', () => {
    const removed = (JOB_SET_WATCH_OPENED as JobSetTrigger[]).splice(0, 1)
    try {
      expect(problems(setWatch())).toEqual(['trigger.NOT_OPENED'])
    } finally {
      (JOB_SET_WATCH_OPENED as JobSetTrigger[]).unshift(...removed)
    }
    expect(problems(setWatch())).toEqual([])
  })

  it('schema 5 takes only the set watch; another schema never takes it', () => {
    expect(problems(setWatch({ trigger: { every: 'day', at: '09:00', businessDaysOnly: true } }))).toEqual(['trigger.kind.BAD'])
    expect(problems(setWatch({ trigger: { kind: 'record', type: 'task', event: 'state', to: 'done', assignee: 'responsible', startRecord: 'task-0123456789abcdef', followMadeTask: false } }))).toEqual(['trigger.kind.BAD'])
    expect(problems({ ...pcJob(), schema: 3, trigger: OPENED, check: { kind: 'source_record', doneMark: 'none' } })).toContain('trigger.kind.BAD')
    expect(problems({ ...pcJob(), trigger: OPENED })).toContain('trigger.every.BAD')
  })
})

describe('every piece of schema 5 is its own, and schema 5 takes only those (案A)', () => {
  it('a department Skill, the Skills it reads, the matched-record check and the reasons: never on another schema', () => {
    const dept = { source: 'department_skill', place: '法人ソリューション', skill: 'sales-proposal-auto', fingerprint: TREE }
    expect(problems({ ...pcJob(), run: { kind: 'procedure', procedure: dept } })).toEqual(['run.procedure.DEPARTMENT_SKILL_SET_WATCH_ONLY'])
    const g = pcJob().grant as Record<string, unknown>
    expect(problems({ ...pcJob(), grant: { ...g, reads: { paths: [], calls: [], skills: [{ place: '営業', skill: 'x', fingerprint: TREE }] } } })).toEqual(['grant.reads.skills.SET_WATCH_ONLY'])
    expect(problems({ ...pcJob(), check: { kind: 'matched_record' } })).toEqual(['check.MATCHED_RECORD_SET_WATCH_ONLY'])
    expect(problems({ ...pcJob(), decision: DECISION })).toEqual(['definition.UNKNOWN_KEY'])
  })

  it('schema 5 runs a department Skill, is checked on its matched record, makes its one やること and carries its reasons', () => {
    expect(problems(setWatch({ run: { kind: 'procedure', procedure: { source: 'company_skill', skill: 'x', fingerprint: TREE } } }))).toEqual(['run.SET_WATCH_DEPARTMENT_SKILL'])
    expect(problems(setWatch({ check: { kind: 'source_record', doneMark: 'none' } }))).toEqual(['check.SOURCE_RECORD_EVENTS_ONLY', 'check.SET_WATCH_NEEDS_MATCHED_RECORD'])
    expect(problems(setWatch({ grant: grantWith({ creates: [] }) }))).toEqual(['grant.creates.SET_WATCH_NEEDS_TASK'])
    const noDecision = setWatch()
    delete noDecision.decision
    expect(problems(noDecision)).toEqual(['definition.decision.MISSING'])
  })

  it('its AI reads the minutes only and sends nothing: no mail draft, no place outside, no other route', () => {
    expect(problems(setWatch({ grant: grantWith({ tools: ['files_read', 'files_write', 'records', 'outbound_draft'], outbound: 'draft_only' }) }))).toEqual(['grant.outbound.SET_WATCH_NONE'])
    expect(problems(setWatch({ grant: grantWith({ deliverTo: { connector: 'google', kind: 'drive_folder', ref: null } }) }))).toEqual(['grant.deliverTo.SET_WATCH_NONE'])
    expect(problems(setWatch({ grant: grantWith({ routes: [JOB_MINUTES_ROUTE, 'GET /item/:recordId'] }) }))).toEqual(['grant.routes.SET_WATCH_MINUTES_ONLY'])
    expect(problems(setWatch({ grant: grantWith({ routes: [] }) }))).toEqual(['grant.routes.SET_WATCH_MINUTES_ONLY'])
  })

  it('a Skill pin is one department folder and an ASCII Skill name at a tree id; the Skills read are 1–4, each once', () => {
    const pin = (p: Record<string, unknown>) => setWatch({ run: { kind: 'procedure', procedure: { source: 'department_skill', place: '法人ソリューション', skill: 'sales-proposal-auto', fingerprint: TREE, ...p } } })
    expect(problems(pin({ place: '法人ソリューション/提案書' }))).toEqual(['run.procedure.place.BAD'])
    expect(problems(pin({ place: '..' }))).toEqual(['run.procedure.place.BAD'])
    expect(problems(pin({ place: 'デザイン部'.normalize('NFD') }))).toEqual(['run.procedure.place.BAD'])
    expect(problems(pin({ skill: '提案書' }))).toEqual(['run.procedure.skill.BAD'])
    expect(problems(pin({ fingerprint: 'nope' }))).toEqual(['run.procedure.fingerprint.BAD'])
    const one = { place: '法人ソリューション', skill: 'sales-proposal-v1', fingerprint: TREE2 }
    expect(problems(setWatch({ grant: readsWith({ skills: [] }) }))).toEqual(['grant.reads.skills.BAD'])
    expect(problems(setWatch({ grant: readsWith({ skills: [one, one] }) }))).toEqual(['grant.reads.skills.BAD'])
    expect(problems(setWatch({ grant: readsWith({ skills: [one, { ...one, skill: 'a' }, { ...one, skill: 'b' }, { ...one, skill: 'c' }, { ...one, skill: 'd' }] }) }))).toEqual(['grant.reads.skills.BAD'])
    expect(problems(setWatch({ grant: readsWith({ skills: [{ ...one, extra: 1 }] }) }))).toEqual(['grant.reads.skills.UNKNOWN_KEY'])
    // Without `skills` a schema-5 grant is still a grant (the Skill it runs may read only its own folder).
    const plainReads = { ...(setWatch().grant as Record<string, Record<string, unknown>>).reads }
    delete plainReads.skills
    expect(problems(setWatch({ grant: grantWith({ reads: plainReads }) }))).toEqual([])
  })
})

describe('the reasons a Skill declares (decision.json)', () => {
  const file = (v: unknown) => parseJobDecisionFile(JSON.stringify(v))
  it('strict: codes lower-case ASCII and unique, labels one NFC line, 1–20, nothing else', () => {
    expect(file(DECISION)).toEqual(DECISION)
    expect(file({ reasons: [] })).toBeNull()
    expect(file({ reasons: [{ code: 'GATE_UNAVAILABLE', label: '判断できなかった' }] })).toBeNull()
    expect(file({ reasons: [{ code: 'a', label: 'x' }, { code: 'a', label: 'y' }] })).toBeNull()
    expect(file({ reasons: [{ code: 'a', label: '' }] })).toBeNull()
    expect(file({ reasons: [{ code: 'a', label: ' 前後に空白 ' }] })).toBeNull()
    expect(file({ reasons: [{ code: 'a', label: '改行\nあり' }] })).toBeNull()
    expect(file({ reasons: [{ code: 'a', label: 'x'.repeat(41) }] })).toBeNull()
    expect(file({ reasons: [{ code: 'a', label: 'x', why: 'y' }] })).toBeNull()
    expect(file({ reasons: Array.from({ length: 21 }, (_, i) => ({ code: `r${i}`, label: 'x' })) })).toBeNull()
    expect(file({ reasons: DECISION.reasons, version: 2 })).toBeNull()
    expect(parseJobDecisionFile('{ not json')).toBeNull()
    expect(parseJobDecisionFile(JSON.stringify(DECISION) + ' '.repeat(17 * 1024))).toBeNull()
    expect(problems(setWatch({ decision: { reasons: [{ code: 'Bad', label: 'x' }] } }))).toEqual(['decision.BAD'])
  })
})

describe('what the responsible person consents to (§2-6, T8)', () => {
  it('the combination, the check, the Skills it runs and reads, and the reasons are in it; the name is not', () => {
    const base = parsed(setWatch())
    const consent = jobConsentCanonical(base)
    expect(jobConsentCanonical(parsed(setWatch({ name: '別の名前' })))).toBe(consent)
    const changed = (d: Partial<JobDefinition>) => jobConsentCanonical({ ...base, ...d } as JobDefinition)
    expect(changed({ trigger: { ...OPENED, guards: OPENED.guards.slice(1) } })).not.toBe(consent)
    expect(changed({ trigger: { ...OPENED, causes: ['human', 'other'] } })).not.toBe(consent)
    expect(changed({ check: { kind: 'none' } })).not.toBe(consent)
    expect(changed({ decision: { reasons: DECISION.reasons.slice(1) } })).not.toBe(consent)
    expect(jobConsentCanonical(parsed(setWatch({ grant: readsWith({ skills: [{ place: '法人ソリューション', skill: 'sales-proposal-v1', fingerprint: TREE }] }) })))).not.toBe(consent)
    expect(jobConsentCanonical(parsed(setWatch({ run: { kind: 'procedure', procedure: { source: 'department_skill', place: '法人ソリューション', skill: 'sales-proposal-auto', fingerprint: TREE2 } } })))).not.toBe(consent)
  })

  it('schemas 1–4 consent byte for byte what they did before the set watch (sha256 from origin/main’s core)', () => {
    const FP = 'a'.repeat(40)
    const pc = {
      schema: 1, name: '面談報告書の下書き（A社）', actingUser: 'u-mentor',
      trigger: { every: 'week', weekday: 'tue', at: '09:00', businessDaysBefore: 1 },
      check: { kind: 'new_files', path: '支援/A社/文字起こし' },
      run: { kind: 'procedure', procedure: { source: 'company_skill', skill: 'interview-report', fingerprint: FP } },
      placement: 'a', missed: { policy: 'latest_only', expiresAfterMinutes: 1620 },
      grant: {
        tools: ['files_read', 'files_write', 'records'], creates: ['task'], routes: ['POST /item', 'GET /item/:recordId'],
        reads: { paths: ['支援/A社/文字起こし'], calls: [] }, writes: { area: 'deliverable', place: '支援', folder: 'reports' },
        outbound: 'none', limits: { minutes: 30, runsPerDay: 1 },
      },
    }
    const server = {
      schema: 1, name: 'PC の棚卸し', actingUser: 'u-admin',
      trigger: { every: 'month', day: 1, at: '09:00', ifHoliday: 'after' },
      check: { kind: 'none' },
      run: { kind: 'operation', operation: 'create_task', title: 'PC の棚卸しをする', dueBusinessDays: 5 },
      placement: 'e', missed: { policy: 'skip', expiresAfterMinutes: 60 },
      grant: { tools: [], creates: ['task'], routes: [], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 1, runsPerDay: 1 } },
    }
    const trigger = { kind: 'record', type: 'task', event: 'state', to: 'done', assignee: 'responsible', startRecord: 'task-0123456789abcdef', followMadeTask: true }
    const sha = (v: unknown) => createHash('sha256').update(jobConsentCanonical(parsed(v))).digest('hex')
    expect(sha(pc)).toBe('4a0975b74f33ae3b5971d2ada5a2074f4a97f43d6904e2752ce6164dfc96e677')
    expect(sha(server)).toBe('574c9d2419bcf2db0c7a985fb5373b4038e175f03a86feb8f9a0cbc34389a530')
    expect(sha({ ...server, schema: 2, trigger })).toBe('a7c22ed1ed780cc67fe485e176e04c277801fafaf2e466affc0b88b9d6b8e860')
    expect(sha({ ...pc, schema: 3, trigger, check: { kind: 'source_record', doneMark: 'file_linked' } })).toBe('5eea6072921dca9e4ddbed202c618b25adfb119a71ee093a38d80178a897de83')
    expect(sha({ ...pc, schema: 4, origin: 'member_proposal' })).toBe('4a0975b74f33ae3b5971d2ada5a2074f4a97f43d6904e2752ce6164dfc96e677')
  })
})

describe('the places a set watch names', () => {
  it('both department Skills are places the responsible person must read', () => {
    expect(jobDefinitionPaths(parsed(setWatch()))).toEqual(expect.arrayContaining([
      '法人ソリューション/.claude/skills/sales-proposal-auto', '法人ソリューション/.claude/skills/sales-proposal-v1',
    ]))
  })
})

describe('the words', () => {
  it('the opened combination in plain words; any other is never described as if it were it', () => {
    expect(jobTriggerText(OPENED)).toContain('「議事録を確認する」を初めて完了したとき')
    expect(jobTriggerText({ ...OPENED, guards: [] })).not.toContain('議事録')
  })

  it('every guard of each opened line has its words (never 「説明できない」 for an opened line; Codex review of 4b-4 A3)', () => {
    for (const t of JOB_SET_WATCH_OPENED) {
      const lines = setWatchConditionLines(t)
      expect(lines.length, t.event).toBe(4 + t.guards.length)
      for (const l of lines) expect(l, t.event).not.toContain('説明できない')
    }
  })
})

// ── 4b-4 A3: the second line, 「自分が担当の会議の議事録を、AI が初めて読み終えたとき」 (owner decision D2, 2026-11-25) ──
const FIRST_READ: JobSetTrigger = {
  kind: 'record_set', recordType: 'meeting', taskKind: 'meeting', origin: 'meeting', causes: ['reader_ai'], causeRule: 'reader_v1',
  assignee: 'attendee', event: 'first_read', unit: 'record',
  guards: ['after_acceptance', 'attendee_responsible', 'outside_attendee', 'people_only_meeting', 'plugin_step_exclusive'],
}

describe('the second line (4b-4 A3): the AI of the meeting’s assignee reading it for the first time', () => {
  it('is opened beside the first, which stays exactly as it was; each is told apart by its words', () => {
    expect(parsed(setWatch({ trigger: FIRST_READ })).trigger).toEqual(FIRST_READ)
    expect(parsed(setWatch()).trigger).toEqual(OPENED)
    expect(jobSetWatchLine(FIRST_READ)).toBe('first_read')
    expect(jobSetWatchLine(OPENED)).toBe('review_done')
  })

  it('words of one line mixed into the other are no opened combination (never a line of their own)', () => {
    for (const [key, value] of [['recordType', 'meeting'], ['taskKind', 'meeting'], ['causes', ['reader_ai']], ['causeRule', 'reader_v1'], ['assignee', 'attendee'], ['event', 'first_read']] as const) {
      expect(problems(setWatch({ trigger: { ...OPENED, [key]: value } })), key).toEqual(['trigger.NOT_OPENED'])
    }
    for (const [key, value] of [['recordType', 'task'], ['causes', ['human']], ['causes', ['human', 'reader_ai']], ['causeRule', 'ledger_v1'], ['assignee', 'responsible_from_creation'], ['event', 'first_done']] as const) {
      const t = { ...FIRST_READ, [key]: value } as JobSetTrigger
      expect(problems(setWatch({ trigger: t })), key).toEqual(['trigger.NOT_OPENED'])
      expect(jobSetWatchLine(t), key).toBeNull()
    }
    expect(problems(setWatch({ trigger: { ...FIRST_READ, guards: FIRST_READ.guards.slice(1) } }))).toEqual(['trigger.NOT_OPENED'])
  })

  it('taken out, only it closes; the first line stays open (a build that knows schema 5 but not this line)', () => {
    const i = JOB_SET_WATCH_OPENED.findIndex(t => t.event === 'first_read')
    const removed = (JOB_SET_WATCH_OPENED as JobSetTrigger[]).splice(i, 1)
    try {
      expect(problems(setWatch({ trigger: FIRST_READ }))).toEqual(['trigger.NOT_OPENED'])
      expect(jobSetWatchLine(FIRST_READ)).toBeNull()
      expect(jobTriggerText(FIRST_READ)).not.toContain('議事録')
      expect(problems(setWatch())).toEqual([])
    } finally {
      (JOB_SET_WATCH_OPENED as JobSetTrigger[]).splice(i, 0, ...removed)
    }
  })

  it('its consent is another than the first line’s (another 受け取る)', () => {
    const a = jobConsentCanonical(parsed(setWatch()))
    const b = jobConsentCanonical(parsed(setWatch({ trigger: FIRST_READ })))
    expect(a).not.toEqual(b)
    expect(b).toContain('first_read')
  })

  it('its own words: when, the conditions and the wait — never the first line’s 「議事録を確認する」 completion', () => {
    expect(jobTriggerText(FIRST_READ)).toMatch(/^自分が出た会議の議事録を、出た人のだれかの AI が初めて読み終えたとき/)
    const lines = setWatchConditionLines(FIRST_READ)
    expect(lines.join('\n')).toContain('会議に出た人（担当を含む）のだれかの AI が議事録を読み終えたとき')
    expect(lines.join('\n')).not.toContain('完了したときだけ')
    expect(lines).toContain('責任者が受け取ったあとに、AI が初めて読み終えた会議だけ（受け取る前に届いた会議でも、読み終えたのが受け取ったあとなら動きます）')
    expect(setWatchSummaryLines(parsed(setWatch({ trigger: FIRST_READ })), 'responsible')[0]).toContain('出た人のだれかの AI が読み終えたあと')
    expect(setWatchSummaryLines(parsed(setWatch()), 'responsible')[0]).toContain('「議事録を確認する」が完了したあと')
    expect(setWatchMissedText(1440, FIRST_READ)).toMatch(/^読み終えたあと/)
    expect(setWatchMissedText(1440, OPENED)).toMatch(/^完了のあと/)
  })
})
