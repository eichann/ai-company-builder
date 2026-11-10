/**
 * A scheduled job's definition (shared/core/jobs.ts, jobs.md "The definition"). Guards (each
 * mutation-checked):
 * - the parser is strict: an unknown key at any level, an unknown value, a tool outside the business
 *   plugins' step vocabulary (or one an unattended run may not have), a route outside `AI_ROUTES`, a
 *   connector read, a path into `.personal` or out of the company — each refused, with codes only;
 * - what runs where: a server operation runs on the server and takes no AI powers; a procedure runs on
 *   the PC and needs a check without the AI first (owner decision D6);
 * - the consent part (D4) changes with who / what runs / where / the grant, and not with a name, a time
 *   or the missed policy;
 * - an occurrence id never has the shape of a record id (it is what a run's subject id holds, beside the
 *   kept `idx_ai_runs_open` on record ids).
 */
import { describe, expect, it } from 'vitest'
import {
  JOB_GRANT_TOOLS, OCCURRENCE_ID_RE, isOccurrenceId, jobConsentCanonical, jobDefinitionCanonical, newJobId, newOccurrenceId, parseJobDefinition,
  type JobDefinition,
} from '../../shared/core/jobs'
import { RECORD_ID_RE, newRecordId } from '../../shared/core/records'

const FP = 'a'.repeat(40)
function pcJob(): Record<string, unknown> {
  return {
    schema: 1, name: '面談報告書の下書き（A社）', actingUser: 'u-mentor',
    trigger: { every: 'week', weekday: 'tue', at: '09:00', businessDaysBefore: 1 },
    check: { kind: 'new_files', path: '支援/A社/文字起こし' },
    run: { kind: 'procedure', procedure: { source: 'company_skill', skill: 'interview-report', fingerprint: FP } },
    placement: 'a',
    missed: { policy: 'latest_only', expiresAfterMinutes: 1620 },
    grant: {
      tools: ['files_read', 'files_write', 'records'], creates: ['task'], routes: ['POST /item', 'GET /item/:recordId'],
      reads: { paths: ['支援/A社/文字起こし'], calls: [] }, writes: { area: 'deliverable', place: '支援', folder: 'reports' },
      outbound: 'none', limits: { minutes: 30, runsPerDay: 1 },
    },
  }
}
function serverJob(): Record<string, unknown> {
  return {
    schema: 1, name: 'PC の棚卸し', actingUser: 'u-admin',
    trigger: { every: 'month', day: 1, at: '09:00', ifHoliday: 'after' },
    check: { kind: 'none' },
    run: { kind: 'operation', operation: 'create_task', title: 'PC の棚卸しをする', dueBusinessDays: 5 },
    placement: 'e',
    missed: { policy: 'skip', expiresAfterMinutes: 60 },
    grant: { tools: [], creates: ['task'], routes: [], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 1, runsPerDay: 1 } },
  }
}
const parsed = (v: unknown): JobDefinition => {
  const r = parseJobDefinition(v)
  if (!r.ok) throw new Error(r.problems.join())
  return r.definition
}
const problems = (v: unknown): string[] => {
  const r = parseJobDefinition(v)
  return r.ok ? [] : r.problems
}
/** Set `path` (dot-separated) in a deep copy. */
function edit(base: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(base)) as Record<string, unknown>
  const keys = path.split('.')
  let at = copy as Record<string, unknown>
  for (const k of keys.slice(0, -1)) at = at[k] as Record<string, unknown>
  at[keys[keys.length - 1]] = value
  return copy
}

