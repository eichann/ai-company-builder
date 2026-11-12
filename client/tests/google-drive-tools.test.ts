/**
 * Google Drive in the consultation (`.claude/rules/google-drive.md`), the app's side.
 *
 * Guards (each mutation-checked, see the PR):
 * - picking opens only the server's Picker page in the member's browser, with the one-time pick
 *   ticket in the URL fragment; the ticket never reaches the AI's tool output, a record-token
 *   request or a log line; asking for the ticket and waiting for its result use the member's session;
 * - the app waits for the result, stops waiting (and closes the ticket) when the AI is stopped or after
 *   10 minutes, and says cancelled / failed as the server answers;
 * - without the Drive permission, the first pick opens Google's consent (features: drive only)
 *   and waits for it — nothing is picked before;
 * - the Drive tools exist only where the server says Drive is set up; drive_put only with an
 *   act token (Codex reads);
 * - drive_put reads a local file only inside the company folder (by real location), never in
 *   a private folder (the refusal never names it) or a folder left out on this computer; PDF /
 *   HTML only, content checked; the same file, folder and name always carry the same request key;
 * - only Drive ids come back as picks; a picked PDF is saved under `.personal/google-drive/`;
 * - a pasted link's files reach the ticket only as Drive ids, and only for a files pick.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AllowedRoots } from '../electron/allowed-roots'
import { createRecordsApi } from '../electron/records/api'
import { createRecordTools } from '../electron/records/tools'
import { createDrivePicking, createDriveTools, drivePutRequestKey, readLocalFileForDrive, type DrivePickingDeps } from '../electron/features/google/drive'
import { recordToolProviders } from '../electron/records/tool-providers'
import type { MyGoogle } from '../shared/google'

const TOKEN = 'acb_rec_co.' + 'a'.repeat(64)
const SESSION = 'better-auth.session_token=SECRET.sig'
const TICKET = 'co.' + 'b'.repeat(64)
const TICKET_ID = 'ticket-1'
const FOLDER = 'fake-folder-proposals-0001'
const DOC = 'fake-doc-past-proposal-0001'
const PDF = Buffer.from('%PDF-1.7\n%%EOF\n')

interface Seen { url: string; method: string; headers: Record<string, string>; body?: string }

type PickState = Record<string, unknown>
/** What the server says while the app waits: by default once waiting, then the folder picked. */
const PICKED: PickState = { state: 'picked', picks: [{ id: FOLDER, kind: 'folder', name: '提案書', mimeType: 'application/vnd.google-apps.folder', pickedAt: 't', expiresAt: 't' }, { id: 'bad id!', kind: 'file', name: 'x', mimeType: 'x', pickedAt: 't', expiresAt: 't' }], refused: 0 }

function fakeServer(scope: 'read' | 'act', opts: { available?: boolean; pdf?: boolean; revision?: string; states?: PickState[]; ticket?: string } = {}) {
  const seen: Seen[] = []
  const states = [...(opts.states ?? [{ state: 'waiting', opened: false }, PICKED])]
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body as string | undefined })
    const json = (status: number, data: unknown) => new Response(JSON.stringify({ success: true, data }), { status })
    if (url.endsWith('/me/record-tokens')) return json(201, { token: TOKEN, tokenId: 'tok-1', scope, expiresAt: 'x' })
    if (url.endsWith('/api/records-ai/types')) return json(200, { types: [] })
    if (url.endsWith('/api/records-ai/plugins')) return json(200, { plugins: [] })
    if (url.endsWith('/api/records-ai/google/drive/status')) {
      return json(200, { available: opts.available ?? true, granted: true, picks: [], puts: [{ fileId: 'fake-upload-1', name: '面談報告書', mimeType: 'application/vnd.google-apps.document', folderId: FOLDER, link: 'l', revisionId: opts.revision ?? 'version:1', at: 't' }] })
    }
    if (url.endsWith('/api/records-ai/google/drive/read')) {
      return json(200, opts.pdf
        ? { file: { id: DOC, name: '手書き/メモ.pdf', mimeType: 'application/pdf', modifiedTime: null }, header: 'H', text: null, footer: 'F', truncated: false, pdfBase64: PDF.toString('base64'), instructionLike: [] }
        : { file: { id: DOC, name: '過去の提案書', mimeType: 'application/vnd.google-apps.document', modifiedTime: null }, header: '【外から】', text: '対象：営業部', footer: '【ここまで】', truncated: false, pdfBase64: null, instructionLike: [] })
    }
    if (url.endsWith('/api/records-ai/google/drive/put')) {
      return json(200, { existing: false, drivePut: { id: 'drive-put-1', state: 'done', name: 'x.pdf', mimeType: 'application/pdf', bytes: 1, sha256: 'x', folderId: FOLDER, folderName: '提案書', fileId: 'fake-upload-1', revisionId: 'rev-1', link: 'https://drive.google.com/file/d/fake-upload-1/view', createdAt: 't', finishedAt: 't', reason: null } })
    }
    if (url.endsWith('/me/google/drive/pick-tickets')) return json(200, { ticketId: TICKET_ID, ticket: opts.ticket ?? TICKET, expiresAt: 't' })
    if (url.endsWith(`/me/google/drive/pick-tickets/${TICKET_ID}`)) {
      if (init.method === 'DELETE') return json(200, { closed: true })
      return json(200, states.length > 1 ? states.shift() : states[0])
    }
    return json(404, {})
  }) as unknown as typeof globalThis.fetch
  return { fetch, seen }
}

