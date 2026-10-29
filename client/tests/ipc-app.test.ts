// IPC characterization: settings, session and server proxies, chat history
// wiring, skills and private-folder arguments — handlers whose logic lives in
// electron/main.ts itself (tests/ipc-harness loads the real registrations).
//
// Elsewhere: the history store (chat-history-store.test.ts), the skills cache
// (skills-refresh.test.ts), the private-folders API client
// (private-folder-ui.test.ts), the fetch identity headers
// (client-identity.test.ts). Here: config.json persistence and validation,
// the session cookie the proxies carry, history broadcasts to the window, the
// skills scan, argument checks before anything reaches the server.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadMain, writeFiles, SERVER_URL, type MainHarness } from './ipc-harness/main-harness.ts'
import type { ChatSession } from '../shared/chat-history'

let h: MainHarness
const LINK_ESCAPE = 'このファイル（またはフォルダ）は会社フォルダの外を指すリンク（シンボリックリンク）のため、アプリでは開いたり変更したりできません。'

before(async () => {
  h = await loadMain()
  await h.startApp()
})
after(() => h.shutdown())

const FAKE_KEY = 'sk-ant-FAKE-test-key-WXYZ'

test('settings: defaults, validation, persisted in userData/config.json', async () => {
  const configFile = path.join(h.userData, 'config.json')
  assert.equal(await h.invoke('config:getAuthMode'), 'claude-code')
  assert.equal(await h.invoke('config:getPermissionMode'), 'auto')
  assert.deepEqual(await h.invoke('config:getApiKeyStatus'), { set: false, encryptionAvailable: true })
  assert.equal(await h.invoke('config:hasApiKey'), false)
  assert.equal(await h.invoke('config:getServerUrl'), SERVER_URL)

  await assert.rejects(h.invoke('config:setAuthMode', 'gpt'), /不明なAI接続方式です。/)
  assert.equal(await h.invoke('config:setPermissionMode', 'yolo'), false)
  assert.equal(await h.invoke('config:setAuthMode', 'codex'), true)
  assert.equal(await h.invoke('config:setPermissionMode', 'bypassPermissions'), true)
  assert.deepEqual(await h.invoke('config:setApiKey', FAKE_KEY), { success: true })
  assert.equal(await h.invoke('config:getAuthMode'), 'codex')
  assert.equal(await h.invoke('config:getPermissionMode'), 'bypassPermissions')
  // The renderer gets the last four characters, never the key.
  assert.deepEqual(await h.invoke('config:getApiKeyStatus'), { set: true, last4: 'WXYZ', encryptionAvailable: true })
  assert.equal(await h.invoke('config:hasApiKey'), true)
  const raw = fs.readFileSync(configFile, 'utf-8')
  assert.ok(!raw.includes(FAKE_KEY), 'config.json holds no plain key')
  const saved = JSON.parse(raw)
  assert.equal(typeof saved.anthropicApiKeyEncrypted, 'string')
  delete saved.anthropicApiKeyEncrypted
  assert.deepEqual(saved, { serverUrl: SERVER_URL, authMode: 'codex', permissionMode: 'bypassPermissions' })
  await h.invoke('config:setAuthMode', 'claude-code')
  await h.invoke('config:setPermissionMode', 'auto')
})

test('settings: no OS encryption → a new API key is refused, never stored in plain text', async () => {
  const configFile = path.join(h.userData, 'config.json')
  h.fake.encryptionAvailable = false
  try {
    const result = await h.invoke('config:setApiKey', 'sk-ant-FAKE-other-key-0000')
    assert.equal(result.success, false)
    assert.match(result.error ?? '', /安全に保存する仕組み/)
    assert.ok(!fs.readFileSync(configFile, 'utf-8').includes('sk-ant-FAKE-other-key-0000'))
    assert.deepEqual(await h.invoke('config:getApiKeyStatus'), { set: true, last4: 'WXYZ', encryptionAvailable: false })
  } finally {
    h.fake.encryptionAvailable = true
  }
  assert.deepEqual(await h.invoke('config:setApiKey', ''), { success: true })
  assert.deepEqual(await h.invoke('config:getApiKeyStatus'), { set: false, encryptionAvailable: true })
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf-8')).anthropicApiKeyEncrypted, undefined)
})

