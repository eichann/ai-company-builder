/**
 * A business plugin's steps as work (plan C5, plugin-steps.md): a step's work
 * is pinned at its first run and later runs use the pin; the step's tools stay
 * the ceiling whichever procedure runs (the plugin's or a company Skill); the
 * operator's stop overrides a pin; a `start: person` step pins and answers its
 * procedure for a consultation; another company sees none of it.
 *
 * Guards (each mutation-checked):
 * - the first claim pins the installed version + fingerprint; after a newer
 *   version is installed, a re-claim keeps the pin and the gate allows only
 *   what the pinned version's step allows (a new work runs the new version);
 * - the pinned version stays listed for the apps while its work is open;
 * - a work moves to a newer version only at that version's `upgrade.at` point
 *   (from `upgrade.from` on);
 * - the operator's stop of the pinned version refuses the claim and the gate;
 * - a company Skill chosen for an overridable step is pinned by its tree id
 *   (a later change of the Skill does not move the work); a step that is not
 *   overridable refuses a Skill; the step's tools are still the ceiling;
 * - a person's start: only `start: person` steps, only at the step's state;
 * - another company: the record and the plugin are missing, no turns.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { AddressInfo } from 'net'
import { serve, type ServerType } from '@hono/node-server'
import { createFakeHubSpot, type FakeHubSpot } from '../fakes/hubspot/fake-hubspot'
import { enableSampleSales, putSampleHub } from '../helpers/plugin-packages'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const currentUser = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: { handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const KEY = 'pat-fake-NOT-REAL-plugin-steps-0123456789'
const CO = 'ps-co'
const OTHER = 'ps-other'
const ts = () => new Date().toISOString()
const MAPPING = `
deal:
  visible_to_folder: 営業部
  import:
    pipelines: [default]
  fields:
    title:      { from: dealname, write: false }
    next_step:  { from: hs_next_step, write: true }
    assignee:   { from: hubspot_owner_id, write: false, people: owners }
people:
  owners:
    "75123001": ps-member
`
/** The steps of a version: `work` (automatic) gets plugin_operations from 0.2.0 on; `prepare` is a person's; `fixed` is not overridable. */
const steps = (workTools: string) => `
steps:
  work:
    label: 案件を進める
    for: { type: deal, state: open }
    start: ai_turn
    procedure: { default: steps/work.md, overridable: true }
    tools: [${workTools}]
    connector_roles: [mail.read]
  prepare:
    label: 提案書を用意する
    for: { type: deal, state: open }
    start: person
    procedure: { default: steps/prepare.md, overridable: true }
    tools: [records]
  fixed:
    label: 決まった手順
    for: { type: deal, state: open }
    start: person
    procedure: { default: steps/fixed.md }
    tools: [records]
`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let services: any, db: any, companyData: any
let fake: FakeHubSpot
let server: ServerType
let kekDir: string, shelfDir: string, workDir: string
const member = { companyId: CO, userId: 'ps-member', role: 'member' }
const owner = { companyId: CO, userId: 'ps-owner', role: 'owner' }
const outsider = { companyId: OTHER, userId: 'ps-outsider', role: 'owner' }
const SKILL = 'deal-proposal'

const recordOf = (externalId: string) => (db.prepare("SELECT record_id FROM plugin_external_links WHERE company_id = ? AND external_id = ? AND object = 'deal'").get(CO, externalId) as Json).record_id as string
const fingerprintOf = (version: string) => services.pluginShelf.find(CO, 'sample-sales', version).fingerprint as string
const listed = async () => (await services.pluginDistribution.pluginsFor(CO) as Json[]).filter(p => p.id === 'sample-sales').map(p => `${p.version}:${p.use}`).sort()
const aiIn = (runId: string) => ({ kind: 'ai' as const, source: 'claude-code', conversationId: 'conv-ps', runId })
const refresh = (runId: string, recordId: string) => services.pluginOperations.run(member, aiIn(runId), 'sample-sales', recordId, 'refresh_deal', {})
const NOT_IN_STEP = { ok: false, kind: 'forbidden', body: { code: 'NOT_IN_STEP', error: 'この手順では使えない操作です' } }

