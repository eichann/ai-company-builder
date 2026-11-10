/**
 * Google Drive in the consultation (`.claude/rules/google-drive.md`), the app's side.
 *
 * Guards (each mutation-checked, see the PR):
 * - the Picker's token goes to the Picker window only: it never reaches the AI's tool output,
 *   a record-token request, or a log line; picking and keeping picks use the member's session;
 * - without the Drive permission, the first pick opens Google's consent (features: drive only)
 *   and waits for it — nothing is picked before;
 * - the Drive tools exist only where the server says Drive is set up; drive_put only with an
 *   act token (Codex reads);
 * - drive_put reads a local file only inside the company folder (by real location), never in
 *   a private folder (the refusal never names it) or a folder left out on this computer; PDF /
 *   HTML only, content checked; the same file, folder and name always carry the same request key;
 * - the Picker window gives its config only to the server's Picker page and reads back only
 *   Drive ids; a picked PDF is saved under `.personal/google-drive/`;
 * - a pasted link's files reach the Picker window only as Drive ids, and only for a files pick.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AllowedRoots } from '../electron/allowed-roots'
import { createRecordsApi } from '../electron/records/api'
import { createRecordTools } from '../electron/records/tools'
import { createDrivePicking, createDriveTools, drivePutRequestKey, isDrivePickerPage, readDrivePickerResult, readLocalFileForDrive, type DrivePickingDeps } from '../electron/features/google/drive'
import type { DrivePickerWindowConfig } from '../electron/features/ports'
import type { MyGoogle } from '../shared/google'

const TOKEN = 'acb_rec_co.' + 'a'.repeat(64)
const SESSION = 'better-auth.session_token=SECRET.sig'
const PICKER_TOKEN = 'ya29.fake-PICKER-TOKEN-must-stay-in-the-window'
const FOLDER = 'fake-folder-proposals-0001'
const DOC = 'fake-doc-past-proposal-0001'
const PDF = Buffer.from('%PDF-1.7\n%%EOF\n')

interface Seen { url: string; method: string; headers: Record<string, string>; body?: string }

function fakeServer(scope: 'read' | 'act', opts: { available?: boolean; pdf?: boolean } = {}) {
  const seen: Seen[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body as string | undefined })
    const json = (status: number, data: unknown) => new Response(JSON.stringify({ success: true, data }), { status })
    if (url.endsWith('/me/record-tokens')) return json(201, { token: TOKEN, tokenId: 'tok-1', scope, expiresAt: 'x' })
    if (url.endsWith('/api/records-ai/types')) return json(200, { types: [] })
    if (url.endsWith('/api/records-ai/plugins')) return json(200, { plugins: [] })
    if (url.endsWith('/api/records-ai/google/drive/status')) return json(200, { available: opts.available ?? true, granted: true, picks: [] })
    if (url.endsWith('/api/records-ai/google/drive/read')) {
      return json(200, opts.pdf
        ? { file: { id: DOC, name: '手書き/メモ.pdf', mimeType: 'application/pdf', modifiedTime: null }, header: 'H', text: null, footer: 'F', truncated: false, pdfBase64: PDF.toString('base64'), instructionLike: [] }
        : { file: { id: DOC, name: '過去の提案書', mimeType: 'application/vnd.google-apps.document', modifiedTime: null }, header: '【外から】', text: '対象：営業部', footer: '【ここまで】', truncated: false, pdfBase64: null, instructionLike: [] })
    }
    if (url.endsWith('/api/records-ai/google/drive/put')) {
      return json(200, { existing: false, drivePut: { id: 'drive-put-1', state: 'done', name: 'x.pdf', mimeType: 'application/pdf', bytes: 1, sha256: 'x', folderId: FOLDER, folderName: '提案書', fileId: 'fake-upload-1', revisionId: 'rev-1', link: 'https://drive.google.com/file/d/fake-upload-1/view', createdAt: 't', finishedAt: 't', reason: null } })
    }
    if (url.endsWith('/me/google/drive/picker')) return json(200, { accessToken: PICKER_TOKEN, expiresAt: 't', apiKey: 'key', appId: '123456789012', scriptOrigin: 'https://apis.google.com', mode: JSON.parse(String(init.body)).mode })
    if (url.endsWith('/me/google/drive/picks')) {
      const ids = JSON.parse(String(init.body)).ids as string[]
      return json(200, { picks: ids.map(id => ({ id, kind: 'folder', name: '提案書', mimeType: 'application/vnd.google-apps.folder', pickedAt: 't', expiresAt: 't' })), refused: 0 })
    }
    return json(404, {})
  }) as unknown as typeof globalThis.fetch
  return { fetch, seen }
}

const my = (features: MyGoogle['features']): MyGoogle => ({ available: true, reason: null, connected: true, status: 'active', googleEmail: 'sato@div.example', features, domain: 'div.example', practice: false })

function picking(server: ReturnType<typeof fakeServer>, over: Partial<DrivePickingDeps> = {}) {
  const opened: Array<{ pageUrl: string; config: DrivePickerWindowConfig }> = []
  const connects: string[][] = []
  const logs: string[] = []
  let features: MyGoogle['features'] = ['minutes', 'drive']
  const deps: DrivePickingDeps = {
    baseUrl: () => 'https://acb.example.jp', cookies: () => [SESSION], fetch: server.fetch,
    window: { open: async req => { opened.push(req); return { action: 'picked', ids: [FOLDER, 'bad id!'] } } },
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

async function tools(scope: 'read' | 'act', root: string | null, opts: { available?: boolean; pdf?: boolean; topicTask?: () => string | null } = {}, pick = picking(fakeServer(scope))) {
  const server = fakeServer(scope, opts)
  const api = createRecordsApi({ baseUrl: () => 'https://acb.example.jp', cookies: () => [SESSION], fetch: server.fetch })
  const access = await api.openTurn('co', { conversationId: 'conv-1', agent: 'claude-code', scope })
  const roots = new AllowedRoots()
  if (root) roots.add(root)
  const t = await createRecordTools(access!, undefined, {
    companyId: 'co', conversationId: 'conv-1',
    toolProviders: [a => createDriveTools(a, { picking: pick.p, companyId: 'co', companyRoot: root, local: { pathGuard: roots, notDownloaded: () => ['営業部/置いていない'], privateFolders: () => ['人事'] }, topicTask: opts.topicTask })],
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

test('picking: the session asks for the token, the window alone gets it; the AI sees ids and names only', async () => {
  const pick = picking(fakeServer('act'))
  const { t, seen } = await tools('act', null, {}, pick)
  const out = await t.execute('drive_pick_folder', {})
  assert.deepEqual(JSON.parse(out).picked, [{ id: FOLDER, name: '提案書', kind: 'folder', mimeType: 'application/vnd.google-apps.folder' }])
  assert.ok(!out.includes(PICKER_TOKEN))
  assert.equal(pick.opened.length, 1)
  assert.equal(pick.opened[0].config.accessToken, PICKER_TOKEN)
  assert.equal(pick.opened[0].pageUrl, 'https://acb.example.jp/api/google-picker')
  assert.equal(pick.opened[0].config.maxItems, 1)
  // No record-token request ever carries the Picker token; the picks go back without it.
  for (const s of seen) assert.ok(!JSON.stringify(s).includes(PICKER_TOKEN))
  assert.deepEqual(pick.logs.filter(l => l.includes(PICKER_TOKEN)), [])
})

test('picking uses the member\'s session (not the record token) and keeps only Drive ids', async () => {
  const server = fakeServer('act')
  const pick = picking(server)
  const r = await pick.p.pick('co', 'files')
  assert.equal(r.ok, true)
  const calls = server.seen.filter(s => s.url.includes('/me/google/drive/'))
  assert.deepEqual(calls.map(c => c.url.replace('https://acb.example.jp/api/companies/co', '')), ['/me/google/drive/picker', '/me/google/drive/picks'])
  for (const c of calls) {
    assert.equal(c.headers.Cookie, SESSION)
    assert.equal(c.headers.Authorization, undefined)
  }
  assert.deepEqual(JSON.parse(calls[1].body!).ids, [FOLDER])
  assert.ok(!calls[1].body!.includes(PICKER_TOKEN))
})

test('a pasted link: the Picker window gets only Drive ids to show, in files mode only', async () => {
  const pick = picking(fakeServer('act'))
  await pick.p.pick('co', 'files', undefined, { fileIds: [DOC, 'bad id!', "x');alert(1)//", DOC] })
  await pick.p.pick('co', 'folder', undefined, { fileIds: [DOC] })
  await pick.p.pick('co', 'files', undefined, { fileIds: ['bad id!'] })
  await pick.p.pick('co', 'files')
  assert.deepEqual(pick.opened.map(o => o.config.fileIds), [[DOC], undefined, undefined, undefined])
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
  assert.equal(declined.opened.length, 0)
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
    '営業部/メモ.docx': 'PDF と HTML だけ',
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

test('the same file, folder and name → the same request key; anything else → another', () => {
  const a = drivePutRequestKey(FOLDER, 'ご提案.pdf', 'a'.repeat(64))
  assert.equal(a, drivePutRequestKey(FOLDER, 'ご提案.pdf'.normalize('NFD'), 'a'.repeat(64)))
  assert.notEqual(a, drivePutRequestKey(FOLDER, 'ご提案.pdf', 'b'.repeat(64)))
  assert.notEqual(a, drivePutRequestKey('fake-folder-other-0001', 'ご提案.pdf', 'a'.repeat(64)))
  assert.notEqual(a, drivePutRequestKey(FOLDER, 'ご提案2.pdf', 'a'.repeat(64)))
})

test('the Picker window: config only for the server\'s Picker page; only Drive ids come back', () => {
  const page = 'https://acb.example.jp/api/google-picker'
  assert.equal(isDrivePickerPage('https://acb.example.jp/api/google-picker', page), true)
  assert.equal(isDrivePickerPage('https://acb.example.jp/api/google-picker?x=1', page), true)
  for (const other of ['https://evil.example/api/google-picker', 'https://acb.example.jp/api/other', 'https://u:p@acb.example.jp/api/google-picker', 'http://acb.example.jp/api/google-picker', 'nonsense']) {
    assert.equal(isDrivePickerPage(other, page), false, other)
  }
  assert.deepEqual(readDrivePickerResult({ action: 'picked', ids: [FOLDER, '../x', 42, DOC] }, 1), { action: 'picked', ids: [FOLDER] })
  assert.deepEqual(readDrivePickerResult({ action: 'picked', ids: ['../x'] }, 10), { action: 'cancel' })
  assert.deepEqual(readDrivePickerResult({ action: 'error' }, 10), { action: 'error' })
  assert.deepEqual(readDrivePickerResult('picked', 10), { action: 'cancel' })
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
