/**
 * Each member's own switches (自分の設定: 受信を読む, AI が自動で進める; services/work-switches.ts,
 * shared/core/work-switches.ts) on the real schema.
 *
 * What it protects:
 * - turning the company's 受信を読む 初めの値 to "off" changes nothing for a member who reads
 *   incoming messages today: when the table is first made, Google's 受信を読む granted (and not
 *   turned off) or Slack's reading granted becomes their own choice "on"; Google's own 受信を読む
 *   toggle turned off carries over as "off"; it runs once and never overwrites a later choice;
 * - a member cannot turn on what the company does not allow (409, nothing stored), and their
 *   choice of off stands when the company allows it again;
 * - one member's choice is theirs alone, and another company's member is a stranger.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase, migrateMemberWorkSwitches } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { createWorkSwitches, type WorkSwitches } from '../../src/services/work-switches'
import { defaultTaskSettings, type TaskSettings } from '../../../shared/core/task-settings'
import type { Member } from '../../src/services/access'

const TS = '2026-11-02T00:00:00.000Z'
const GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly'
const SLACK_READ = ['users:read', 'users:read.email', 'im:history', 'mpim:history', 'channels:history', 'groups:history']

let conn: Database.Database
let settings: Record<string, TaskSettings>
let switches: WorkSwitches
const m = (userId: string, co = 'a'): Member => ({ companyId: co, userId, role: 'member' })

function grant(co: string, userId: string, provider: 'google' | 'slack', scopes: string[], featuresOff: string[] = [], status = 'active') {
  conn.prepare(`INSERT INTO connector_grants (company_id, user_id, provider, grant_id, account_email, scopes, features_off, refresh_token_sealed, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(co, userId, provider, `${co}-${userId}-${provider}`, `${userId}@example.com`, JSON.stringify(scopes), JSON.stringify(featuresOff), status === 'active' ? '{}' : null, status, TS, TS)
}

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  for (const co of ['a', 'b']) conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, 'u-owner', TS, TS)
  settings = { a: defaultTaskSettings(), b: defaultTaskSettings() }
  switches = createWorkSwitches({
    companyData: sqliteCompanyData(conn),
    clock: { now: () => TS, nowMs: () => Date.parse(TS) },
    settingsOf: co => settings[co],
  })
})

describe('the carry-over when the table is first made', () => {
  it('who reads today keeps reading; Google\'s 受信を読む turned off stays off; nobody else gets a choice; once only', () => {
    conn.exec('DROP TABLE member_work_switches')
    grant('a', 'u-gmail', 'google', [GMAIL_READONLY])
    grant('a', 'u-gmail-off', 'google', [GMAIL_READONLY], ['inbox'])
    grant('a', 'u-slack', 'slack', SLACK_READ)
    grant('a', 'u-slack-off', 'slack', SLACK_READ, ['read'])
    grant('a', 'u-minutes', 'google', ['https://www.googleapis.com/auth/calendar.events.readonly'])
    grant('a', 'u-revoked', 'google', [GMAIL_READONLY], [], 'revoked')
    grant('b', 'u-gmail', 'google', [GMAIL_READONLY], ['inbox'])
    migrateMemberWorkSwitches(conn)

    const on = (co: string, u: string) => switches.isOn(co, u, 'readIncoming')
    expect([on('a', 'u-gmail'), on('a', 'u-slack')]).toEqual([true, true])
    expect([on('a', 'u-gmail-off'), on('a', 'u-slack-off'), on('a', 'u-minutes'), on('a', 'u-revoked')]).toEqual([false, false, false, false])
    // Companies apart: the same user id in another company has its own row.
    expect(on('b', 'u-gmail')).toBe(false)
    expect(switches.my(m('u-minutes')).readIncoming.chosen).toBeNull()
    expect(switches.my(m('u-gmail-off')).readIncoming.chosen).toBe(false)

    // Never again: a later choice is not overwritten by a second run.
    expect(switches.set(m('u-gmail'), { switch: 'readIncoming', on: false }).ok).toBe(true)
    migrateMemberWorkSwitches(conn)
    expect(on('a', 'u-gmail')).toBe(false)
  })
})

describe('a member\'s own switch', () => {
  it('cannot be turned on while the company does not allow it (nothing stored); off stands when allowed again', () => {
    settings.a.autoRun.enabled = false
    const refused = switches.set(m('u-sato'), { switch: 'autoRun', on: true })
    expect(refused).toMatchObject({ ok: false, kind: 'conflict', body: { code: 'WORK_SWITCH_COMPANY_OFF' } })
    expect(switches.my(m('u-sato')).autoRun).toEqual({ on: false, allowed: false, companyDefault: true, chosen: null })
    expect(switches.set(m('u-sato'), { switch: 'autoRun', on: false }).ok).toBe(true)
    settings.a.autoRun.enabled = true
    expect(switches.isOn('a', 'u-sato', 'autoRun')).toBe(false)
    // Someone who never chose follows the 初めの値; another member is untouched by Sato's choice.
    expect(switches.isOn('a', 'u-tanaka', 'autoRun')).toBe(true)
    expect(switches.set(m('u-sato'), { switch: 'nothing', on: true })).toMatchObject({ ok: false, kind: 'bad-request' })
  })
})