const my = (features: MyGoogle['features']): MyGoogle => ({ available: true, reason: null, connected: true, status: 'active', googleEmail: 'sato@div.example', features, domain: 'div.example', practice: false })

function picking(server: ReturnType<typeof fakeServer>, over: Partial<DrivePickingDeps> = {}) {
  const opened: string[] = []
  const connects: string[][] = []
  const logs: string[] = []
  let features: MyGoogle['features'] = ['minutes', 'drive']
  const deps: DrivePickingDeps = {
    baseUrl: () => 'https://acb.example.jp', cookies: () => [SESSION], fetch: server.fetch,
    openBrowser: async url => { opened.push(url) },
    google: {
      status: async () => ({ success: true, data: my(features) }),
      connect: async (_c, f) => { connects.push(f); return { success: true } },
    },
    sleep: async () => { features = ['minutes', 'drive'] },
    log: { warn: (...a: unknown[]) => { logs.push(a.join(' ')) } },
    ...over,
  }
  return { p: createDrivePicking(deps), opened, connects, logs, withoutDrive: () => { features = ['minutes'] } }
}

async function tools(scope: 'read' | 'act', root: string | null, opts: { available?: boolean; pdf?: boolean; revision?: string; topicTask?: () => string | null; onlyUnder?: string | null } = {}, pick = picking(fakeServer(scope))) {
  const server = fakeServer(scope, opts)
  const api = createRecordsApi({ baseUrl: () => 'https://acb.example.jp', cookies: () => [SESSION], fetch: server.fetch })
  const access = await api.openTurn('co', { conversationId: 'conv-1', agent: 'claude-code', scope })
  const roots = new AllowedRoots()
  if (root) roots.add(root)
  const t = await createRecordTools(access!, undefined, {
    companyId: 'co', conversationId: 'conv-1',
    toolProviders: [a => createDriveTools(a, { picking: pick.p, companyId: 'co', companyRoot: root, local: { pathGuard: roots, notDownloaded: () => ['営業部/置いていない'], privateFolders: () => ['人事'], ...(opts.onlyUnder !== undefined ? { onlyUnder: opts.onlyUnder } : {}) }, topicTask: opts.topicTask })],
  })
  return { t: t!, seen: server.seen, pick }
}

function companyFolder(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-drive-')))
  fs.mkdirSync(path.join(root, '営業部', '.personal'), { recursive: true })
  fs.writeFileSync(path.join(root, '営業部', 'ご提案.pdf'), PDF)
  fs.writeFileSync(path.join(root, '営業部', '.personal', 'ご提案.html'), '<p>提案</p>')
  fs.writeFileSync(path.join(root, '営業部', '偽物.pdf'), '<html>not a pdf</html>')
  fs.writeFileSync(path.join(root, '営業部', 'メモ.docx'), 'PK')
  fs.writeFileSync(path.join(root, '営業部', '.personal', '面談報告書.md'), '# 面談報告書\n')
  // A private folder's clone: a repository of its own.
  fs.mkdirSync(path.join(root, '営業部', '秘密の案件', '.git'), { recursive: true })
  fs.writeFileSync(path.join(root, '営業部', '秘密の案件', '提案.pdf'), PDF)
  fs.mkdirSync(path.join(root, '人事'), { recursive: true })
  fs.writeFileSync(path.join(root, '人事', '評価.pdf'), PDF)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-outside-'))
  fs.writeFileSync(path.join(outside, 'secret.pdf'), PDF)
  fs.symlinkSync(path.join(outside, 'secret.pdf'), path.join(root, '営業部', 'link.pdf'))
  return root
}