let device = 0
/** Claim (or re-claim) the `work` step's run of a record as a fresh app instance; a held run is given back first. */
async function claim(recordId: string) {
  const open = (companyData.forCompany(CO).aiRuns.openOf(member.userId) as Json[]).find(r => r.recordId === recordId)
  if (open?.state === 'running') {
    expect((services.aiRuns.finish(member, open.id, { generation: open.generation, outcome: 'failed', failure: { class: 'permission' } })).ok).toBe(true)
    expect(services.aiRuns.retry(member, open.id).ok).toBe(true)
  }
  device += 1
  return services.aiRuns.claim(member, { recordId, step: 'sample-sales__work', deviceId: `device-ps-${String(device).padStart(4, '0')}`, conversationId: `conv-ps-${device}` })
}
const pinOf = (r: Json) => r.value.run.procedure.pin

function install(version: string) {
  return services.plugins.install(owner, 'sample-sales', { version, keyId: null })
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim()
}
/** Commit the company Skill with `text` and push it to the company repository; its tree id. */
function putSkill(text: string): string {
  mkdirSync(join(workDir, '.claude', 'skills', SKILL), { recursive: true })
  writeFileSync(join(workDir, '.claude', 'skills', SKILL, 'SKILL.md'), text)
  git(workDir, 'add', '-A')
  git(workDir, 'commit', '-q', '-m', 'skill')
  git(workDir, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
  return git(workDir, 'rev-parse', `HEAD:.claude/skills/${SKILL}`)
}

beforeAll(async () => {
  fake = createFakeHubSpot()
  fake.addKey(KEY)
  server = serve({ fetch: fake.app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise(r => setTimeout(r, 50))
  const port = (server.address() as AddressInfo).port
  kekDir = mkdtempSync(join(tmpdir(), 'acb-ps-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  shelfDir = mkdtempSync(join(tmpdir(), 'acb-ps-shelf-'))
  putSampleHub(shelfDir)
  // Three contract-2 versions of the business plugin: 0.3.0 lets work pinned to 0.2.0 move at (deal, open).
  const base = join(shelfDir, 'sample-sales@0.1.0')
  const manifest = readFileSync(join(base, 'plugin.yaml'), 'utf8').replace('contract: 1', 'contract: 2')
  for (const [version, tools, upgrade] of [
    ['0.1.0', 'records', ''],
    ['0.2.0', 'records, plugin_operations', ''],
    ['0.3.0', 'records, plugin_operations', 'upgrade:\n  from: 0.2.0\n  at: [{ type: deal, state: open }]\n'],
  ] as const) {
    const dir = join(shelfDir, `sample-sales@${version}`)
    if (version !== '0.1.0') cpSync(base, dir, { recursive: true })
    writeFileSync(join(dir, 'plugin.yaml'), manifest.replace('version: 0.1.0', `version: ${version}`) + steps(tools) + upgrade)
    mkdirSync(join(dir, 'steps'), { recursive: true })
    for (const s of ['work', 'prepare', 'fixed']) writeFileSync(join(dir, 'steps', `${s}.md`), `# ${s} ${version}\n`)
  }
  Object.assign(process.env, {
    BROKER_KEK_FILE: join(kekDir, 'kek'), PLUGINS_DIR: shelfDir, ACB_ALLOW_FAKE_UPSTREAMS: '1', ACB_FAKE_HUBSPOT_URL: `http://127.0.0.1:${port}`,
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})

  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  services = (await import('../../src/composition')).services
  companyData = (await import('../../src/adapters/sqlite/company-data')).sqliteCompanyData(db)
  const loaded = await services.pluginShelf.load()
  expect(loaded.loaded, JSON.stringify(loaded.refused)).toEqual(expect.arrayContaining(['sample-sales@0.1.0', 'sample-sales@0.2.0', 'sample-sales@0.3.0']))

  const { ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
  for (const [co, own] of [[CO, 'ps-owner'], [OTHER, 'ps-outsider']]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, own, ts(), ts())
    ensureCompanyScope(db, co)
    db.prepare('INSERT INTO record_settings (company_id, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)').run(co, ts(), 'x')
  }
  for (const [u, r, co] of [['ps-owner', 'owner', CO], ['ps-member', 'member', CO], ['ps-outsider', 'owner', OTHER]]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, co, r, ts(), ts())
  }
  db.prepare('INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('ps-d-sales', CO, '営業部', '営業部', ts(), ts())
  const audience = { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] }
  const key = (await services.keyBroker.create(owner, { service: 'hubspot', displayName: 'HubSpot', secret: KEY, audience })).value.keys[0].id
  await enableSampleSales(services.plugins, owner)
  expect((await services.plugins.install(owner, 'sample-hub', { version: '0.1.0', keyId: key })).ok).toBe(true)
  const saved = await services.plugins.saveMapping(owner, 'sample-sales', { text: MAPPING, acknowledgeAuto: ['next_step'] })
  expect(saved.ok, JSON.stringify(saved)).toBe(true)
  expect((await services.plugins.setReadScope(owner, 'sample-hub', { userIds: ['ps-member'] })).ok).toBe(true)
  expect((await services.plugins.setEnabled(owner, 'sample-hub', { enabled: true })).ok).toBe(true)
  expect((await services.pluginImport.run(owner, 'sample-sales')).ok).toBe(true)

  // The company repository with a company Skill (its tree id is what a Skill pin names).
  const { companyRepoPath } = await import('../../src/lib/config')
  const bare = companyRepoPath(CO)
  mkdirSync(bare, { recursive: true })
  git(bare, 'init', '-q', '--bare')
  workDir = mkdtempSync(join(tmpdir(), 'acb-ps-work-'))
  git(workDir, 'init', '-q')
  git(workDir, 'remote', 'add', 'origin', bare)
})

afterAll(async () => {
  fake.close()
  server.closeAllConnections?.()
  await new Promise(r => server.close(() => r(null)))
  for (const d of [kekDir, shelfDir, workDir]) if (d) rmSync(d, { recursive: true, force: true })
  for (const k of ['BROKER_KEK_FILE', 'PLUGINS_DIR', 'ACB_ALLOW_FAKE_UPSTREAMS', 'ACB_FAKE_HUBSPOT_URL']) delete process.env[k]
})

describe('a step’s work is pinned at its first run', () => {
  it('pins the installed version; later runs keep it after a newer install, and the gate follows the pin', async () => {
    const a = recordOf('1000000001')
    const first = await claim(a)
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true })
    expect(pinOf(first)).toEqual({ source: 'plugin', pluginId: 'sample-sales', version: '0.1.0', fingerprint: fingerprintOf('0.1.0') })

    expect((await install('0.2.0')).ok).toBe(true)
    const again = await claim(a)
    expect(again.value.run.generation).toBe(2)
    expect(pinOf(again)).toMatchObject({ version: '0.1.0' })
    // 0.2.0 gives `work` plugin_operations; the work pinned to 0.1.0 still may not call them.
    expect(await refresh(again.value.run.id, a)).toEqual(NOT_IN_STEP)
    const roles = await services.pluginRunGate.allowsConnectorRole(member, again.value.run.id, 'mail.read')
    expect(roles).toBe(true)
    // What the app reads after its claim: the work's pin and the step it runs (narrowed by the pinned version).
    const work = (services.pluginSteps.stepsOn(member, a).value.steps as Json[]).find(st => st.step === 'work')
    expect(work).toMatchObject({ pin: { version: '0.1.0' }, tools: ['records'], procedure: 'steps/work.md' })

    // A work whose first run comes now runs 0.2.0, and may.
    const b = recordOf('1000000002')
    const fresh = await claim(b)
    expect(pinOf(fresh)).toMatchObject({ version: '0.2.0' })
    expect(await refresh(fresh.value.run.id, b)).not.toEqual(NOT_IN_STEP)
  })

  it('keeps the pinned version listed for the apps while its work is open (not once it is finished)', async () => {
    expect(await listed()).toEqual(['0.1.0:pinned', '0.2.0:current'])
    const a = recordOf('1000000001')
    db.prepare("UPDATE record_state SET state = 'won' WHERE company_id = ? AND record_id = ?").run(CO, a)
    try {
      expect(await listed()).toEqual(['0.2.0:current'])
    } finally {
      db.prepare("UPDATE record_state SET state = 'open' WHERE company_id = ? AND record_id = ?").run(CO, a)
    }
  })

  it("is claimable only at the step's state, as the record's assignee, for a step that starts as an AI turn", async () => {
    const a = recordOf('1000000001')
    const claimAs = (who: Json, step: string) => services.aiRuns.claim(who, { recordId: a, step, deviceId: 'device-ps-turn', conversationId: 'conv-ps-turn' })
    expect(await claimAs(member, 'sample-sales__prepare')).toMatchObject({ ok: false, body: { code: 'NOT_AI_TURN' } })
    expect(await claimAs(owner, 'sample-sales__work')).toMatchObject({ ok: false, body: { code: 'NOT_AI_TURN' } })
    db.prepare("UPDATE record_state SET state = 'won' WHERE company_id = ? AND record_id = ?").run(CO, a)
    try {
      expect(await claimAs(member, 'sample-sales__work')).toMatchObject({ ok: false, body: { code: 'NOT_AI_TURN' } })
    } finally {
      db.prepare("UPDATE record_state SET state = 'open' WHERE company_id = ? AND record_id = ?").run(CO, a)
    }
  })

  it('moves a work to a newer version only at its upgrade point, from upgrade.from on', async () => {
    expect((await install('0.3.0')).ok).toBe(true)
    // Pinned to 0.2.0 (≥ from), at (deal, open): moves. Pinned to 0.1.0 (< from): stays.
    expect(pinOf(await claim(recordOf('1000000002')))).toMatchObject({ version: '0.3.0', fingerprint: fingerprintOf('0.3.0') })
    expect(pinOf(await claim(recordOf('1000000001')))).toMatchObject({ version: '0.1.0' })
    expect(await listed()).toEqual(['0.1.0:pinned', '0.3.0:current'])
  })
})

describe("the operator's stop overrides a pin", () => {
  it('a stopped pinned version: no claim, nothing through the gate, not listed; other work goes on', async () => {
    const a = recordOf('1000000001')
    const held = await claim(a)
    expect(held.ok).toBe(true)
    writeFileSync(join(shelfDir, 'stopped'), 'sample-sales@0.1.0\n')
    try {
      expect(await services.pluginRunGate.allowsConnectorRole(member, held.value.run.id, 'mail.read')).toBe(false)
      expect(await claim(a)).toMatchObject({ ok: false, body: { code: 'PROCEDURE_STOPPED' } })
      expect(await listed()).toEqual(['0.3.0:current'])
      expect(await claim(recordOf('1000000002'))).toMatchObject({ ok: true })
    } finally {
      rmSync(join(shelfDir, 'stopped'))
    }
  })
})

describe('a company Skill as an overridable step’s procedure', () => {
  it('only an overridable step takes one, and only a Skill on the shared branch', async () => {
    expect(await services.pluginSteps.setStepSkill(owner, 'sample-sales', 'prepare', { skill: SKILL })).toMatchObject({ ok: false, body: { code: 'STEP_SKILL_MISSING' } })
    putSkill('# 提案書（会社の版 1）\n')
    expect(await services.pluginSteps.setStepSkill(owner, 'sample-sales', 'fixed', { skill: SKILL })).toMatchObject({ ok: false, body: { code: 'STEP_NOT_OVERRIDABLE' } })
    expect(await services.pluginSteps.setStepSkill(member, 'sample-sales', 'prepare', { skill: SKILL })).toMatchObject({ ok: false, kind: 'forbidden' })
    const set = await services.pluginSteps.setStepSkill(owner, 'sample-sales', 'prepare', { skill: SKILL })
    expect(set.value.steps).toEqual(expect.arrayContaining([{ step: 'prepare', label: '提案書を用意する', overridable: true, skill: SKILL }]))
  })

  it('pins the Skill by its tree id; a later change of the Skill does not move the work; the step’s tools stay the ceiling', async () => {
    const d = recordOf('1000000007')
    const tree1 = git(workDir, 'rev-parse', `HEAD:.claude/skills/${SKILL}`)
    const first = await services.pluginSteps.startPerson(member, d, 'sample-sales', 'prepare')
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true })
    expect(first.value.pin).toEqual({ source: 'company_skill', skill: SKILL, fingerprint: tree1 })
    expect(first.value.tools).toEqual(['records'])
    const tree2 = putSkill('# 提案書（会社の版 2）\n')
    expect(tree2).not.toBe(tree1)
    expect((await services.pluginSteps.startPerson(member, d, 'sample-sales', 'prepare')).value.pin.fingerprint).toBe(tree1)
    // Another work's first run takes the Skill as it is now.
    expect((await services.pluginSteps.startPerson(member, recordOf('1000000002'), 'sample-sales', 'prepare')).value.pin.fingerprint).toBe(tree2)
    // A step that is not overridable runs the plugin's own procedure.
    expect((await services.pluginSteps.startPerson(member, d, 'sample-sales', 'fixed')).value.pin).toMatchObject({ source: 'plugin', version: '0.3.0' })
  })
})