test('settings: extra environment names for AI processes — empty by default, secrets and patterns refused', async () => {
  const configFile = path.join(h.userData, 'config.json')
  assert.deepEqual(await h.invoke('config:getAgentEnvPassthrough'), [])
  assert.deepEqual(await h.invoke('config:setAgentEnvPassthrough', [' JAVA_HOME ', 'java_home', 'GITHUB_TOKEN', 'AWS_PROFILE', 'MY_*', 'PYTHONPATH']), {
    names: ['JAVA_HOME', 'PYTHONPATH'], invalid: ['MY_*'], denied: ['GITHUB_TOKEN', 'AWS_PROFILE'],
  })
  assert.deepEqual(await h.invoke('config:getAgentEnvPassthrough'), ['JAVA_HOME', 'PYTHONPATH'])
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf-8')).agentEnvPassthrough, ['JAVA_HOME', 'PYTHONPATH'])
  await h.invoke('config:setAgentEnvPassthrough', [])
  assert.deepEqual(await h.invoke('config:getAgentEnvPassthrough'), [])
})

test('config:validateServerUrl: only an ACB server is valid', async () => {
  h.server.on('GET', '/api/config', { json: { success: true, data: { name: 'AI Company Builder', version: '1.2.3' } } })
  assert.deepEqual(await h.invoke('config:validateServerUrl', `${SERVER_URL}//`), { valid: true, serverName: 'AI Company Builder', version: '1.2.3' })
  h.server.on('GET', '/api/config', { json: { success: true, data: { name: 'Something else' } } })
  assert.deepEqual(await h.invoke('config:validateServerUrl', SERVER_URL), { valid: false, error: 'Not an AI Company Builder server' })
  h.server.on('GET', '/api/config', { status: 503, json: {} })
  assert.deepEqual(await h.invoke('config:validateServerUrl', SERVER_URL), { valid: false, error: 'Server responded with status 503' })
  assert.deepEqual(await h.invoke('config:validateServerUrl', 'http://elsewhere.test'), { valid: false, error: 'Could not connect: fetch failed' })
})

test('session: sign-in keeps the cookie for every proxied call; sign-out drops it', async () => {
  const user = { id: 'u1', email: 'me@example.com', name: 'Me' }
  h.server.on('POST', '/api/auth/sign-in/email', req => (JSON.parse(req.body!).password === 'right'
    ? { json: { user }, headers: { 'Set-Cookie': 'better-auth.session_token=tok.sig; Path=/; HttpOnly' } }
    : { status: 401, json: { message: 'Invalid email or password' } }))
  h.server.on('GET', '/api/me', req => (req.headers.get('Cookie')?.includes('tok.sig') ? { json: { success: true, data: user } } : { status: 401, json: {} }))
  h.server.on('GET', '/api/companies', { json: { success: true, data: [{ id: 'co-1' }] } })
  h.server.on('GET', '/api/companies/co-1/departments', { status: 403, json: { success: false, error: 'Forbidden' } })
  h.server.on('POST', '/api/auth/sign-out', { json: { success: true } })

  assert.deepEqual(await h.invoke('auth:getSession'), { success: false, user: null }) // no cookie: no request
  assert.equal(h.server.to('/api/me').length, 0)
  assert.deepEqual(await h.invoke('auth:signIn', 'me@example.com', 'wrong'), { success: false, error: 'Invalid email or password' })
  assert.deepEqual(await h.invoke('auth:signIn', 'me@example.com', 'right'), { success: true, data: { user } })
  const signIn = h.server.to('/api/auth/sign-in/email').at(-1)!
  assert.equal(signIn.headers.get('Origin'), 'app://')
  assert.ok(signIn.headers.get('X-ACB-Client-Version'), 'server requests carry the client identity')

  assert.deepEqual(await h.invoke('auth:getSession'), { success: true, user })
  assert.deepEqual(await h.invoke('api:getCompanies'), { success: true, data: [{ id: 'co-1' }] })
  assert.deepEqual(await h.invoke('api:getDepartments', 'co-1'), { success: false, error: 'Forbidden' })
  for (const p of ['/api/me', '/api/companies', '/api/companies/co-1/departments']) {
    assert.match(h.server.to(p).at(-1)!.headers.get('Cookie') ?? '', /better-auth\.session_token=tok\.sig/, p)
  }

  h.server.on('POST', '/api/auth/sign-up/email', { status: 502, text: '<html>Bad gateway</html>' })
  const signUp = await h.invoke<{ success: boolean; error: string }>('auth:signUp', 'new@example.com', 'pw')
  assert.equal(signUp.success, false)
  assert.equal(signUp.error, `API returned non-JSON response (status 502) from ${SERVER_URL}. Preview: <html>Bad gateway</html>`)
  assert.deepEqual(JSON.parse(h.server.to('/api/auth/sign-up/email')[0].body!), { email: 'new@example.com', password: 'pw', name: 'new' })

  // A company id is one path segment of the URL, never more.
  await h.invoke('api:getDepartments', '../me?x=1')
  assert.equal(h.server.requests.at(-1)!.path, '/api/companies/..%2Fme%3Fx%3D1/departments')

  assert.deepEqual(await h.invoke('auth:signOut'), { success: true })
  assert.match(h.server.to('/api/auth/sign-out')[0].headers.get('Cookie') ?? '', /tok\.sig/)
  const asked = h.server.to('/api/me').length
  assert.deepEqual(await h.invoke('auth:getSession'), { success: false, user: null })
  assert.equal(h.server.to('/api/me').length, asked)

  // Signing out offline still forgets the session on this computer.
  await h.invoke('auth:signIn', 'me@example.com', 'right')
  h.server.offline = true
  assert.deepEqual(await h.invoke('auth:signOut'), { success: false, error: 'fetch failed' })
  h.server.offline = false
  assert.deepEqual(await h.invoke('auth:getSession'), { success: false, user: null })
  assert.equal(h.server.to('/api/me').length, asked)
})