test('the Drive tools exist only where Drive is set up; drive_put only with an act token', async () => {
  assert.deepEqual((await tools('act', null, { available: false })).t.specs.filter(s => s.name.startsWith('drive_')), [])
  const act = (await tools('act', null)).t.specs.map(s => s.name).filter(n => n.startsWith('drive_'))
  assert.deepEqual(act.sort(), ['drive_pick_files', 'drive_pick_folder', 'drive_picked', 'drive_put', 'drive_read'])
  const read = (await tools('read', null)).t.specs.map(s => s.name).filter(n => n.startsWith('drive_'))
  assert.ok(!read.includes('drive_put'))
  assert.ok((await tools('act', null)).t.instructions.includes('【Google Drive】'))
})

test('picking: the browser opens only the server\'s Picker page, the ticket in the fragment; the AI sees ids and names only', async () => {
  const pick = picking(fakeServer('act'))
  const { t, seen } = await tools('act', null, {}, pick)
  const out = await t.execute('drive_pick_folder', {})
  assert.deepEqual(JSON.parse(out).picked, [{ id: FOLDER, name: '提案書', kind: 'folder', mimeType: 'application/vnd.google-apps.folder' }])
  assert.deepEqual(pick.opened, [`https://acb.example.jp/api/google-picker#t=${TICKET}`])
  // The ticket is the page's alone: not in the AI's answer, a record-token request or a log line.
  assert.ok(!out.includes(TICKET))
  for (const s of seen) assert.ok(!JSON.stringify(s).includes(TICKET))
  assert.deepEqual(pick.logs.filter(l => l.includes(TICKET)), [])
})

test('picking uses the member\'s session (not the record token) to start and to wait; the released app\'s token route is never asked', async () => {
  const server = fakeServer('act')
  const pick = picking(server)
  const r = await pick.p.pick('co', 'files')
  assert.equal(r.ok, true)
  const calls = server.seen.filter(s => s.url.includes('/me/google/drive/'))
  assert.deepEqual(calls.map(c => `${c.method} ${c.url.replace('https://acb.example.jp/api/companies/co', '')}`),
    ['POST /me/google/drive/pick-tickets', `GET /me/google/drive/pick-tickets/${TICKET_ID}`, `GET /me/google/drive/pick-tickets/${TICKET_ID}`])
  for (const c of calls) {
    assert.equal(c.headers.Cookie, SESSION)
    assert.equal(c.headers.Authorization, undefined)
  }
  assert.deepEqual(JSON.parse(calls[0].body!), { mode: 'files' })
})

test('the browser never opens anything but the server\'s Picker page with a ticket of the right shape', async () => {
  for (const ticket of ['co.short', 'co.' + 'b'.repeat(64) + '#x', 'https://evil.example/?' + 'b'.repeat(64)]) {
    const server = fakeServer('act', { ticket })
    const pick = picking(server)
    const r = await pick.p.pick('co', 'folder')
    assert.equal(r.ok, false, ticket)
    assert.deepEqual(pick.opened, [], ticket)
  }
  const pick = picking(fakeServer('act'), { baseUrl: () => 'file:///etc' })
  assert.equal((await pick.p.pick('co', 'folder')).ok, false)
  assert.deepEqual(pick.opened, [])
})

test('a pasted link: the ticket carries only Drive ids to show, in files mode only', async () => {
  const server = fakeServer('act')
  const pick = picking(server)
  await pick.p.pick('co', 'files', undefined, { fileIds: [DOC, 'bad id!', "x');alert(1)//", DOC] })
  await pick.p.pick('co', 'folder', undefined, { fileIds: [DOC] })
  await pick.p.pick('co', 'files', undefined, { fileIds: ['bad id!'] })
  const asked = server.seen.filter(s => s.url.endsWith('/pick-tickets')).map(s => JSON.parse(s.body!).fileIds)
  assert.deepEqual(asked, [[DOC], undefined, undefined])
})