describe("a person's start", () => {
  it('only a start: person step, only at its state; the card lists the steps at the record’s state', async () => {
    const d = recordOf('1000000007')
    expect(await services.pluginSteps.startPerson(member, d, 'sample-sales', 'work')).toMatchObject({ ok: false, body: { code: 'PLUGIN_STEP_NOT_FOUND' } })
    const on = services.pluginSteps.stepsOn(member, d)
    expect(on.value.steps.map((s: Json) => `${s.step}:${s.start}`).sort()).toEqual(['fixed:person', 'prepare:person', 'work:ai_turn'])
    db.prepare("UPDATE record_state SET state = 'won' WHERE company_id = ? AND record_id = ?").run(CO, d)
    try {
      expect(await services.pluginSteps.startPerson(member, d, 'sample-sales', 'prepare')).toMatchObject({ ok: false, body: { code: 'NOT_AT_STEP' } })
      expect(services.pluginSteps.stepsOn(member, d).value.steps).toEqual([])
    } finally {
      db.prepare("UPDATE record_state SET state = 'open' WHERE company_id = ? AND record_id = ?").run(CO, d)
    }
  })

  it("the member's 「AI の番」 of steps lists their records at an ai_turn step", () => {
    const turns = services.pluginSteps.turns(member).value.turns as Json[]
    expect(turns.map(t => t.step)).toEqual(expect.arrayContaining(['work']))
    expect(turns.every(t => t.step === 'work')).toBe(true)
    expect(turns.map(t => t.recordId)).toEqual(expect.arrayContaining([recordOf('1000000001'), recordOf('1000000002'), recordOf('1000000007')]))
  })
})

describe('another company never sees it', () => {
  it('the record, the plugin and the turns are missing there', async () => {
    const d = recordOf('1000000007')
    expect(services.pluginSteps.stepsOn(outsider, d)).toMatchObject({ ok: false, kind: 'not-found' })
    expect(await services.pluginSteps.startPerson(outsider, d, 'sample-sales', 'prepare')).toMatchObject({ ok: false, kind: 'not-found' })
    expect(services.pluginSteps.turns(outsider).value.turns).toEqual([])
    expect(services.pluginSteps.stepSkills(outsider, 'sample-sales')).toMatchObject({ ok: false, kind: 'not-found' })
    expect(await services.aiRuns.claim(outsider, { recordId: d, step: 'sample-sales__work', deviceId: 'device-ps-other', conversationId: 'conv-x' }))
      .toMatchObject({ ok: false, kind: 'not-found' })
  })
})
