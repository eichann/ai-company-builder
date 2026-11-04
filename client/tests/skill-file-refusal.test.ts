// The app's own file operations (file tree, editor, 公開する, 育成中) ask the
// same rule as the chat guard: a member who may not change a skill file gets
// a plain sentence before anything is written, instead of losing the change to
// .backups/ at the next sync. Unknown authority never blocks: the server decides.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPrivateFolderGuards } from '../electron/features/private-folders/guards'
import type { PrivateFoldersApi } from '../electron/private-folders-api'
import type { PathChecker } from '../electron/sync/path-check'
import { writePrivateScopesCache } from '../electron/sync/private-folders'
import { setLocalPrivateSkill } from '../electron/sync/local-ignores'

type Capabilities = Awaited<ReturnType<PrivateFoldersApi['capabilities']>>

function company(t: { after: (fn: () => void) => void }, answer: Capabilities) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-skill-refusal-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true })
  writePrivateScopesCache(root, { companyId: 'co', version: 'v', fetchedAt: new Date().toISOString(), scopes: [] })
  const guards = createPrivateFolderGuards({
    api: { capabilities: async () => answer } as unknown as PrivateFoldersApi,
    pathChecker: { reservedFolderOf: async () => null } as unknown as PathChecker,
  })
  return { root, guards, at: (rel: string) => path.join(root, rel) }
}

const MEMBER: Capabilities = { success: true, role: 'member', managedDepartmentFolders: [], skillEditing: { everywhere: false, folders: [] } }

test('a member is refused in a sentence, for a script as for a new file; other files are not asked about', async t => {
  const { guards, at } = company(t, MEMBER)
  assert.match(await guards.writeRefusal(at('.claude/skills/report/make.py')) ?? '', /Skill を直せる人/)
  assert.match(await guards.writeRefusal(at('営業部/.claude/agents/new.md')) ?? '', /Skill を直せる人/)
  assert.equal(await guards.writeRefusal(at('営業部/提案書.md')), null)
})

test('owner, a department\'s manager inside it and the people on the list are not refused', async t => {
  const admin = company(t, { success: true, role: 'admin', managedDepartmentFolders: [], skillEditing: { everywhere: false, folders: [] } })
  assert.equal(await admin.guards.skillRefusal(admin.at('.claude/skills/r/make.py')), null)
  const manager = company(t, { ...MEMBER, managedDepartmentFolders: ['営業部'] } as Capabilities)
  assert.equal(await manager.guards.skillRefusal(manager.at('営業部/.claude/skills/r/make.py')), null)
  assert.notEqual(await manager.guards.skillRefusal(manager.at('.claude/skills/r/make.py')), null)
  const named = company(t, { ...MEMBER, skillEditing: { everywhere: false, folders: ['営業部'] } } as Capabilities)
  assert.equal(await named.guards.skillRefusal(named.at('営業部/.claude/skills/r/make.py')), null)
  assert.notEqual(await named.guards.skillRefusal(named.at('経理部/.claude/skills/r/make.py')), null)
})

test('a skill kept on this computer is the member\'s to write, until they ask to share it', async t => {
  const { root, guards, at } = company(t, MEMBER)
  setLocalPrivateSkill(root, '営業部/.claude/skills/draft/', true)
  assert.equal(await guards.skillRefusal(at('営業部/.claude/skills/draft/SKILL.md')), null)
  assert.notEqual(await guards.skillRefusal(at('営業部/.claude/skills/draft/'), { sharing: true }), null, '公開する')
})

test('unknown never blocks: no answer from the server, or a server without the list', async t => {
  const offline = company(t, { success: false, offline: true, error: 'offline' })
  assert.equal(await offline.guards.skillRefusal(offline.at('.claude/skills/r/make.py')), null)
  const older = company(t, { success: true, role: 'member', managedDepartmentFolders: [] })
  assert.equal(await older.guards.skillRefusal(older.at('.claude/skills/r/make.py')), null)
})
