import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  boundaryCrossing,
  canCreatePrivateAt,
  crossingMessage,
  defaultViewerIds,
  isPrivateRoot,
  privateFolderOf,
  reachCount,
  viewersLabel,
  TO_PRIVATE_WARNING,
  type MyPrivateFolder,
  type PrivateFolderCreateContext,
} from '../shared/private-folder-ui'
import { createPrivateFoldersApi } from '../electron/private-folders-api'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

test('the chat has no way to create private folders (only the dialog does)', () => {
  const dir = join(import.meta.dirname, '..', 'electron')
  const files = ['chat-tools.ts', 'chat-server.ts', ...readdirSync(join(dir, 'agents')).map(f => join('agents', f))].filter(f => f.endsWith('.ts'))
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8')
    assert.doesNotMatch(src, /private-folders|createPrivateFolder|privateFolders:/, `${f} must not reach the private-folder API`)
  }
})

const EVAL: MyPrivateFolder = {
  scopeId: 's_eval',
  path: '人事部/評価',
  canWrite: true,
  viewerCount: 4,
  viewers: [
    { userId: 'u1', name: '山田', role: 'member' },
    { userId: 'u2', name: '高橋', role: 'member' },
    { userId: 'o', name: '佐藤', role: 'owner' },
  ],
}
const CONTRACTS: MyPrivateFolder = { ...EVAL, scopeId: 's_c', path: '営業部/契約', viewerCount: 3 }
const FOLDERS = [EVAL, CONTRACTS]

test('privateFolderOf: at or inside, NFC/NFD and separators, not a sibling prefix', () => {
  assert.equal(privateFolderOf('人事部/評価', FOLDERS)?.scopeId, 's_eval')
  assert.equal(privateFolderOf('人事部/評価/2026/a.xlsx', FOLDERS)?.scopeId, 's_eval')
  assert.equal(privateFolderOf('人事部\\評価\\a.md'.normalize('NFD'), FOLDERS)?.scopeId, 's_eval')
  assert.equal(privateFolderOf('人事部/評価基準.xlsx', FOLDERS), null)
  assert.equal(privateFolderOf('人事部', FOLDERS), null)
  assert.equal(isPrivateRoot('人事部/評価/', FOLDERS), true)
  assert.equal(isPrivateRoot('人事部/評価/x', FOLDERS), false)
})

test('boundaryCrossing: public→private, private→public, between, none', () => {
  assert.deepEqual(boundaryCrossing('人事部/a.md', '人事部/評価/a.md', FOLDERS), { kind: 'toPrivate', to: EVAL })
  assert.deepEqual(boundaryCrossing('人事部/評価/a.md', '人事部/a.md', FOLDERS), { kind: 'toPublic', from: EVAL })
  assert.equal(boundaryCrossing('人事部/評価/a.md', '人事部/評価/2026/a.md', FOLDERS), null)
  assert.equal(boundaryCrossing('人事部/a.md', '営業部/a.md', FOLDERS), null)
  assert.equal(boundaryCrossing('人事部/評価/a.md', '営業部/契約/a.md', FOLDERS)?.kind, 'between')
})

test('crossingMessage says what the plan decided', () => {
  const toPrivate = crossingMessage({ kind: 'toPrivate', to: EVAL }, 1, '移動')
  assert.match(toPrivate.message, new RegExp(TO_PRIVATE_WARNING))
  assert.match(toPrivate.message, /4人だけが見られます/)
  const toPublic = crossingMessage({ kind: 'toPublic', from: EVAL }, 2, '移動')
  assert.equal(toPublic.title, '全員に公開されます')
  assert.match(toPublic.message, /2件のファイル/)
})

const ctx = (over: Partial<PrivateFolderCreateContext> = {}): PrivateFolderCreateContext => ({
  role: 'member',
  managedDepartmentIds: [],
  department: { id: 'd_hr', name: '人事部', folder: '人事部' },
  managerIds: ['u_mgr'],
  members: [
    { userId: 'o', name: '佐藤', email: null, role: 'owner' },
    { userId: 'a', name: '鈴木', email: null, role: 'admin' },
    { userId: 'u_me', name: '山田', email: null, role: 'member' },
    { userId: 'u_mgr', name: '高橋', email: null, role: 'member' },
  ],
  ...over,
})

test('canCreatePrivateAt: owners/admins anywhere, managers only in their department', () => {
  assert.equal(canCreatePrivateAt('', ctx({ role: 'owner', department: null })), true)
  assert.equal(canCreatePrivateAt('人事部/採用', ctx({ role: 'admin' })), true)
  assert.equal(canCreatePrivateAt('人事部', ctx({ managedDepartmentIds: ['d_hr'] })), true)
  assert.equal(canCreatePrivateAt('人事部/採用', ctx({ managedDepartmentIds: ['d_hr'] })), true)
  assert.equal(canCreatePrivateAt('人事部/採用', ctx()), false)
  assert.equal(canCreatePrivateAt('営業部', ctx({ managedDepartmentIds: ['d_hr'], department: { id: 'd_sales', name: '営業部', folder: '営業部' } })), false)
  assert.equal(canCreatePrivateAt('', ctx({ managedDepartmentIds: ['d_hr'], department: null })), false)
})