test('chat history: saves answer with a receipt and broadcast to the window; the unload flush is synchronous', async () => {
  const window = h.renderer()
  window.clearSent()
  const session: ChatSession = {
    id: 'chat-1', companyId: 'co-1', title: '相談', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    messages: [{ id: 'm1', role: 'user', content: '見積もりの相談', timestamp: '2026-01-01T00:00:00Z' }],
  }
  const receipt = await h.invoke<{ status: string; revision: number }>('chatHistory:saveSession', 'co-1', session)
  assert.equal(receipt.status, 'saved')
  assert.deepEqual(Object.keys(receipt).sort(), ['revision', 'status'])
  const summaries = await h.invoke<Array<Record<string, unknown>>>('chatHistory:getSummaries', 'co-1')
  assert.deepEqual(summaries.map(s => [s.id, s.messageCount, 'messages' in s]), [['chat-1', 1, false]])
  assert.deepEqual(await h.invoke('chatHistory:search', 'co-1', '見積'), ['chat-1']) // ids only
  assert.equal((await h.invoke<ChatSession>('chatHistory:getSession', 'co-1', 'chat-1')).messages[0].content, '見積もりの相談')
  assert.ok(await h.invoke('chatHistory:patchSession', 'co-1', 'chat-1', { pinned: true }))

  const current = await h.invoke<ChatSession>('chatHistory:getSession', 'co-1', 'chat-1')
  const flushed = h.sendSync<{ result: { status: string; revision: number } }>('chatHistory:flushSession', 'co-1', { ...current, title: '相談2' })
  assert.deepEqual(Object.keys(flushed), ['result'])
  assert.equal(flushed.result.status, 'saved')
  assert.ok(flushed.result.revision > receipt.revision)
  const invalid = h.sendSync<{ error?: string }>('chatHistory:flushSession', '../escape', session)
  assert.equal(typeof invalid.error, 'string')

  assert.equal(await h.invoke('chatHistory:deleteSession', 'co-1', 'chat-1'), true)
  assert.deepEqual(window.sentOn('chatHistory:changed'), [
    [{ companyId: 'co-1', sessionId: 'chat-1', kind: 'save' }],
    [{ companyId: 'co-1', sessionId: 'chat-1', kind: 'patch' }],
    [{ companyId: 'co-1', sessionId: 'chat-1', kind: 'save' }],
    [{ companyId: 'co-1', sessionId: 'chat-1', kind: 'delete', deletedSessionId: 'chat-1' }],
  ])
  assert.deepEqual(await h.invoke('chatHistory:getSummaries', 'co-1'), [])
})

