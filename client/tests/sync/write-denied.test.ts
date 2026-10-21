// WRITE_DENIED: the server refuses a push that changes a folder the member may
// not edit. The hook checks every commit in the pushed range, so sync must
// rewrite the unpushed commits (the same recovery as PROTECTED_CONFIG): ask,
// back up the member's version, put those paths back to the server version,
// push the rest. See "Non-Negotiable Guards" in CLAUDE.md.
//
// The worlds run the real push checker: World.setScopes hands it the
// permission snapshot git-http would write for each member's push.

import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { World, DEFAULT_SCOPES, type HarnessScope, type Member, type SyncOutcome } from '../sync-harness/world'
import { settleAndCheck } from '../sync-harness/invariants'

const CONCURRENCY = Number(process.env.SYNC_HARNESS_CONCURRENCY) || 4

function ok(outcome: SyncOutcome, who = ''): SyncOutcome {
  assert.equal(outcome.result.success, true, `${who} sync failed: ${JSON.stringify(outcome.result)}`)
  return outcome
}

function writeDeniedBackups(m: Member) {
  return m.backups().filter(b => b.metadata.reason === 'write_denied')
}

const BUDGET = '予算 v1\n'

/**
 * The company scope (everyone: read + write) plus a scope per folder that
 * takes writing away: from the named members only, or from every "member"
 * (owner/admin always write).
 */
function denyWrites(rules: Array<{ path: string; members?: string[] }>): HarnessScope[] {
  return [...DEFAULT_SCOPES, ...rules.map((r, i): HarnessScope => ({
    id: `scope-deny-${i}`, path: r.path, kind: 'folder', departmentId: null, repoId: null,
    rules: r.members
      ? [
          { id: `rule-${i}-everyone`, subjectType: 'everyone', subjectId: null, canRead: true, canWrite: true },
          ...r.members.map((name, j) => ({ id: `rule-${i}-${j}`, subjectType: 'user' as const, subjectId: `user-${name}`, canRead: true, canWrite: false })),
        ]
      : [{ id: `rule-${i}-everyone`, subjectType: 'everyone', subjectId: null, canRead: true, canWrite: false }],
  }))]
}

function create(
  t: Parameters<typeof World.create>[0],
  extra: Partial<Parameters<typeof World.create>[1]> = {},
  denied: Array<{ path: string; members?: string[] }> = [{ path: '経理部', members: ['a'] }],
) {
  const world = World.create(t, {
    members: [{ name: 'a' }, { name: 'b' }, { name: 'admin', role: 'admin' }],
    seed: { '経理部/予算.md': BUDGET, '営業部/提案.md': '提案 v1\n' },
    ...extra,
  })
  world.setScopes(denyWrites(denied))
  return world
}

// Each sync already fails as a hang after SYNC_TIMEOUT_MS; this bounds a
// whole scenario too, so a stuck test fails fast instead of eating the job.
const SCENARIO_TIMEOUT_MS = Number(process.env.SYNC_HARNESS_SCENARIO_TIMEOUT_MS) || 10 * 60_000
const scenario = (name: string, fn: (t: TestContext) => Promise<void>) =>
  test(name, { timeout: SCENARIO_TIMEOUT_MS }, fn)