test('waiting: cancelled in the browser, failed on the server, the AI stopped, ten minutes passed', async () => {
  const closes = (server: ReturnType<typeof fakeServer>) => server.seen.filter(s => s.method === 'DELETE' && s.url.endsWith(`/pick-tickets/${TICKET_ID}`)).length

  const cancelled = fakeServer('act', { states: [{ state: 'waiting', opened: true }, { state: 'cancelled' }] })
  const c = await picking(cancelled).p.pick('co', 'folder')
  assert.deepEqual([c.ok, !c.ok && c.reason], [false, 'cancelled'])

  const failed = fakeServer('act', { states: [{ state: 'failed', error: '管理者が Google Drive のファイル選び（Picker）をまだ設定していません。' }] })
  const f = await picking(failed).p.pick('co', 'folder')
  assert.deepEqual([f.ok, !f.ok && f.reason, !f.ok && f.message], [false, 'refused', '管理者が Google Drive のファイル選び（Picker）をまだ設定していません。'])

  // The AI's turn stopped while waiting: the app stops and closes the ticket on the server.
  const stopped = fakeServer('act', { states: [{ state: 'waiting', opened: true }] })
  const ctl = new AbortController()
  let polls = 0
  const s = await picking(stopped, { sleep: async () => { if (++polls === 3) ctl.abort() } }).p.pick('co', 'folder', ctl.signal)
  assert.deepEqual([s.ok, !s.ok && s.reason], [false, 'cancelled'])
  assert.equal(closes(stopped), 1)

  // Nobody chose within the time: the app stops waiting and closes the ticket.
  const slow = fakeServer('act', { states: [{ state: 'waiting', opened: false }] })
  let clock = 0
  const t = await picking(slow, { now: () => clock, sleep: async () => { clock += 60_000; if (clock > 20 * 60_000) throw new Error('still waiting after 20 minutes') } }).p.pick('co', 'folder')
  assert.deepEqual([t.ok, !t.ok && t.reason, !t.ok && t.message], [false, 'cancelled', '選ばれないまま時間が過ぎました。'])
  assert.equal(closes(slow), 1)
  assert.equal(slow.seen.filter(x => x.method === 'GET' && x.url.endsWith(`/pick-tickets/${TICKET_ID}`)).length, 10)
})

test('without the Drive permission: Google\'s consent first (drive only), then the Picker', async () => {
  const server = fakeServer('act')
  const pick = picking(server)
  pick.withoutDrive()
  const r = await pick.p.pick('co', 'folder')
  assert.equal(r.ok, true)
  assert.deepEqual(pick.connects, [['drive']])
  // Declined: nothing is picked and the Picker never opens.
  const declined = picking(fakeServer('act'), { sleep: async () => {}, consentWaitMs: 0 })
  declined.withoutDrive()
  const no = await declined.p.pick('co', 'folder')
  assert.equal(no.ok, false)
  assert.deepEqual(declined.opened, [])
})

test('drive_read: outside text; a picked PDF saved under .personal/google-drive/', async () => {
  const root = companyFolder()
  const text = await (await tools('read', root)).t.execute('drive_read', { fileId: DOC })
  assert.ok(text.startsWith('【外から】\n対象：営業部\n【ここまで】'))
  const pdf = JSON.parse(await (await tools('read', root, { pdf: true })).t.execute('drive_read', { fileId: DOC }))
  assert.match(pdf.savedPdf, /^\.personal\/google-drive\/fake-doc-past-pr-手書き_メモ\.pdf$/)
  assert.ok(fs.readFileSync(path.join(root, pdf.savedPdf)).equals(PDF))
})