describe('the definition parser is strict', () => {
  it('both shapes of the first jobs parse, as given', () => {
    expect(parsed(pcJob())).toEqual(pcJob())
    expect(parsed(serverJob())).toEqual(serverJob())
  })

  it('an unknown key at any level is refused', () => {
    for (const path of ['extra', 'trigger.extra', 'check.extra', 'run.extra', 'run.procedure.extra', 'missed.extra', 'grant.extra', 'grant.reads.extra', 'grant.writes.extra', 'grant.limits.extra']) {
      expect(problems(edit(pcJob(), path, 1)), path).not.toEqual([])
    }
    expect(problems(edit(serverJob(), 'run.extra', 1))).not.toEqual([])
  })

  it('an unknown or out-of-range value is refused, with codes only', () => {
    const cases: Array<[string, unknown]> = [
      ['schema', 2], ['name', ''], ['name', 'x'.repeat(61)], ['actingUser', 'a b'], ['trigger.every', 'hour'], ['trigger.at', '09:03'], ['trigger.at', '9:00'],
      ['trigger.weekday', 'tuesday'], ['trigger.businessDaysBefore', 6], ['check.kind', 'always'], ['run.kind', 'script'],
      ['run.procedure.source', 'plugin'], ['run.procedure.skill', '../x'], ['run.procedure.fingerprint', 'zz'], ['placement', 'b'],
      ['missed.policy', 'all'], ['missed.expiresAfterMinutes', 1], ['grant.outbound', 'send'], ['grant.limits.minutes', 0], ['grant.limits.runsPerDay', 100],
      ['grant.creates', ['approval']], ['grant.tools', ['files_read', 'files_read', 'files_write', 'records']],
    ]
    for (const [path, value] of cases) {
      const p = problems(edit(pcJob(), path, value))
      expect(p, path).not.toEqual([])
      for (const code of p) expect(code, path).toMatch(/^[A-Za-z.]+(?:\.[A-Z_]+)?$/)
    }
    // A month's day beyond 28 (every month has it) or a time that is no list value.
    expect(problems(edit(serverJob(), 'trigger.day', 31))).not.toEqual([])
    expect(problems(edit(serverJob(), 'run.operation', 'send_mail'))).not.toEqual([])
  })

  it('tools come from the business plugins\' step vocabulary, minus what an unattended run may not have', () => {
    expect(JOB_GRANT_TOOLS).not.toContain('web_research')
    expect(JOB_GRANT_TOOLS).not.toContain('plugin_operations')
    for (const tool of ['web_research', 'plugin_operations', 'shell', 'mail_send']) {
      expect(problems(edit(pcJob(), 'grant.tools', ['files_read', 'files_write', 'records', tool])), tool).not.toEqual([])
    }
    expect(problems(edit(pcJob(), 'grant.routes', ['POST /item', 'POST /outbound/:messageId/send']))).not.toEqual([])
    // Connector reads are refused to a run today: none may be granted.
    expect(problems(edit(pcJob(), 'grant.reads.calls', ['hubspot.deals.read']))).not.toEqual([])
  })

  it('a path into .personal / .backups, out of the company or the company root itself is refused', () => {
    for (const path of ['', '../外', '/絶対', '支援/./A社', '支援/.personal/x', '支援/.Backups/x', '支援\\A社', 'a//b']) {
      expect(problems(edit(edit(pcJob(), 'grant.reads.paths', [path]), 'check.path', path)), path).not.toEqual([])
    }
  })

  it('each power is named once, where it is granted', () => {
    expect(problems(edit(pcJob(), 'grant.tools', ['files_write', 'records']))).toContain('grant.reads.NEEDS_FILES_READ')
    expect(problems(edit(pcJob(), 'grant.writes', { area: 'none' }))).toContain('grant.writes.FILES_WRITE_MISMATCH')
    expect(problems(edit(pcJob(), 'grant.outbound', 'draft_only'))).toContain('grant.outbound.OUTBOUND_DRAFT_MISMATCH')
    expect(problems(edit(pcJob(), 'check.path', '支援/B社'))).toContain('check.path.NOT_IN_READS')
    expect(problems(edit(edit(pcJob(), 'grant.tools', ['files_read', 'files_write']), 'grant.routes', []))).toContain('grant.creates.NEEDS_RECORDS')
    expect(problems(edit(pcJob(), 'grant.tools', ['files_read', 'files_write']))).toContain('grant.routes.NEEDS_RECORDS')
  })
})