describe('git:sync WRITE_DENIED', { concurrency: CONCURRENCY }, () => {
  scenario('denied + allowed edit → restore: the allowed edit reaches the server, the denied file is the server version, backed up', async t => {
    const world = create(t)
    const [a] = world.members
    a.write('経理部/予算.md', '予算 改ざん\n').write('営業部/提案.md', '提案 v2\n')
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs.map(d => [d.kind, d.answer]), [['writeDenied', 'restore']])
    assert.equal(out.dialogs[0].options.title, '編集できないファイルがあります')
    assert.deepEqual(out.dialogs[0].options.buttons, ['元に戻して残りを同期', 'キャンセル'])
    assert.match(out.dialogs[0].options.detail, /経理部\/予算\.md/)
    assert.deepEqual(out.result.restoredWriteDeniedFiles, ['経理部/予算.md'])
    assert.equal(out.result.restoredProtectedFiles, undefined)
    assert.match(out.result.message ?? '', /編集する権限がないフォルダのファイル（1件）は元に戻しました/)
    assert.equal(world.serverFile('営業部/提案.md')?.toString(), '提案 v2\n')
    assert.equal(world.serverFile('経理部/予算.md')?.toString(), BUDGET)
    assert.equal(a.readText('経理部/予算.md'), BUDGET)
    const [backup] = writeDeniedBackups(a)
    assert.ok(backup, 'write_denied backup')
    assert.match(backup.folder, /_write_denied$/)
    assert.deepEqual(backup.files, ['経理部/予算.md'])
    assert.deepEqual(backup.metadata.writeDeniedFiles, ['経理部/予算.md'])
    assert.deepEqual(backup.metadata.restoredFiles, ['経理部/予算.md'])
    assert.equal(out.result.writeDeniedBackupPath, a.path(`.backups/${backup.folder}`))
    assert.equal(a.hasPendingPush(), false)
    await settleAndCheck(world)
  })

  scenario('cancel: write_denied with the paths, no PENDING_PUSH; the next sync offers it again; no window reports only', async t => {
    const world = create(t)
    const [a] = world.members
    a.write('経理部/新規.md', 'new\n').write('営業部/メモ.md', 'memo\n')
    a.willAnswer('writeDenied', 'cancel')
    const cancelled = await a.sync()
    assert.equal(cancelled.result.success, false)
    assert.equal(cancelled.result.errorType, 'write_denied')
    assert.deepEqual(cancelled.result.writeDeniedFiles, ['経理部/新規.md'])
    assert.match(cancelled.result.error ?? '', /^同期を中止しました。/)
    assert.equal(a.hasPendingPush(), false, 'never PENDING_PUSH for a rejection')
    assert.equal(world.serverFile('営業部/メモ.md'), null)

    a.hasWindow = false
    const noWindow = await a.sync()
    assert.equal(noWindow.result.errorType, 'write_denied')
    assert.deepEqual(noWindow.dialogs, [])
    assert.equal(a.hasPendingPush(), false)

    a.hasWindow = true
    const out = ok(await a.sync(), 'a') // no new edits; default answer = restore
    assert.deepEqual(out.dialogs.map(d => [d.kind, d.answer]), [['writeDenied', 'restore']])
    assert.deepEqual(out.result.restoredWriteDeniedFiles, ['経理部/新規.md'])
    assert.equal(a.exists('経理部/新規.md'), false, 'a file the server does not have is removed locally')
    assert.deepEqual(writeDeniedBackups(a)[0].files, ['経理部/新規.md'])
    assert.equal(world.serverFile('営業部/メモ.md')?.toString(), 'memo\n')
    await settleAndCheck(world)
  })

  scenario('a denied file the member deleted comes back from the server', async t => {
    const world = create(t)
    const [a] = world.members
    a.remove('経理部/予算.md').write('営業部/提案.md', '提案 v2\n')
    a.willAnswer('deletedFiles', 'sync-deletions')
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs.map(d => d.kind), ['deletedFiles', 'writeDenied'])
    assert.deepEqual(out.result.restoredWriteDeniedFiles, ['経理部/予算.md'])
    assert.equal(a.readText('経理部/予算.md'), BUDGET)
    assert.equal(world.serverFile('経理部/予算.md')?.toString(), BUDGET)
    assert.equal(world.serverFile('営業部/提案.md')?.toString(), '提案 v2\n')
    await settleAndCheck(world)
  })

  scenario('a move from an allowed folder into a denied one is undone: the file is back where it was', async t => {
    const world = create(t)
    const [a] = world.members
    a.rename('営業部/提案.md', '経理部/提案.md').write('営業部/別件.md', 'other\n')
    const out = ok(await a.sync(), 'a')
    // The move's old path shows up as a deletion first (default: sync it).
    assert.deepEqual(out.dialogs.map(d => d.kind), ['deletedFiles', 'writeDenied'])
    assert.deepEqual(out.result.restoredWriteDeniedFiles, ['営業部/提案.md', '経理部/提案.md'])
    assert.equal(a.exists('経理部/提案.md'), false)
    assert.equal(a.readText('営業部/提案.md'), '提案 v1\n')
    assert.equal(world.serverFile('営業部/提案.md')?.toString(), '提案 v1\n')
    assert.equal(world.serverFile('経理部/提案.md'), null)
    assert.equal(world.serverFile('営業部/別件.md')?.toString(), 'other\n')
    assert.deepEqual(writeDeniedBackups(a)[0].files, ['経理部/提案.md'])
    await settleAndCheck(world)
  })

  scenario('several unpushed commits: every allowed change survives the squash', async t => {
    const world = create(t)
    const [a] = world.members
    a.offline()
    a.write('営業部/1.md', 'one\n')
    assert.equal((await a.sync()).result.success, false)
    a.write('経理部/予算.md', '予算 改ざん\n').write('営業部/2.md', 'two\n')
    assert.equal((await a.sync()).result.success, false)
    a.write('営業部/1.md', 'one, edited\n')
    assert.equal((await a.sync()).result.success, false)
    a.online()
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.result.restoredWriteDeniedFiles, ['経理部/予算.md'])
    assert.equal(world.serverFile('営業部/1.md')?.toString(), 'one, edited\n')
    assert.equal(world.serverFile('営業部/2.md')?.toString(), 'two\n')
    assert.equal(world.serverFile('経理部/予算.md')?.toString(), BUDGET)
    assert.equal(a.readText('経理部/予算.md'), BUDGET)
    await settleAndCheck(world)
  })

  scenario('a denied edit the member already undid in a later commit: squashing alone gets the rest through', async t => {
    const world = create(t)
    const [a] = world.members
    a.offline()
    a.write('経理部/予算.md', '予算 改ざん\n').write('営業部/1.md', 'one\n')
    assert.equal((await a.sync()).result.success, false)
    a.write('経理部/予算.md', BUDGET).write('営業部/2.md', 'two\n')
    assert.equal((await a.sync()).result.success, false)
    a.online()
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs.map(d => d.kind), ['writeDenied'])
    assert.deepEqual(out.result.restoredWriteDeniedFiles, [], 'nothing needed restoring')
    assert.deepEqual(writeDeniedBackups(a), [])
    assert.equal(world.serverFile('営業部/1.md')?.toString(), 'one\n')
    assert.equal(world.serverFile('営業部/2.md')?.toString(), 'two\n')
    await settleAndCheck(world)
  })

  scenario('a teammate pushes concurrently: before the first push, and between the rejection and the re-push', async t => {
    const world = create(t)
    const [a, b] = world.members
    // b pushes right before a's first push: a's push fails non-fast-forward.
    a.write('経理部/予算.md', '予算 a\n').write('営業部/提案.md', '提案 a\n')
    a.beforeNextPush(async () => {
      b.write('営業部/b.md', 'b\n').write('経理部/予算.md', '予算 b\n') // b may edit 経理部
      ok(await b.sync(), 'b')
    })
    const raced = await a.sync()
    assert.equal(raced.result.errorType, 'push_failed')
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.result.conflictFiles, ['経理部/予算.md'])
    assert.equal(world.serverFile('経理部/予算.md')?.toString(), '予算 b\n')
    assert.equal(world.serverFile('営業部/提案.md')?.toString(), '提案 a\n')

    // Now b pushes after a's rejection, before a's push of the restored state.
    a.write('経理部/予算.md', '予算 a2\n').write('営業部/a2.md', 'a2\n')
    a.beforeNextPush(() => {}).beforeNextPush(async () => {
      b.write('営業部/b2.md', 'b2\n')
      ok(await b.sync(), 'b')
    })
    const between = await a.sync()
    assert.equal(between.result.errorType, 'push_failed')
    assert.deepEqual(between.result.restoredWriteDeniedFiles, ['経理部/予算.md'])
    assert.equal(a.hasPendingPush(), true)
    ok(await a.sync(), 'a')
    assert.equal(world.serverFile('営業部/a2.md')?.toString(), 'a2\n')
    assert.equal(world.serverFile('営業部/b2.md')?.toString(), 'b2\n')
    assert.equal(world.serverFile('経理部/予算.md')?.toString(), '予算 b\n')
    await settleAndCheck(world)
  })

  scenario('WRITE_DENIED and PROTECTED_CONFIG in one push: both asked, both restored, one push', async t => {
    const mcp = '{"mcpServers":{"playwright":{"command":"npx"}}}\n'
    const world = create(t, { seed: { '経理部/予算.md': BUDGET, '.mcp.json': mcp } })
    const [a] = world.members
    a.write('経理部/予算.md', '予算 改ざん\n').write('.mcp.json', '{"mcpServers":{"evil":{"command":"sh"}}}\n').write('ok.md', 'ok\n')

    a.willAnswer('writeDenied', 'cancel')
    const cancelled = await a.sync()
    assert.equal(cancelled.result.errorType, 'write_denied')
    assert.deepEqual(cancelled.result.protectedFiles, ['.mcp.json'])
    assert.deepEqual(cancelled.result.writeDeniedFiles, ['経理部/予算.md'])
    assert.deepEqual(cancelled.dialogs.map(d => [d.kind, d.answer]), [['protectedConfig', 'restore'], ['writeDenied', 'cancel']])
    assert.equal(a.readText('経理部/予算.md'), '予算 改ざん\n', 'nothing changed before both answers')

    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs.map(d => d.kind), ['protectedConfig', 'writeDenied'])
    assert.deepEqual(out.result.restoredProtectedFiles, ['.mcp.json'])
    assert.deepEqual(out.result.restoredWriteDeniedFiles, ['経理部/予算.md'])
    assert.equal(world.serverFile('ok.md')?.toString(), 'ok\n')
    assert.equal(world.serverFile('.mcp.json')?.toString(), mcp)
    assert.equal(world.serverFile('経理部/予算.md')?.toString(), BUDGET)
    assert.deepEqual(a.backups().map(b => b.metadata.reason).sort(), ['protected_config', 'write_denied'])
    await settleAndCheck(world)
  })

  scenario('a member allowed to edit the folder, and an admin, are not asked', async t => {
    const world = create(t, {}, [{ path: '経理部' }]) // every role "member"
    const [a, b, admin] = world.members
    admin.write('経理部/予算.md', '予算 admin\n')
    assert.deepEqual(ok(await admin.sync(), 'admin').dialogs, [])
    assert.equal(world.serverFile('経理部/予算.md')?.toString(), '予算 admin\n')
    world.setScopes(denyWrites([{ path: '経理部', members: ['a'] }]))
    ok(await b.sync(), 'b') // pick up the admin's version first
    b.write('経理部/予算.md', '予算 b\n')
    assert.deepEqual(ok(await b.sync(), 'b').dialogs, [])
    ok(await a.sync(), 'a')
    a.write('経理部/予算.md', '予算 a\n')
    assert.deepEqual(ok(await a.sync(), 'a').dialogs.map(d => d.kind), ['writeDenied'], 'the rule still applies to a')
    assert.equal(world.serverFile('経理部/予算.md')?.toString(), '予算 b\n')
    await settleAndCheck(world)
  })
})
