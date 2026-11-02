/**
 * shared/core/business-days.ts and shared/core/task-settings.ts: business days
 * (weekends, Japanese public holidays calculated without a network call,
 * company holidays) and the reply 目安 (`replyTarget`) a message without a
 * deadline gets. A wrong holiday or cutoff here moves every member's due
 * dates. Also each member's own switches (shared/core/work-switches.ts): the
 * company's 使ってよいか always wins, and an older settings document keeps reading.
 */
import { describe, expect, it } from 'vitest'
import { isBusinessDay, isCalendarDate, japaneseHolidays, nextBusinessDay } from '../../shared/core/business-days'
import { DEFAULT_TASK_SETTINGS, defaultTaskSettings, parseTaskSettings, replyTarget, workSwitchPoliciesOf, type ReplySettings } from '../../shared/core/task-settings'
import { chooseWorkSwitch, parseWorkSwitchChoices, workSwitchOn } from '../../shared/core/work-switches'

/**
 * The Cabinet Office's published lists (内閣府「国民の祝日について」) for 2026
 * and 2027, and the lists the current law gives for 2028–2030 (equinoxes as
 * the National Astronomical Observatory's calendar estimates them).
 */
const PUBLISHED: Record<number, string[]> = {
  2026: ['01-01', '01-12', '02-11', '02-23', '03-20', '04-29', '05-03', '05-04', '05-05', '05-06', '07-20', '08-11', '09-21', '09-22', '09-23', '10-12', '11-03', '11-23'],
  2027: ['01-01', '01-11', '02-11', '02-23', '03-21', '03-22', '04-29', '05-03', '05-04', '05-05', '07-19', '08-11', '09-20', '09-23', '10-11', '11-03', '11-23'],
  2028: ['01-01', '01-10', '02-11', '02-23', '03-20', '04-29', '05-03', '05-04', '05-05', '07-17', '08-11', '09-18', '09-22', '10-09', '11-03', '11-23'],
  2029: ['01-01', '01-08', '02-11', '02-12', '02-23', '03-20', '04-29', '04-30', '05-03', '05-04', '05-05', '07-16', '08-11', '09-17', '09-23', '09-24', '10-08', '11-03', '11-23'],
  2030: ['01-01', '01-14', '02-11', '02-23', '03-20', '04-29', '05-03', '05-04', '05-05', '05-06', '07-15', '08-11', '08-12', '09-16', '09-23', '10-14', '11-03', '11-04', '11-23'],
}

describe('each member\'s own switches (work-switches.ts)', () => {
  it('the company not allowing a switch: off for everyone, nobody can turn it on; turning off is always kept', () => {
    const settings = defaultTaskSettings()
    settings.autoRun.enabled = false
    const policies = workSwitchPoliciesOf(settings)
    expect(workSwitchOn(policies.autoRun, true)).toBe(false)
    expect(chooseWorkSwitch(policies, {}, 'autoRun', true)).toEqual({ refused: 'company-off' })
    expect(chooseWorkSwitch(policies, { readIncoming: true }, 'autoRun', false)).toEqual({ value: { readIncoming: true, autoRun: false } })
  })

  it('a member who never chose has the company\'s 初めの値; their own choice wins over it', () => {
    const policies = workSwitchPoliciesOf(defaultTaskSettings())
    expect([workSwitchOn(policies.readIncoming, undefined), workSwitchOn(policies.autoRun, undefined)]).toEqual([false, true])
    expect([workSwitchOn(policies.readIncoming, true), workSwitchOn(policies.autoRun, false)]).toEqual([true, false])
    // A stored document with anything but a boolean is "never chose".
    expect(parseWorkSwitchChoices({ readIncoming: 'on', autoRun: false, other: true })).toEqual({ autoRun: false })
  })
})

describe('Japanese public holidays (calculated, no network)', () => {
  for (const [year, days] of Object.entries(PUBLISHED)) {
    it(`${year} matches the published list, substitute and in-between days included`, () => {
      expect([...japaneseHolidays(Number(year)).keys()]).toEqual(days.map(d => `${year}-${d}`))
    })
  }

  it('names the substitute and in-between days', () => {
    expect(japaneseHolidays(2026).get('2026-05-06')).toBe('休日（振替休日）')
    expect(japaneseHolidays(2026).get('2026-09-22')).toBe('国民の休日')
  })
})

