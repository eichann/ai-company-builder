// A skill kept private while it is being written (skills:makePrivate) is
// ignored on the member's computer (.git/info/exclude), never in the shared
// .gitignore. Lines older apps wrote there move to the member whose skill it
// is, before anything is staged; a line for a skill this computer does not
// have stays. See client/electron/sync/local-ignores.ts and
// .claude/rules/sync-guards.md "Shared files".

import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { World, ESSENTIAL_GITIGNORE, type Member, type SyncOutcome } from '../sync-harness/world'
import { settleAndCheck } from '../sync-harness/invariants'

const CONCURRENCY = Number(process.env.SYNC_HARNESS_CONCURRENCY) || 4
const SCENARIO_TIMEOUT_MS = Number(process.env.SYNC_HARNESS_SCENARIO_TIMEOUT_MS) || 10 * 60_000
const scenario = (name: string, fn: (t: TestContext) => Promise<void>) => test(name, { timeout: SCENARIO_TIMEOUT_MS }, fn)

function ok(outcome: SyncOutcome, who = ''): SyncOutcome {
  assert.equal(outcome.result.success, true, `${who} sync failed: ${JSON.stringify(outcome.result)}`)
  return outcome
}

const serverIgnore = (world: World) => world.serverFile('.gitignore')?.toString('utf-8') ?? ''
/** The member's private-skill lines (.git/info/exclude, managed block). */
const localSkills = (m: Member) => {
  let text = ''
  try { text = fs.readFileSync(m.path('.git/info/exclude'), 'utf-8') } catch { return [] }
  const all = text.split('\n')
  const begin = all.indexOf('# >>> ACB private skills (managed by the app, local only) >>>')
  return begin < 0 ? [] : all.slice(begin + 1, all.indexOf('# <<< ACB private skills <<<', begin))
}
const SKILL = (name: string) => `---\nname: ${name}\ndescription: 下書き\n---\n\n# ${name}\n`

describe('git:sync private skills', { concurrency: CONCURRENCY }, () => {
  scenario('a private-skill line an older app wrote moves to its member\'s computer; the skill is never shared; a teammate\'s line stays', async t => {
    const legacy = `${ESSENTIAL_GITIGNORE}\n# Private skills\n営業/.claude/skills/draft/\n営業/.claude/skills/theirs/\n`
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], gitignore: legacy, seed: { '営業/提案.md': '提案\n' } })
    const [a, b] = world.members
    a.write('営業/.claude/skills/draft/SKILL.md', SKILL('draft')).write('営業/メモ.md', 'a\n')
    ok(await a.sync(), 'a')
    assert.deepEqual(localSkills(a), ['営業/.claude/skills/draft/'])
    assert.equal(serverIgnore(world), `${ESSENTIAL_GITIGNORE}\n# Private skills\n営業/.claude/skills/theirs/\n`, 'only a\'s own line left the shared file')
    assert.equal(world.serverFile('営業/.claude/skills/draft/SKILL.md'), null, 'never shared on the way')
    assert.equal(world.serverFile('営業/メモ.md')?.toString(), 'a\n')
    a.write('営業/.claude/skills/draft/SKILL.md', SKILL('draft v2'))
    ok(await a.sync(), 'a')
    assert.equal(world.serverFile('営業/.claude/skills/draft/SKILL.md'), null, 'still kept on a\'s computer')
    ok(await b.sync(), 'b')
    assert.equal(b.exists('営業/.claude/skills/draft'), false)
    assert.deepEqual(localSkills(b), [])
    await settleAndCheck(world)
  })

  scenario('a teammate with a private skill at the same path copies the line before the pull that removes it', async t => {
    const legacy = `${ESSENTIAL_GITIGNORE}\n# Private skills\n営業/.claude/skills/same/\n`
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], gitignore: legacy, seed: { '営業/提案.md': '提案\n' } })
    const [a, b] = world.members
    a.write('営業/.claude/skills/same/SKILL.md', SKILL('a の下書き'))
    b.write('営業/.claude/skills/same/SKILL.md', SKILL('b の下書き'))
    ok(await a.sync(), 'a')
    assert.doesNotMatch(serverIgnore(world), /same/)
    ok(await b.sync(), 'b')
    ok(await b.sync(), 'b')
    assert.deepEqual(localSkills(b), ['営業/.claude/skills/same/'])
    assert.equal(world.serverFile('営業/.claude/skills/same/SKILL.md'), null, 'neither member\'s draft was shared')
    assert.match(b.read('営業/.claude/skills/same/SKILL.md').toString(), /b の下書き/)
    await settleAndCheck(world)
  })

  scenario('a line for a skill the company already shares is not moved (it never kept that skill private)', async t => {
    const legacy = `${ESSENTIAL_GITIGNORE}\n# Private skills\n営業/.claude/skills/shared/\n`
    const world = World.create(t, { members: [{ name: 'a' }], seed: { '営業/.claude/skills/shared/SKILL.md': SKILL('shared') } })
    const [a] = world.members
    a.write('.gitignore', legacy) // an older app's line, written before the skill was shared
    ok(await a.sync(), 'a')
    assert.deepEqual(localSkills(a), [])
    assert.equal(serverIgnore(world), legacy)
    await settleAndCheck(world)
  })
})
