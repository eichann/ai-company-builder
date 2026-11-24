/**
 * 「届いた議事録を AI が自動で読む」's stored side and its one rule (minutes.md "Automatic reading by the
 * member's setting"), each mutation-checked:
 * - the members of every company when the setting is made start at 「自動では読まない」, once (owner
 *   decision D1-1); a member who joins later has no row (→ 「社外の人がいる会議だけ」), and a later start
 *   changes nobody's row;
 * - the series' choice is stronger than the setting both ways; 「社外の人がいる会議だけ」 reads the stored
 *   count the set watch's `outside_attendee` guard reads;
 * - a series' 読む / 読まない are never both kept; a member leaving takes their choices with them.
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase, migrateMeetingAutoRead } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { hasOutsideAttendee, meetingAutoReads } from '../../../shared/core/minutes'

const at = '2026-11-25T00:00:00.000Z'
function company(conn: Database.Database, id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, `${id}-owner`, at, at)
}
function member(conn: Database.Database, companyId: string, userId: string) {
  conn.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${companyId}-${userId}`, userId, companyId, 'member', at, at)
}
const rows = (conn: Database.Database) => conn.prepare('SELECT company_id, user_id, mode, chosen FROM meeting_auto_read ORDER BY company_id, user_id').all()

describe('the starting value (owner decision D1-1)', () => {
  it('members of every company when the setting is made start at off, once; a later member has no row', () => {
    const conn = new Database(':memory:')
    initDatabase(conn)
    // A database from before the setting: the table is not there yet, members are.
    conn.exec('DROP TABLE meeting_auto_read')
    company(conn, 'a'); company(conn, 'b')
    member(conn, 'a', 'alice'); member(conn, 'b', 'bob')
    migrateMeetingAutoRead(conn)
    expect(rows(conn)).toEqual([
      { company_id: 'a', user_id: 'alice', mode: 'off', chosen: 0 },
      { company_id: 'b', user_id: 'bob', mode: 'off', chosen: 0 },
    ])
    // Alice chooses; Carol joins; the server starts again: nothing else changes.
    sqliteCompanyData(conn).forCompany('a').records.setMeetingAutoRead('alice', 'all', at)
    member(conn, 'a', 'carol')
    initDatabase(conn)
    expect(rows(conn)).toEqual([
      { company_id: 'a', user_id: 'alice', mode: 'all', chosen: 1 },
      { company_id: 'b', user_id: 'bob', mode: 'off', chosen: 0 },
    ])
    expect(sqliteCompanyData(conn).forCompany('a').records.meetingAutoRead('carol')).toBeNull()
  })
})

describe('one rule', () => {
  it('the series first both ways, then the setting; 「社外だけ」 by the stored count', () => {
    for (const mode of ['outside', 'all', 'off'] as const) {
      expect(meetingAutoReads({ series: 'auto', mode, externalCount: 0 })).toBe(true)
      expect(meetingAutoReads({ series: 'off', mode, externalCount: 3 })).toBe(false)
    }
    expect(meetingAutoReads({ series: null, mode: 'all', externalCount: 0 })).toBe(true)
    expect(meetingAutoReads({ series: null, mode: 'off', externalCount: 3 })).toBe(false)
    expect(meetingAutoReads({ series: null, mode: 'outside', externalCount: 2 })).toBe(true)
    expect(meetingAutoReads({ series: null, mode: 'outside', externalCount: 0 })).toBe(false)
    // Nothing stored, or not a number: no one from outside (never reads more than chosen).
    for (const n of [null, undefined, '2', -1, Number.NaN]) {
      expect(hasOutsideAttendee(n)).toBe(false)
      expect(meetingAutoReads({ series: null, mode: 'outside', externalCount: n })).toBe(false)
    }
  })
})

describe('the series\' choices', () => {
  it('読む and 読まない are never both kept; null keeps neither; a member leaving takes their choices and setting', () => {
    const conn = new Database(':memory:')
    initDatabase(conn)
    company(conn, 'a')
    member(conn, 'a', 'alice')
    const records = sqliteCompanyData(conn).forCompany('a').records
    records.setMeetingSeriesChoice('alice', 's1', 'off', at)
    expect([...records.meetingSeriesChoices('alice')]).toEqual([['s1', 'off']])
    records.setMeetingSeriesChoice('alice', 's1', 'auto', at)
    expect([...records.meetingSeriesChoices('alice')]).toEqual([['s1', 'auto']])
    expect(conn.prepare('SELECT COUNT(*) AS n FROM meeting_series_off').get()).toEqual({ n: 0 })
    records.setMeetingSeriesChoice('alice', 's1', 'off', at)
    expect(conn.prepare('SELECT COUNT(*) AS n FROM meeting_auto_series').get()).toEqual({ n: 0 })
    records.setMeetingSeriesChoice('alice', 's1', null, at)
    expect(records.meetingSeriesChoices('alice').size).toBe(0)
    records.setMeetingSeriesChoice('alice', 's2', 'off', at)
    records.setMeetingAutoRead('alice', 'all', at)
    records.forgetMember('alice')
    expect(records.meetingSeriesChoices('alice').size).toBe(0)
    expect(records.meetingAutoRead('alice')).toBeNull()
  })
})