describe('business days', () => {
  it('weekends, public holidays and the company’s own holidays are off', () => {
    expect(isBusinessDay('2026-11-02')).toBe(true) // Monday
    expect(isBusinessDay('2026-11-07')).toBe(false) // Saturday
    expect(isBusinessDay('2026-11-08')).toBe(false) // Sunday
    expect(isBusinessDay('2026-11-03')).toBe(false) // 文化の日 (Tuesday)
    expect(isBusinessDay('2026-11-04', ['2026-11-04'])).toBe(false)
  })

  it('the next business day skips a long weekend and company holidays', () => {
    expect(nextBusinessDay('2026-05-01')).toBe('2026-05-07') // Fri → over GW (5/2–5/6)
    expect(nextBusinessDay('2026-12-28', ['2026-12-29', '2026-12-30', '2026-12-31', '2027-01-04'])).toBe('2027-01-05')
  })

  it('accepts only real calendar dates', () => {
    expect(isCalendarDate('2028-02-29')).toBe(true)
    expect(isCalendarDate('2026-02-29')).toBe(false)
    expect(isCalendarDate('2026-13-01')).toBe(false)
    expect(isCalendarDate('2026-1-01')).toBe(false)
  })
})

const NEXT: ReplySettings = { rule: 'next-business-day', sameDayCutoff: '17:00' }
const SAME: ReplySettings = { rule: 'same-day', sameDayCutoff: '17:00' }
/** An instant given as Japan time. */
const jst = (local: string) => `${local}+09:00`

describe('replyTarget (返事の目安)', () => {
  it('翌営業日: a message on a weekday is due the next weekday', () => {
    expect(replyTarget(jst('2026-11-05T10:00:00'), NEXT).date).toBe('2026-11-06')
  })

  it('翌営業日: Friday and the weekend → Monday', () => {
    expect(replyTarget(jst('2026-11-06T18:00:00'), NEXT).date).toBe('2026-11-09')
    expect(replyTarget(jst('2026-11-07T09:00:00'), NEXT).date).toBe('2026-11-09')
    expect(replyTarget(jst('2026-11-08T23:59:00'), NEXT).date).toBe('2026-11-09')
  })

  it('翌営業日 over a holiday: Monday 11/2 → Wednesday 11/4 (11/3 文化の日)', () => {
    expect(replyTarget(jst('2026-11-02T09:00:00'), NEXT).date).toBe('2026-11-04')
  })

  it('翌営業日 over a company holiday', () => {
    expect(replyTarget(jst('2026-11-04T09:00:00'), NEXT, ['2026-11-05']).date).toBe('2026-11-06')
  })

  it('当日中: before the cutoff → the same day; at or after it → the next business day', () => {
    expect(replyTarget(jst('2026-11-05T16:59:00'), SAME).date).toBe('2026-11-05')
    expect(replyTarget(jst('2026-11-05T17:00:00'), SAME).date).toBe('2026-11-06')
    expect(replyTarget(jst('2026-11-05T17:30:00'), SAME).date).toBe('2026-11-06')
    expect(replyTarget(jst('2026-11-05T11:59:00'), { rule: 'same-day', sameDayCutoff: '12:00' }).date).toBe('2026-11-05')
    expect(replyTarget(jst('2026-11-05T12:00:00'), { rule: 'same-day', sameDayCutoff: '12:00' }).date).toBe('2026-11-06')
  })

  it('当日中 on a day off (weekend, holiday, company holiday) → the next business day, even before the cutoff', () => {
    expect(replyTarget(jst('2026-11-07T09:00:00'), SAME).date).toBe('2026-11-09')
    expect(replyTarget(jst('2026-11-03T09:00:00'), SAME).date).toBe('2026-11-04')
    expect(replyTarget(jst('2026-11-04T09:00:00'), SAME, ['2026-11-04']).date).toBe('2026-11-05')
  })

  it('uses Japan’s date, not the server’s: 2026-11-05 23:30 UTC is Friday 08:30 in Japan', () => {
    expect(replyTarget('2026-11-05T23:30:00.000Z', SAME).date).toBe('2026-11-06')
    expect(replyTarget('2026-11-05T23:30:00.000Z', NEXT).date).toBe('2026-11-09')
  })

  it('due at the end of that day in Japan', () => {
    expect(replyTarget(jst('2026-11-05T10:00:00'), NEXT).dueAt).toBe('2026-11-06T14:59:59.999Z')
  })

  it('refuses an invalid time instead of guessing', () => {
    expect(() => replyTarget('yesterday', NEXT)).toThrow()
  })
})

