// The document review saves a sidecar through a temporary file next to it
// (`.<name>.acb-tmp-<random>`, client/shared/temp-save-file.ts) that exists
// for milliseconds. A sync that runs in that moment must not share it, and
// must not change anything else. Guard: sync-guards.md "Shared files".

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { World, type SyncOutcome } from '../sync-harness/world'
import { assertNoLostWork, settleAndCheck } from '../sync-harness/invariants'

const DOC = '営業部/提案書.md'
const TEMP = '営業部/.提案書.md.review.r1.json.acb-tmp-k3x9'
const SIDECAR = '営業部/提案書.md.review.r1.json'

function ok(outcome: SyncOutcome, who = ''): SyncOutcome {
  assert.equal(outcome.result.success, true, `${who} sync failed: ${JSON.stringify(outcome.result)}`)
  return outcome
}

function excludeText(dir: string): string {
  return fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf-8')
}

describe('git:sync and the app\'s temporary save files', () => {
  test('a temporary save file present during sync is not shared; the other changes are; it stays on disk, ignored on this computer only', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], departments: ['営業部'], seed: { [DOC]: '提案 v1\n' } })
    const [a, b] = world.members
    ok(await a.sync(), 'a')
    a.write(SIDECAR, '{"version":1}\n').write(TEMP, '{"version":1,"half":').write(DOC, '提案 v2\n')
    ok(await a.sync(), 'a')

    assert.equal(world.serverFile(TEMP), null, 'the temporary file is never committed')
    assert.equal(world.serverFile(SIDECAR)?.toString(), '{"version":1}\n')
    assert.equal(world.serverFile(DOC)?.toString(), '提案 v2\n')
    assert.equal(a.readText(TEMP), '{"version":1,"half":', 'left alone on disk')
    assert.ok(a.isIgnored(TEMP), 'ignored on this computer')
    assert.match(excludeText(a.dir), /# >>> ACB temporary save files \(managed by the app, local only\) >>>\n\.\*\.acb-tmp-\*\n# <<< ACB temporary save files <<</)
    assert.equal(world.serverFile('.gitignore')?.toString().includes('acb-tmp'), false, 'never in the shared .gitignore')
    assert.equal(world.git(world.bare, ['log', '--all', '--name-only', '--format=']).includes('acb-tmp'), false)

    ok(await b.sync(), 'b')
    assert.equal(b.exists(TEMP), false)
    assert.equal(b.readText(DOC), '提案 v2\n')
    a.remove(TEMP)
    await settleAndCheck(world)
  })

  test('the exclude block is written once and keeps the member\'s own lines and the other blocks', async t => {
    const world = World.create(t, { members: [{ name: 'a' }], departments: ['営業部'] })
    const [a] = world.members
    fs.appendFileSync(path.join(a.dir, '.git', 'info', 'exclude'), 'my-own-notes.txt\n')
    ok(await a.sync(), 'a')
    ok(await a.sync(), 'a')
    const text = excludeText(a.dir)
    assert.ok(text.includes('my-own-notes.txt\n'))
    assert.equal(text.split('# >>> ACB temporary save files').length - 1, 1, 'one block, not one per sync')
    await settleAndCheck(world)
  })

  test('a shared .gitignore that re-includes dotfiles (!.*) still never shares a temporary save file', async t => {
    const world = World.create(t, { members: [{ name: 'a' }], departments: ['営業部'], seed: { [DOC]: '提案 v1\n' } })
    const [a] = world.members
    ok(await a.sync(), 'a')
    a.append('.gitignore', '!.*\n').write(TEMP, 'half').write(DOC, '提案 v2\n')
    const out = ok(await a.sync(), 'a')
    assert.equal(world.serverFile(TEMP), null)
    assert.equal(world.serverFile(DOC)?.toString(), '提案 v2\n')
    assert.ok(out.logs.some(l => typeof l[1] === 'string' && l[1].includes('Unstaging local-only paths')), 'unstaged after the add')
    assert.equal(a.readText(TEMP), 'half')
    // The harness counts content whose blob git stored (the add, before the unstage) as committed;
    // the temporary file is not the member's work, and it is still on disk as written.
    a.releaseObligationsUnder(TEMP)
    assertNoLostWork(world)
  })

  test('inside a private folder\'s clone too', async t => {
    const world = World.create(t, { members: [{ name: 'reader' }], departments: ['人事'] })
    world.createPrivateFolder('人事/評価', { viewers: ['reader'], files: { '評価表.md': '評価 v1\n' } })
    const [reader] = world.members
    ok(await reader.sync(), 'reader')
    reader.write('人事/評価/.評価表.md.review.r1.json.acb-tmp-z', 'half').write('人事/評価/評価表.md', '評価 v2\n')
    ok(await reader.sync(), 'reader')
    assert.equal(world.scopeFile('人事/評価', '.評価表.md.review.r1.json.acb-tmp-z'), null)
    assert.equal(world.scopeFile('人事/評価', '評価表.md')?.toString(), '評価 v2\n')
    reader.remove('人事/評価/.評価表.md.review.r1.json.acb-tmp-z')
    await settleAndCheck(world)
  })
})
