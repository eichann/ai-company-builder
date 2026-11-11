/**
 * When a scheduled job's occurrences fall (shared/core/job-schedule.ts, jobs.md "The clock"): company
 * time, business days (weekends, Japanese public holidays, the company's days off), month ends and
 * week shapes, across month and year boundaries. Each case fails when its rule is removed
 * (mutation-checked: the business-day move, `ifHoliday`, `last`, the inclusive bound).
 */
import { describe, expect, it } from 'vitest'
import { jobSlotDates, latestJobSlot, nextJobSlot } from '../../../shared/core/job-schedule'
import { previousBusinessDay } from '../../../shared/core/business-days'
import type { JobTrigger } from '../../../shared/core/jobs'

const day = (at = '09:00', businessDaysOnly = false): JobTrigger => ({ every: 'day', at, businessDaysOnly })
const week = (weekday: 'mon' | 'tue' | 'fri', businessDaysBefore: number, at = '09:00'): JobTrigger => ({ every: 'week', weekday, at, businessDaysBefore })
const month = (d: number | 'last', ifHoliday: 'as_is' | 'before' | 'after', at = '09:00'): JobTrigger => ({ every: 'month', day: d, at, ifHoliday })

describe('a slot is company time, at or before now', () => {
  it('the slot itself counts at its minute; a minute before, the one before it', () => {
    expect(latestJobSlot(day(), '2026-11-16T09:00')).toBe('2026-11-16T09:00')
    expect(latestJobSlot(day(), '2026-11-16T08:59')).toBe('2026-11-15T09:00')
    expect(nextJobSlot(day(), '2026-11-16T09:00')).toBe('2026-11-17T09:00')
  })

  it('a day just after midnight: yesterday’s late slot', () => {
    expect(latestJobSlot(day('23:55'), '2026-11-17T00:03')).toBe('2026-11-16T23:55')
  })
})

describe('business days', () => {
  it('every business day skips weekends, public holidays and the company’s days off', () => {
    // 2026-11-23 (Mon) is 勤労感謝の日; 11-14/15 a weekend.
    expect(latestJobSlot(day('09:00', true), '2026-11-15T12:00')).toBe('2026-11-13T09:00')
    expect(latestJobSlot(day('09:00', true), '2026-11-23T12:00')).toBe('2026-11-20T09:00')
    expect(latestJobSlot(day('09:00', true), '2026-11-24T12:00', ['2026-11-24'])).toBe('2026-11-20T09:00')
  })

  it('the business day before', () => {
    expect(previousBusinessDay('2026-11-24')).toBe('2026-11-20')
    expect(previousBusinessDay('2027-01-04')).toBe('2026-12-31')
  })
})

describe('week shapes', () => {
  it('「火曜の1営業日前」 is Monday — or the Friday before when Monday is a holiday', () => {
    expect(jobSlotDates(week('tue', 1), '2026-11-09', '2026-11-29')).toEqual(['2026-11-09', '2026-11-16', '2026-11-20'])
  })

  it('no move (0): the weekday itself, holiday or not', () => {
    expect(jobSlotDates(week('mon', 0), '2026-11-16', '2026-11-29')).toEqual(['2026-11-16', '2026-11-23'])
  })

  it('five business days before, across a holiday week and the year end (the company’s days off)', () => {
    const off = ['2026-12-29', '2026-12-30', '2026-12-31', '2027-01-02', '2027-01-03']
    // Friday 2027-01-08 − 5 business days, skipping 1/1 and the company's 12/29–12/31 → 12/28.
    expect(jobSlotDates(week('fri', 5), '2026-12-20', '2027-01-08', off)).toContain('2026-12-28')
  })
})

describe('month shapes', () => {
  it('the last day of each month (February and a leap year)', () => {
    expect(jobSlotDates(month('last', 'as_is'), '2027-01-15', '2027-03-31')).toEqual(['2027-01-31', '2027-02-28', '2027-03-31'])
    expect(jobSlotDates(month('last', 'as_is'), '2028-02-01', '2028-02-29')).toEqual(['2028-02-29'])
  })

  it('a day off moves before or after — across the month and the year', () => {
    // 2027-01-31 is a Sunday.
    expect(jobSlotDates(month('last', 'before'), '2027-01-15', '2027-02-10')).toEqual(['2027-01-29'])
    expect(jobSlotDates(month('last', 'after'), '2027-01-15', '2027-02-10')).toEqual(['2027-02-01'])
    // 2027-01-01 (元日) is a Friday: before → 2026-12-31, after → 2027-01-04.
    expect(latestJobSlot(month(1, 'before'), '2027-01-01T08:00')).toBe('2026-12-31T09:00')
    expect(latestJobSlot(month(1, 'after'), '2027-01-04T09:00')).toBe('2027-01-04T09:00')
    expect(latestJobSlot(month(1, 'as_is'), '2027-01-01T09:00')).toBe('2027-01-01T09:00')
  })

  it('a shift back across the month or year end is found while the window ends before it (December → January)', () => {
    // 2027-01-01 (元日) moves back to 2026-12-31: on that day, after 09:00, it is the newest slot — not 12-01.
    expect(latestJobSlot(month(1, 'before'), '2026-12-31T09:05')).toBe('2026-12-31T09:00')
    expect(latestJobSlot(month(1, 'before'), '2026-12-31T10:00')).toBe('2026-12-31T09:00')
    expect(nextJobSlot(month(1, 'before'), '2026-12-20T00:00')).toBe('2026-12-31T09:00')
    expect(latestJobSlot(month(1, 'before'), '2026-12-31T08:00')).toBe('2026-12-01T09:00')
    expect(nextJobSlot(month(1, 'before'), '2026-12-15T10:00')).toBe('2026-12-31T09:00')
    expect(jobSlotDates(month(1, 'before'), '2026-12-01', '2026-12-31')).toEqual(['2026-12-01', '2026-12-31'])
    // Mid-year: 2026-08-01 is a Saturday → Friday 07-31.
    expect(latestJobSlot(month(1, 'before'), '2026-07-31T10:00')).toBe('2026-07-31T09:00')
    // Forward across the end: 2027-01-31 (Sunday) → 02-01; from the window's start side, 2026-11-01 (Sunday) → 11-02.
    expect(jobSlotDates(month('last', 'after'), '2027-02-01', '2027-02-10')).toEqual(['2027-02-01'])
    expect(jobSlotDates(month(1, 'after'), '2026-11-02', '2026-11-05')).toEqual(['2026-11-02'])
  })

  it('the newest slot after a long gap is still found (a month and more back)', () => {
    expect(latestJobSlot(month(15, 'as_is'), '2027-01-10T09:00')).toBe('2026-12-15T09:00')
  })
})