test('drive_put: only a PDF / HTML inside the company folder, never a private or left-out folder', async () => {
  const root = companyFolder()
  const { t, seen } = await tools('act', root)
  const put = async (p: string) => JSON.parse(await t.execute('drive_put', { path: p, folderId: FOLDER }))
  const refusals: Record<string, string> = {
    '../outside.pdf': '会社フォルダの中',
    '/etc/hosts': '会社フォルダの中',
    '営業部/link.pdf': 'リンク',
    '営業部/秘密の案件/提案.pdf': '限られた人だけ',
    '人事/評価.pdf': '限られた人だけ',
    '営業部/置いていない/x.pdf': 'ダウンロードしていない',
    '営業部/偽物.pdf': 'PDF ではない',
    '営業部/メモ.docx': 'PDF と HTML',
    '.git/config': '置けません',
  }
  for (const [p, words] of Object.entries(refusals)) {
    const r = await put(p)
    assert.ok(typeof r.error === 'string' && r.error.includes(words), `${p}: ${JSON.stringify(r)}`)
    assert.ok(!r.error.includes('秘密の案件') && !r.error.includes('人事'), `${p}: names the folder`)
  }
  assert.equal(seen.filter(s => s.url.endsWith('/google/drive/put')).length, 0)
  const ok = await put('営業部/ご提案.pdf')
  assert.equal(ok.state, 'done')
  assert.equal(ok.link, 'https://drive.google.com/file/d/fake-upload-1/view')
  const html = await put('営業部/.personal/ご提案.html')
  assert.equal(html.state, 'done')
  const sent = seen.filter(s => s.url.endsWith('/google/drive/put')).map(s => JSON.parse(s.body!))
  assert.equal(sent[0].kind, 'pdf')
  assert.equal(sent[0].name, 'ご提案.pdf')
  assert.equal(Buffer.from(sent[0].contentBase64, 'base64').equals(PDF), true)
  assert.equal(sent[0].requestKey, drivePutRequestKey(FOLDER, 'ご提案.pdf', sent[0].sha256))
  assert.equal(sent[1].kind, 'html')
  // The record token, never the session.
  for (const s of seen.filter(x => x.url.includes('/records-ai/'))) assert.equal(s.headers.Cookie, undefined)
})

test('drive_put names the consultation\'s やること (the app\'s topic, read at each put) so the server links the file; never one the AI chose', async () => {
  const root = companyFolder()
  let topic: string | null = 'task-0123456789abcdef'
  const { t, seen } = await tools('act', root, { topicTask: () => topic })
  const sent = () => seen.filter(s => s.url.endsWith('/google/drive/put')).map(s => JSON.parse(s.body!))
  await t.execute('drive_put', { path: '営業部/ご提案.pdf', folderId: FOLDER })
  assert.equal(sent()[0].recordId, 'task-0123456789abcdef')
  // The topic taken off (or none): nothing named, the put as before.
  topic = null
  await t.execute('drive_put', { path: '営業部/ご提案.pdf', folderId: FOLDER })
  assert.equal('recordId' in sent()[1], false)
  // The AI cannot name a record itself.
  const forged = JSON.parse(await t.execute('drive_put', { path: '営業部/ご提案.pdf', folderId: FOLDER, recordId: 'task-ffffffffffffffff' }))
  assert.ok(typeof forged.error === 'string')
  assert.equal(sent().length, 2)
})

test('drive_put: Markdown always as a Google document; HTML when asked; a PDF never converted; updateFileId passed on; its words say when a file is new', async () => {
  const root = companyFolder()
  const { t, seen } = await tools('act', root)
  const sent = () => seen.filter(s => s.url.endsWith('/google/drive/put')).map(s => JSON.parse(s.body!))
  await t.execute('drive_put', { path: '営業部/.personal/面談報告書.md', folderId: FOLDER })
  assert.deepEqual([sent()[0].kind, sent()[0].as, sent()[0].name], ['markdown', 'google_doc', '面談報告書'])
  assert.equal(sent()[0].requestKey, drivePutRequestKey(FOLDER, '面談報告書', sent()[0].sha256, { as: 'google_doc' }))
  await t.execute('drive_put', { path: '営業部/.personal/ご提案.html', folderId: FOLDER, as: 'google_doc' })
  assert.deepEqual([sent()[1].kind, sent()[1].as, sent()[1].name], ['html', 'google_doc', 'ご提案'])
  const pdfDoc = JSON.parse(await t.execute('drive_put', { path: '営業部/ご提案.pdf', folderId: FOLDER, as: 'google_doc' }))
  assert.ok(typeof pdfDoc.error === 'string')
  assert.equal(sent().length, 2)
  // Overwriting: the fileId goes as updateFileId, and the key is another one than a new file's.
  const upd = JSON.parse(await t.execute('drive_put', { path: '営業部/.personal/面談報告書.md', folderId: FOLDER, updateFileId: 'fake-upload-1' }))
  assert.equal(sent()[2].updateFileId, 'fake-upload-1')
  assert.notEqual(sent()[2].requestKey, sent()[0].requestKey)
  assert.equal(upd.state, 'done')
  assert.equal(JSON.parse(await t.execute('drive_put', { path: '営業部/ご提案.pdf', folderId: FOLDER, updateFileId: '../x' })).error, '入力が正しくありません。')
  // The description is honest about when a new file is made (the 11/10 incident) and how to update one.
  const d = t.specs.find(s => s.name === 'drive_put')!.description
  assert.match(d, /updateFileId を渡さないと、いつも新しいファイルを作る/)
  assert.match(d, /without it a NEW file is always made/)
  assert.doesNotMatch(d, /cannot be overwritten/)
  // drive_picked lists what may be updated.
  const picked = JSON.parse(await t.execute('drive_picked', {}))
  assert.deepEqual(picked.putFiles.map((f: { fileId: string }) => f.fileId), ['fake-upload-1'])
})