test('skills: the scan (company-wide vs department, nested groups, private, nurturing, tools) and its edits', async () => {
  const root = h.companyDir('skills-co')
  await h.invoke('fs:registerAllowedRoot', root)
  const skill = (name: string, extra = '') => `---\nname: ${name}\ndescription: ${name} の説明\n${extra}---\n\n# ${name}\n`
  writeFiles(root, {
    '.gitignore': 'node_modules/\n\n# Private skills\n営業/.claude/skills/beta/\n',
    '.claude/skills/alpha/SKILL.md': skill('アルファ'),
    '.claude/skills/no-skill-md/readme.md': '',
    '営業/.claude/skills/beta/SKILL.md': skill('ベータ', 'status: nurturing\n'),
    '営業/.claude/skills/beta/rules/r.md': '', '営業/.claude/skills/beta/rules/r.txt': '',
    '営業/.claude/skills/beta/references/ref.pdf': '', '営業/.claude/skills/beta/scripts/run.sh': '',
    '営業/.claude/skills/beta/tools/app/package.json': JSON.stringify({ name: 'beta-app', scripts: { start: 'x' } }),
    '営業/.claude/skills/beta/tools/plain/index.html': '',
    '営業/チームA/.claude/skills/gamma/SKILL.md': 'no frontmatter',
  })
  type Skill = Record<string, unknown> & { files: Record<string, unknown> }
  const list = async (dept: string, deptName?: string, force?: boolean) =>
    (await h.invoke<{ success: boolean; skills: Skill[] }>('skills:list', root, dept, 'dept-id', deptName, force ? { force } : undefined)).skills
  const rel = (p: unknown) => path.relative(root, String(p)).split(path.sep).join('/')

  assert.deepEqual((await list('')).map(s => [s.id, s.name, s.group, s.isPrivate, s.isNurturing]), [['dept-id-全社-alpha', 'アルファ', '全社', false, false]])
  const dept = await list('営業', '営業部')
  assert.deepEqual(dept.map(s => [s.id, s.name, s.description, s.group, s.isPrivate, s.isNurturing]), [
    ['dept-id-営業部-beta', 'ベータ', 'ベータ の説明', '営業部', true, true],
    ['dept-id-営業部-チームa-gamma', 'gamma', '', '営業部 / チームA', false, false],
  ])
  const beta = dept[0]
  assert.deepEqual({
    skillPath: rel(beta.skillPath), skillMd: rel(beta.files.skillMd), rules: (beta.files.rules as string[]).map(rel),
    references: (beta.files.references as string[]).map(rel), scripts: (beta.files.scripts as string[]).map(rel),
    tools: (beta.files.tools as Array<Record<string, unknown>>).map(t => ({ ...t, path: rel(t.path) })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
  }, {
    skillPath: '営業/.claude/skills/beta', skillMd: '営業/.claude/skills/beta/SKILL.md', rules: ['営業/.claude/skills/beta/rules/r.md'],
    references: ['営業/.claude/skills/beta/references/ref.pdf'], scripts: ['営業/.claude/skills/beta/scripts/run.sh'],
    tools: [
      { name: 'app', displayName: 'beta-app', path: '営業/.claude/skills/beta/tools/app', hasPackageJson: true, startCommand: 'start' },
      { name: 'plain', displayName: 'plain', path: '営業/.claude/skills/beta/tools/plain', hasPackageJson: false, startCommand: undefined },
    ],
  })
  assert.deepEqual(Object.keys(dept[1].files), ['skillMd'])

  // Reused until forced (watcher events and the member's own edits force it).
  writeFiles(root, { '営業/.claude/skills/delta/SKILL.md': skill('デルタ') })
  assert.equal((await list('営業', '営業部')).length, 2)
  assert.equal((await list('営業', '営業部', true)).length, 3)

  const gitignore = () => fs.readFileSync(path.join(root, '.gitignore'), 'utf-8')
  assert.deepEqual(await h.invoke('skills:makePrivate', root, '営業/.claude/skills/delta/'), { success: true })
  assert.equal(gitignore(), 'node_modules/\n\n# Private skills\n営業/.claude/skills/delta/\n営業/.claude/skills/beta/\n')
  assert.deepEqual(await h.invoke('skills:publish', root, '営業/.claude/skills/beta/'), { success: true })
  assert.deepEqual(await h.invoke('skills:publish', root, '営業/.claude/skills/delta/'), { success: true })
  assert.equal(gitignore(), 'node_modules/\n\n') // the header goes with its last entry
  assert.deepEqual((await list('営業', '営業部')).map(s => s.isPrivate), [false, false, false]) // edits invalidate the cache

  const md = path.join(root, '営業', '.claude', 'skills', 'delta', 'SKILL.md')
  assert.deepEqual(await h.invoke('skills:toggleNurturing', md, true), { success: true })
  assert.equal(fs.readFileSync(md, 'utf-8'), skill('デルタ', 'status: nurturing\n'))
  assert.deepEqual(await h.invoke('skills:toggleNurturing', md, false), { success: true })
  assert.equal(fs.readFileSync(md, 'utf-8'), skill('デルタ'))
  assert.deepEqual(await h.invoke('skills:toggleNurturing', path.join(root, '営業/チームA/.claude/skills/gamma/SKILL.md'), true), { success: false, error: 'No frontmatter found' })
  assert.deepEqual(await h.invoke('skills:toggleNurturing', path.join(root, 'missing', 'SKILL.md'), true), { success: false, error: 'SKILL.md not found' })

  // Only SKILL.md files inside a company; a .gitignore entry is one line;
  // a .gitignore that is a link out of the company is never written.
  const outside = h.companyDir('skills-outside')
  writeFiles(outside, { 'SKILL.md': skill('外'), 'x.md': '---\nname: x\n---\n' })
  const denied = { success: false, error: 'Access denied: path is outside allowed directories' }
  assert.deepEqual(await h.invoke('skills:toggleNurturing', path.join(outside, 'SKILL.md'), true), denied)
  assert.deepEqual(await h.invoke('skills:toggleNurturing', path.join(root, '.gitignore'), true), { success: false, error: 'Not a SKILL.md' })
  assert.deepEqual(await h.invoke('skills:list', outside, '', 'd'), { ...denied, skills: [] })
  // The department folder stays under this company: no absolute path, no
  // `..` (not even into another registered company), no link out.
  writeFiles(outside, { '.claude/skills/leak/SKILL.md': skill('漏れ') })
  const sibling = h.companyDir('skills-sibling')
  writeFiles(sibling, { 'd/.claude/skills/other/SKILL.md': skill('他社') })
  await h.invoke('fs:registerAllowedRoot', sibling)
  const invalidFolder = { success: false, error: 'Invalid department folder', skills: [] }
  for (const folder of [outside, '../skills-outside', '..', '営業/../../skills-outside', '..\\skills-outside', '../skills-sibling/d', '営業\0']) {
    assert.deepEqual(await h.invoke('skills:list', root, folder, 'd'), invalidFolder, JSON.stringify(folder))
  }
  fs.symlinkSync(outside, path.join(root, 'linked-dept'))
  assert.deepEqual(await h.invoke('skills:list', root, 'linked-dept', 'd'), { success: false, error: LINK_ESCAPE, skills: [] })
  fs.unlinkSync(path.join(root, 'linked-dept'))
  // A department folder that does not exist (yet) lists nothing, as before.
  assert.deepEqual(await h.invoke('skills:list', root, '未作成', 'd'), { success: true, skills: [] })
  for (const channel of ['skills:publish', 'skills:makePrivate']) {
    assert.deepEqual(await h.invoke(channel, outside, 'a/.claude/skills/x/'), denied, channel)
    assert.deepEqual(await h.invoke(channel, root, '営業/.claude/skills/x/\n!.backups/'), { success: false, error: 'Invalid skill path' }, channel)
  }
  fs.renameSync(path.join(root, '.gitignore'), path.join(outside, '.gitignore'))
  fs.symlinkSync(path.join(outside, '.gitignore'), path.join(root, '.gitignore'))
  const linked = await h.invoke<{ success: boolean; error: string }>('skills:makePrivate', root, '営業/.claude/skills/x/')
  assert.deepEqual(linked, { success: false, error: LINK_ESCAPE })
  assert.equal(fs.readFileSync(path.join(outside, '.gitignore'), 'utf-8'), 'node_modules/\n\n')
  assert.equal(fs.readFileSync(path.join(outside, 'SKILL.md'), 'utf-8'), skill('外'))
})

test('tools:start runs npm only in a skill tool folder inside a company, with a script the scan offers', async () => {
  const root = h.companyDir('tools-co')
  await h.invoke('fs:registerAllowedRoot', root)
  const outside = h.companyDir('tools-outside')
  const pkg = JSON.stringify({ name: 't', scripts: { dev: 'x' } })
  writeFiles(outside, { 'app/package.json': pkg })
  writeFiles(root, { 'app/package.json': pkg, '営業/.claude/skills/s/tools/app/package.json': pkg })
  const tool = path.join(root, '営業', '.claude', 'skills', 's', 'tools', 'app')
  const table: Array<[unknown[], unknown]> = [
    [[path.join(outside, 'app')], { success: false, error: 'Access denied: path is outside allowed directories' }],
    [[path.join(root, 'app')], { success: false, error: 'Not a skill tool folder' }],
    [[path.join(tool, '..')], { success: false, error: 'Not a skill tool folder' }],
    [[tool, 'build && rm -rf ~'], { success: false, error: 'Unknown start command' }],
    [[tool, '--prefix=/'], { success: false, error: 'Unknown start command' }],
  ]
  for (const [args, expected] of table) assert.deepEqual(await h.invoke('tools:start', ...args), expected, JSON.stringify(args))
  for (const dir of [path.join(outside, 'app'), path.join(root, 'app'), tool]) assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false)
})