describe('what runs where', () => {
  it('a server operation runs on the server and takes no AI powers; a procedure runs on the PC', () => {
    expect(problems(edit(serverJob(), 'placement', 'a'))).toContain('placement.OPERATION_RUNS_ON_SERVER')
    expect(problems(edit(pcJob(), 'placement', 'e'))).toContain('placement.PROCEDURE_RUNS_ON_PC')
    expect(problems(edit(serverJob(), 'grant.tools', ['records']))).toContain('grant.OPERATION_TAKES_NO_AI_POWERS')
    expect(problems(edit(serverJob(), 'grant.creates', []))).toContain('grant.creates.OPERATION_NEEDS_TASK')
  })

  it('the clock alone never runs the AI: a procedure needs a check without the AI first (D6)', () => {
    expect(problems(edit(pcJob(), 'check', { kind: 'none' }))).toContain('check.REQUIRED_FOR_PROCEDURE')
  })
})

describe('the consent part (D4)', () => {
  const consent = (v: Record<string, unknown>) => jobConsentCanonical(parsed(v))
  it('changes with who, what runs, where and the grant', () => {
    const base = consent(pcJob())
    expect(consent(edit(pcJob(), 'actingUser', 'u-other'))).not.toBe(base)
    expect(consent(edit(pcJob(), 'run.procedure.fingerprint', 'b'.repeat(40)))).not.toBe(base)
    expect(consent(edit(pcJob(), 'grant.limits.minutes', 31))).not.toBe(base)
    expect(consent(edit(edit(pcJob(), 'grant.reads.paths', ['支援/A社/文字起こし', '支援/B社']), 'grant.reads.paths', ['支援/A社/文字起こし', '支援/B社']))).not.toBe(base)
    expect(consent(edit(serverJob(), 'placement', 'e'))).not.toBe(consent(edit(serverJob(), 'actingUser', 'u-mentor')))
  })
  it('does not change with the name, the time, the check or the missed policy', () => {
    const base = consent(pcJob())
    expect(consent(edit(pcJob(), 'name', '別の名前'))).toBe(base)
    expect(consent(edit(pcJob(), 'trigger.at', '10:00'))).toBe(base)
    expect(consent(edit(pcJob(), 'missed.policy', 'skip'))).toBe(base)
    // …while the whole definition does.
    expect(jobDefinitionCanonical(parsed(edit(pcJob(), 'name', '別の名前')))).not.toBe(jobDefinitionCanonical(parsed(pcJob())))
  })
})

describe('an occurrence id is never a record id', () => {
  it('no occurrence id matches the record id shape, and a record id is never an occurrence id', () => {
    const hex = () => Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')
    for (let i = 0; i < 2000; i++) {
      const occ = newOccurrenceId(hex())
      expect(OCCURRENCE_ID_RE.test(occ)).toBe(true)
      expect(RECORD_ID_RE.test(occ)).toBe(false)
      expect(isOccurrenceId(occ)).toBe(true)
      const rec = newRecordId('task', hex().slice(0, 16))
      expect(isOccurrenceId(rec)).toBe(false)
    }
    // The shapes nearest a record id: a type-like prefix and a dash are still not occurrence ids.
    for (const near of ['occ-0123456789abcdef0123456789abcdef', 'occ_0123456789abcdef0123456789abcdef', 'occ.0123456789ABCDEF0123456789ABCDEF']) {
      expect(isOccurrenceId(near), near).toBe(false)
      expect(OCCURRENCE_ID_RE.test(near), near).toBe(false)
    }
    expect(() => newOccurrenceId('xyz')).toThrow()
    expect(() => newJobId('0'.repeat(31))).toThrow()
  })
})