test('a scheduled job\'s run: drive_put reads only from its own deliverable area, by name and by real location', async () => {
  const root = companyFolder()
  const area = path.join(root, '営業部', '.personal', 'reports')
  fs.mkdirSync(area, { recursive: true })
  fs.writeFileSync(path.join(area, '報告.md'), '# 報告\n')
  fs.symlinkSync(path.join(root, '営業部', 'ご提案.pdf'), path.join(area, 'link.pdf'))
  const { t, seen } = await tools('act', root, { onlyUnder: '営業部/.personal/reports' })
  const put = async (p: string) => JSON.parse(await t.execute('drive_put', { path: p, folderId: FOLDER }))
  for (const p of ['営業部/ご提案.pdf', '人事/評価.pdf', '営業部/.personal/ご提案.html', '営業部/.personal/reports', '営業部/.personal/reports/link.pdf']) {
    const r = await put(p)
    assert.ok(typeof r.error === 'string', `${p}: ${JSON.stringify(r)}`)
  }
  assert.match((await put('営業部/ご提案.pdf')).error, /この仕事の保存場所/)
  assert.equal(seen.filter(s => s.url.endsWith('/google/drive/put')).length, 0)
  assert.equal((await put('営業部/.personal/reports/報告.md')).state, 'done')
  // No area at all (a job that saves nothing): nothing may be put.
  const none = await tools('act', root, { onlyUnder: null })
  assert.ok(typeof JSON.parse(await none.t.execute('drive_put', { path: '営業部/.personal/reports/報告.md', folderId: FOLDER })).error === 'string')
})

test('the tool providers give a job run\'s consultation its area (main\'s held run), and nothing else that limit', async () => {
  const root = companyFolder()
  const area = path.join(root, '営業部', '.personal', 'reports')
  fs.mkdirSync(area, { recursive: true })
  fs.writeFileSync(path.join(area, '報告.md'), '# 報告\n')
  const server = fakeServer('act')
  const api = createRecordsApi({ baseUrl: () => 'https://acb.example.jp', cookies: () => [SESSION], fetch: server.fetch })
  const access = await api.openTurn('co', { conversationId: 'conv-job', agent: 'claude-code', scope: 'act' })
  const roots = new AllowedRoots()
  roots.add(root)
  const pick = picking(server)
  const make = (conversationId: string) => createRecordTools(access!, undefined, {
    companyId: 'co', conversationId,
    toolProviders: recordToolProviders({
      drivePicking: pick.p, paths: roots, privateFolders: { readable: () => [] },
      jobWriteArea: c => (c === 'conv-job' ? { place: '営業部', folder: 'reports', reads: [] } : null),
    }, { companyId: 'co', companyRoot: root, conversationId }),
  })
  const job = (await make('conv-job'))!
  assert.match(JSON.parse(await job.execute('drive_put', { path: '営業部/ご提案.pdf', folderId: FOLDER })).error, /この仕事の保存場所/)
  assert.equal(JSON.parse(await job.execute('drive_put', { path: '営業部/.personal/reports/報告.md', folderId: FOLDER })).state, 'done')
  // Any other consultation: the company folder as before.
  const plain = (await make('conv-other'))!
  assert.equal(JSON.parse(await plain.execute('drive_put', { path: '営業部/ご提案.pdf', folderId: FOLDER })).state, 'done')
  // A run-bound token whose job area is not known: nothing at all (never the whole company folder).
  const bound = (await createRecordTools(access!, undefined, {
    companyId: 'co', conversationId: 'conv-bound',
    toolProviders: recordToolProviders({ drivePicking: pick.p, paths: roots, privateFolders: { readable: () => [] }, jobWriteArea: () => null, runBound: () => true }, { companyId: 'co', companyRoot: root, conversationId: 'conv-bound' }),
  }))!
  assert.match(JSON.parse(await bound.execute('drive_put', { path: '営業部/.personal/reports/報告.md', folderId: FOLDER })).error, /この仕事の保存場所/)
})