test('shell:openExternal opens web pages and mail links only', async () => {
  const refused = { success: false, error: 'このリンクは開けません（http / https / mailto のみ開けます）。' }
  for (const url of ['http://localhost:3100', 'https://example.com/a?b=1', 'mailto:someone@example.com']) {
    assert.deepEqual(await h.invoke('shell:openExternal', url), { success: true }, url)
  }
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'vscode://file/etc/passwd', 'smb://host/share', '/Applications/Calculator.app', '', 42, null]) {
    assert.deepEqual(await h.invoke('shell:openExternal', url), refused, String(url))
  }
  assert.deepEqual(h.fake.openedExternal, ['http://localhost:3100', 'https://example.com/a?b=1', 'mailto:someone@example.com'])
})

test('private folders and write access: malformed arguments never reach the server; create forwards only known fields', async () => {
  const before = h.server.requests.length
  const invalid = { success: false, offline: false, error: 'Invalid arguments' }
  const table: Array<[string, unknown[], unknown]> = [
    ['privateFolders:mine', [''], { success: false, offline: false, error: 'companyId is required' }],
    ['privateFolders:mine', [42], { success: false, offline: false, error: 'companyId is required' }],
    ['privateFolders:createContext', ['', '人事'], invalid],
    ['privateFolders:createContext', ['co-1', 5], invalid],
    ['privateFolders:create', ['co-1', null], invalid],
    ['privateFolders:create', ['co-1', { name: 1, parentPath: '' }], invalid],
    ['privateFolders:create', ['', { name: 'a', parentPath: '' }], invalid],
    ['writeAccess:get', [''], null],
    ['writeAccess:get', [{}], null],
  ]
  for (const [channel, args, expected] of table) assert.deepEqual(await h.invoke(channel, ...args), expected, `${channel} ${JSON.stringify(args)}`)
  assert.equal(h.server.requests.length, before)

  h.server.on('POST', '/api/companies/co-1/private-folders', { status: 201, json: { success: true, data: { scopeId: 's1', path: '人事/評価', viewerCount: 2 } } })
  assert.deepEqual(await h.invoke('privateFolders:create', 'co-1', { parentPath: '人事', name: '評価', viewers: ['u1', 3], editors: 'u2', force: 'yes', extra: true }),
    { success: true, scopeId: 's1', path: '人事/評価', viewerCount: 2 })
  assert.deepEqual(JSON.parse(h.server.to('/api/companies/co-1/private-folders')[0].body!), { parentPath: '人事', name: '評価', viewers: ['u1'] })
  await h.invoke('privateFolders:create', 'co-1', { parentPath: '', name: 'x', editors: ['u2'], force: true })
  assert.deepEqual(JSON.parse(h.server.to('/api/companies/co-1/private-folders')[1].body!), { parentPath: '', name: 'x', editors: ['u2'], force: true })
})

test('chat server: its port and token reach the renderer on request and after each load', async () => {
  const info = await h.invoke<{ port: number; authToken: string }>('chat-server:getInfo')
  assert.equal(typeof info.port, 'number')
  assert.match(info.authToken, /^[0-9a-f-]{36}$/)
  const window = h.renderer()
  window.clearSent()
  window.emit('did-finish-load')
  assert.deepEqual(window.sentOn('chat-server:info'), [[info]])
})