describe('parseTaskSettings', () => {
  it('the defaults: every department, 翌営業日, 17:00, auto-run on (owner decision)', () => {
    expect(DEFAULT_TASK_SETTINGS).toEqual({
      taskListDepartmentIds: null,
      reply: { rule: 'next-business-day', sameDayCutoff: '17:00' },
      autoRun: { enabled: true, memberDefault: true, dailyLimit: 30, stopAfterFailures: 3 },
      // Owner decision 2026-11-02: 受信を読む allowed, each member starts off.
      readIncoming: { allowed: true, memberDefault: false },
      acceptance: { sameDepartment: true, managerToMember: true, meetingHomework: true },
      companyHolidays: [],
    })
    expect(parseTaskSettings(defaultTaskSettings())).toEqual({ value: DEFAULT_TASK_SETTINGS })
  })

  it('a document saved before 引き受け keeps its other answers (the acceptance defaults are added); a bad switch is refused', () => {
    const before: Record<string, unknown> = { ...defaultTaskSettings(), autoRun: { enabled: false, dailyLimit: 9, stopAfterFailures: 2 } }
    delete before.acceptance
    delete before.readIncoming
    expect(parseTaskSettings(before)).toEqual({
      value: {
        ...before, autoRun: { enabled: false, memberDefault: true, dailyLimit: 9, stopAfterFailures: 2 },
        readIncoming: DEFAULT_TASK_SETTINGS.readIncoming, acceptance: DEFAULT_TASK_SETTINGS.acceptance,
      },
    })
    expect(parseTaskSettings({ ...defaultTaskSettings(), readIncoming: { allowed: 'yes', memberDefault: false } })).toHaveProperty('error')
    expect(parseTaskSettings({ ...defaultTaskSettings(), autoRun: { ...DEFAULT_TASK_SETTINGS.autoRun, memberDefault: 1 } })).toHaveProperty('error')
    expect(parseTaskSettings({ ...defaultTaskSettings(), acceptance: { sameDepartment: 'yes', managerToMember: true, meetingHomework: true } })).toHaveProperty('error')
    expect(parseTaskSettings({ ...defaultTaskSettings(), acceptance: { sameDepartment: true, managerToMember: true } })).toHaveProperty('error')
  })

  it('sorts holidays and trims their names', () => {
    const r = parseTaskSettings({ ...defaultTaskSettings(), companyHolidays: [{ date: '2026-12-31', name: ' 年末 ' }, { date: '2026-08-13', name: '夏季休業' }] })
    expect(r).toEqual({ value: expect.objectContaining({ companyHolidays: [{ date: '2026-08-13', name: '夏季休業' }, { date: '2026-12-31', name: '年末' }] }) })
  })

  it.each([
    ['a missing reply', { ...defaultTaskSettings(), reply: undefined }],
    ['an unknown rule', { ...defaultTaskSettings(), reply: { rule: 'someday', sameDayCutoff: '17:00' } }],
    ['a cutoff that is not HH:MM', { ...defaultTaskSettings(), reply: { rule: 'same-day', sameDayCutoff: '24:00' } }],
    ['a daily limit of 0', { ...defaultTaskSettings(), autoRun: { enabled: true, dailyLimit: 0, stopAfterFailures: 3 } }],
    ['a fractional failure count', { ...defaultTaskSettings(), autoRun: { enabled: true, dailyLimit: 5, stopAfterFailures: 1.5 } }],
    ['enabled as a string', { ...defaultTaskSettings(), autoRun: { enabled: 'yes', dailyLimit: 5, stopAfterFailures: 3 } }],
    ['an impossible date', { ...defaultTaskSettings(), companyHolidays: [{ date: '2026-02-30', name: '' }] }],
    ['a date listed twice', { ...defaultTaskSettings(), companyHolidays: [{ date: '2026-08-13', name: '' }, { date: '2026-08-13', name: 'x' }] }],
    ['a typing-mistake year', { ...defaultTaskSettings(), companyHolidays: [{ date: '2926-08-13', name: '' }] }],
    ['department ids that are not strings', { ...defaultTaskSettings(), taskListDepartmentIds: [1] }],
  ])('refuses %s', (_label, input) => {
    expect(parseTaskSettings(input)).toHaveProperty('error')
  })
})