test('an update names the revision it replaces: a later update of the same content is another request', async () => {
  const root = companyFolder()
  const a = await tools('act', root, { revision: 'version:1' })
  await a.t.execute('drive_put', { path: '営業部/.personal/面談報告書.md', folderId: FOLDER, updateFileId: 'fake-upload-1' })
  const b = await tools('act', root, { revision: 'version:2' })
  await b.t.execute('drive_put', { path: '営業部/.personal/面談報告書.md', folderId: FOLDER, updateFileId: 'fake-upload-1' })
  const key = (s: typeof a.seen) => JSON.parse(s.filter(x => x.url.endsWith('/google/drive/put'))[0].body!).requestKey
  assert.notEqual(key(a.seen), key(b.seen))
  // A file the status does not list as one the member's puts made: not sent at all.
  const unknown = JSON.parse(await a.t.execute('drive_put', { path: '営業部/.personal/面談報告書.md', folderId: FOLDER, updateFileId: 'fake-upload-unknown-1' }))
  assert.match(unknown.error, /putFiles/)
  // A document that would fetch from outside: refused here already.
  fs.writeFileSync(path.join(root, '営業部', '.personal', '外.md'), '![x](https://evil.example/x.png)\n')
  assert.match(JSON.parse(await a.t.execute('drive_put', { path: '営業部/.personal/外.md', folderId: FOLDER })).error, /外を読み込むかもしれない部分/)
})

test('the same file, folder and name → the same request key; anything else → another', () => {
  const a = drivePutRequestKey(FOLDER, 'ご提案.pdf', 'a'.repeat(64))
  // A plain new file keeps the key it always had (a repeat across an update of the app is still the same put).
  assert.equal(a, drivePutRequestKey(FOLDER, 'ご提案.pdf', 'a'.repeat(64), { as: 'file' }))
  assert.notEqual(a, drivePutRequestKey(FOLDER, 'ご提案.pdf', 'a'.repeat(64), { as: 'google_doc' }))
  assert.notEqual(a, drivePutRequestKey(FOLDER, 'ご提案.pdf', 'a'.repeat(64), { updateFileId: 'fake-upload-1' }))
  assert.equal(a, drivePutRequestKey(FOLDER, 'ご提案.pdf'.normalize('NFD'), 'a'.repeat(64)))
  assert.notEqual(a, drivePutRequestKey(FOLDER, 'ご提案.pdf', 'b'.repeat(64)))
  assert.notEqual(a, drivePutRequestKey('fake-folder-other-0001', 'ご提案.pdf', 'a'.repeat(64)))
  assert.notEqual(a, drivePutRequestKey(FOLDER, 'ご提案2.pdf', 'a'.repeat(64)))
})

test('a local file check on its own: a missing file, a folder', () => {
  const root = companyFolder()
  const roots = new AllowedRoots()
  roots.add(root)
  const deps = { pathGuard: roots, notDownloaded: () => [], privateFolders: () => undefined }
  assert.ok('error' in readLocalFileForDrive('営業部/無い.pdf', root, deps))
  assert.ok('error' in readLocalFileForDrive('営業部', root, deps))
  const ok = readLocalFileForDrive(path.join(root, '営業部', 'ご提案.pdf'), root, deps)
  assert.ok('bytes' in ok && ok.kind === 'pdf' && ok.name === 'ご提案.pdf')
})