test('default viewers = me + managers (never owners/admins); reach counts owners/admins', () => {
  assert.deepEqual(defaultViewerIds('u_me', ctx()), ['u_me', 'u_mgr'])
  assert.deepEqual(defaultViewerIds('a', ctx()), ['u_mgr'])
  assert.equal(reachCount(['u_me', 'u_mgr'], ctx().members), 4)
  assert.equal(reachCount(['u_me', 'u_me', 'gone'], ctx().members), 3)
})

test('viewersLabel lists names and the rest', () => {
  assert.equal(viewersLabel(EVAL, 2), '見られる人（4人）：山田、高橋、ほか2人')
})

function fakeFetch(routes: Record<string, (init?: RequestInit) => { status: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const key = `${init?.method ?? 'GET'} ${decodeURIComponent(url.replace('http://srv/api/companies/co', ''))}`
    const route = routes[key]
    if (!route) return new Response(JSON.stringify({ error: `no route ${key}` }), { status: 404 })
    const r = route(init)
    return new Response(JSON.stringify(r.body), { status: r.status })
  }) as typeof fetch
  return { f, calls }
}

test('api.create: success, taken name, outdated apps, offline', async () => {
  const { f, calls } = fakeFetch({
    'POST /private-folders': init => {
      const body = JSON.parse(String(init?.body))
      if (body.name === '提案書') return { status: 409, body: { error: '『営業部/提案書』というフォルダ名は使えません。別の名前にしてください。', code: 'FOLDER_NAME_UNAVAILABLE' } }
      if (body.name === 'old' && !body.force) return { status: 409, body: { error: 'x', code: 'OUTDATED_CLIENTS', canForce: true, members: [{ name: '伊藤', email: null }] } }
      return { status: 201, body: { success: true, data: { scopeId: 's1', path: `営業部/${body.name}`, viewerCount: 3 } } }
    },
  })
  const api = createPrivateFoldersApi({ baseUrl: () => 'http://srv', cookies: () => ['a=b'], fetch: f })
  assert.deepEqual(await api.create('co', { parentPath: '営業部', name: '顧客' }), { success: true, scopeId: 's1', path: '営業部/顧客', viewerCount: 3 })
  assert.equal((calls[0].init?.headers as Record<string, string>).Cookie, 'a=b')
  const taken = await api.create('co', { parentPath: '営業部', name: '提案書' })
  assert.equal(taken.success, false)
  assert.ok(!taken.success && taken.code === 'FOLDER_NAME_UNAVAILABLE' && taken.error.startsWith('『営業部/提案書』'))
  const old = await api.create('co', { parentPath: '営業部', name: 'old' })
  assert.ok(!old.success && old.code === 'OUTDATED_CLIENTS' && old.canForce && old.outdatedMembers?.[0] === '伊藤')
  assert.equal((await api.create('co', { parentPath: '営業部', name: 'old', force: true })).success, true)

  const offline = createPrivateFoldersApi({ baseUrl: () => 'http://srv', cookies: () => [], fetch: (async () => { throw new TypeError('fetch failed') }) as typeof fetch })
  assert.deepEqual(await offline.create('co', { parentPath: '', name: 'x' }), { success: false, offline: true, error: 'サーバーに接続できませんでした。' })
  assert.equal((await offline.mine('co')).success, false)
})

test('api.createContext: capabilities, members and the managers of the department containing the parent', async () => {
  const { f } = fakeFetch({
    'GET /me/capabilities': () => ({ status: 200, body: { data: { role: 'member', managedDepartmentIds: ['d_hr'] } } }),
    'GET /members': () => ({ status: 200, body: { data: [{ userId: 'u1', name: 'A', email: 'a@x', role: 'member', id: 'm1' }] } }),
    'GET /departments?flat=true': () => ({ status: 200, body: { data: [{ id: 'd_hr', name: '人事部', folder: '人事部' }, { id: 'd_x', name: 'X', folder: 'x' }] } }),
    'GET /departments/d_hr/managers': () => ({ status: 200, body: { data: { managers: [{ userId: 'u1' }] } } }),
  })
  const api = createPrivateFoldersApi({ baseUrl: () => 'http://srv', cookies: () => [], fetch: f })
  const res = await api.createContext('co', '人事部/採用'.normalize('NFD'))
  assert.ok(res.success)
  assert.deepEqual(res.context.department, { id: 'd_hr', name: '人事部', folder: '人事部' })
  assert.deepEqual(res.context.managerIds, ['u1'])
  assert.deepEqual(res.context.members, [{ userId: 'u1', name: 'A', email: 'a@x', role: 'member' }])
  const root = await api.createContext('co', '')
  assert.ok(root.success && root.context.department === null && root.context.managerIds.length === 0)
})
