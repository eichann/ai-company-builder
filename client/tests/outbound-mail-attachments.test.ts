/**
 * PDFs attached to a mail draft in the app (`.claude/rules/outbound-mail.md` "Attachments").
 *
 * Guards:
 * - main reads a file the AI names only inside the consultation's company folder: `..`, an absolute
 *   path elsewhere and a link pointing out are refused; `.personal/` (where a Skill writes) is fine;
 * - only PDFs (the name and the first bytes), at most 10 MB;
 * - a file that cannot be attached stops the tool before anything reaches the server; the files go
 *   up with the turn's record token (never the session), and the draft is still not sent;
 * - mail_draft_update's list is the draft's list: files no longer named are taken off;
 * - the card's send names the files shown (their sha256 only; anything else never leaves main);
 * - 「開いて確かめる」 opens exactly the bytes asked for (other bytes from the server are not opened),
 *   fetched with the session.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readMailAttachment } from '../electron/records/mail-attachments'
import { createRecordsApi } from '../electron/records/api'
import { createRecordTools } from '../electron/records/tools'
import { createOutboundMailApi } from '../electron/features/outbound-mail/ipc'
import { readMailDraft } from '../shared/outbound-mail'
import type { OutboundMailView } from '../../shared/types/outbound-mail'
import type { TypeDefinition } from '../../shared/core/record-types'

const TOKEN = 'acb_rec_co.' + 'a'.repeat(64)
const SESSION = 'better-auth.session_token=SECRET.sig'
const HASH = `sha256:${'b'.repeat(64)}`
const REF = `r${'1'.repeat(24)}`
const MAIL = 'outbound_message-0123456789abcdef'
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const pdf = (text = 'x') => Buffer.from(`%PDF-1.7\n${text}\n%%EOF\n`)

function company() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-mail-files-test-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-mail-outside-'))
  const write = (rel: string, bytes: Uint8Array) => {
    const abs = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, bytes)
    return abs
  }
  return { root, outside, write, done: () => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }) } }
}

test('a file is read only inside the company folder; .personal is fine; only a PDF of at most 10 MB', () => {
  const c = company()
  try {
    const proposal = pdf('proposal')
    c.write('営業部/.personal/提案書/2026-11-06_A社/提案書（A社様）.pdf', proposal)
    const ok = readMailAttachment('営業部/.personal/提案書/2026-11-06_A社/提案書（A社様）.pdf', c.root)
    assert.ok(!('error' in ok))
    assert.equal(ok.name, '提案書（A社様）.pdf')
    assert.equal(ok.sha256, sha(proposal))
    assert.deepEqual(Buffer.from(ok.bytes), proposal)

    fs.writeFileSync(path.join(c.outside, 'secret.pdf'), pdf('secret'))
    for (const bad of ['../secret.pdf', `${c.outside}/secret.pdf`, '~/secret.pdf', '', 'a\0.pdf']) {
      assert.ok('error' in readMailAttachment(bad, c.root), bad)
    }
    // A link inside the folder pointing out of it is not followed out (a folder link too).
    fs.symlinkSync(path.join(c.outside, 'secret.pdf'), path.join(c.root, 'link.pdf'))
    fs.symlinkSync(c.outside, path.join(c.root, '営業部', 'outside'))
    assert.match((readMailAttachment('link.pdf', c.root) as { error: string }).error, /外を指す/)
    assert.match((readMailAttachment('営業部/outside/secret.pdf', c.root) as { error: string }).error, /外を指す/)

    c.write('営業部/notes.txt', pdf('a text file'))
    assert.match((readMailAttachment('営業部/notes.txt', c.root) as { error: string }).error, /PDF/)
    c.write('営業部/fake.pdf', Buffer.from('MZ not a pdf'))
    assert.match((readMailAttachment('営業部/fake.pdf', c.root) as { error: string }).error, /PDF/)
    c.write('営業部/big.pdf', Buffer.concat([pdf(), Buffer.alloc(10 * 1024 * 1024)]))
    assert.match((readMailAttachment('営業部/big.pdf', c.root) as { error: string }).error, /10 MB/)
    assert.ok('error' in readMailAttachment('営業部/missing.pdf', c.root))
    assert.ok('error' in readMailAttachment('営業部', c.root))
  } finally {
    c.done()
  }
})

const draft = (over: Partial<OutboundMailView> = {}): OutboundMailView => ({
  id: MAIL, state: 'draft', version: 1, hash: HASH, channel: 'email', interactionId: null, from: 'sato@div.example',
  to: [{ ref: REF, email: 'suzuki@a-corp.example', name: '鈴木', source: 'hubspot', firstTime: false }], cc: [],
  subject: '提案書のご送付', body: '本文', bodyDeleted: false, linkCount: 0, meetingId: null, bundleId: 'deal-0123456789', sentAt: null,
  providerMessageId: null, lastChangedBy: 'ai', updatedAt: 't', attachments: [], ...over,
})

interface Seen { url: string; method: string; headers: Record<string, string>; body?: string }

/** A server holding one draft: attaching / taking off a file makes a new version. */
function fakeServer() {
  const seen: Seen[] = []
  let current = draft()
  const fetch = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET'
    seen.push({ url, method, headers: init.headers as Record<string, string>, body: init.body as string | undefined })
    const json = (status: number, data: unknown) => new Response(JSON.stringify({ success: true, data }), { status })
    if (url.endsWith('/me/record-tokens')) return json(201, { token: TOKEN, tokenId: 'tok-1', scope: 'act', expiresAt: 'x' })
    if (url.endsWith('/api/records-ai/types')) return json(200, { types: [{ definition: { name: 'outbound_message', storage: 'server', actions: {}, fields: {} } as unknown as TypeDefinition }] })
    if (url.endsWith('/api/records-ai/plugins')) return json(200, { plugins: [] })
    if (url.endsWith('/api/records-ai/outbound')) return json(201, { draft: current })
    if (url.endsWith(`/outbound/${MAIL}/attachments`) && method === 'POST') {
      const body = JSON.parse(String(init.body)) as { expectedVersion: number; name: string; contentBase64: string }
      const bytes = Buffer.from(body.contentBase64, 'base64')
      current = { ...current, version: current.version + 1, attachments: [...(current.attachments ?? []), { name: body.name, size: bytes.byteLength, sha256: sha(bytes), bytesDeleted: false }] }
      return json(200, { draft: current })
    }
    const del = /\/outbound\/[^/]+\/attachments\/([0-9a-f]{64})\?expectedVersion=\d+$/.exec(url)
    if (del && method === 'DELETE') {
      current = { ...current, version: current.version + 1, attachments: (current.attachments ?? []).filter(a => a.sha256 !== del[1]) }
      return json(200, { draft: current })
    }
    if (url.endsWith(`/api/records-ai/outbound/${MAIL}`)) return json(200, { draft: current })
    return json(200, { ok: true })
  }) as unknown as typeof globalThis.fetch
  return { api: createRecordsApi({ baseUrl: () => 'https://acb.example.jp', cookies: () => [SESSION], fetch }), seen, now: () => current }
}

async function turnWith(root: string | null) {
  const server = fakeServer()
  const cards: unknown[] = []
  const access = await server.api.openTurn('co', { conversationId: 'conv-1', agent: 'claude-code', scope: 'act' })
  const tools = await createRecordTools(access!, undefined, {
    companyId: 'co', conversationId: 'conv-1', onMailDraft: c => cards.push(c), newId: () => 'card-1',
    ...(root ? { readMailAttachment: (p: string) => readMailAttachment(p, root) } : {}),
  })
  return { tools: tools!, cards, seen: server.seen, current: server.now }
}

test('the AI attaches PDFs: checked first (nothing made when one cannot be), uploaded with the record token, the draft not sent', async () => {
  const c = company()
  try {
    const proposal = pdf('proposal')
    c.write('営業部/.personal/提案書/提案書.pdf', proposal)
    c.write('営業部/memo.txt', Buffer.from('memo'))
    const { tools, cards, seen, current } = await turnWith(c.root)
    const create = { bundleId: 'deal-0123456789', toRefs: [REF], subject: '提案書のご送付', body: '本文' }
    const refused = JSON.parse(await tools.execute('mail_draft_create', { ...create, attachments: [{ path: '営業部/.personal/提案書/提案書.pdf' }, { path: '../outside.pdf' }] }))
    assert.match(refused.error, /会社フォルダの中/)
    assert.equal(seen.filter(s => s.url.includes('/outbound')).length, 0)
    assert.match(JSON.parse(await tools.execute('mail_draft_create', { ...create, attachments: [{ path: '営業部/memo.txt' }] })).error, /PDF/)
    assert.equal(seen.filter(s => s.url.includes('/outbound')).length, 0)

    const told = JSON.parse(await tools.execute('mail_draft_create', { ...create, attachments: [{ path: '営業部/.personal/提案書/提案書.pdf' }] }))
    const upload = seen.find(s => s.url.endsWith('/attachments'))!
    assert.equal(upload.headers.Authorization, `Bearer ${TOKEN}`)
    assert.equal(upload.headers.Cookie, undefined)
    assert.deepEqual(JSON.parse(upload.body!), { expectedVersion: 1, name: '提案書.pdf', contentBase64: proposal.toString('base64') })
    assert.equal(seen.some(s => /\/send$/.test(s.url)), false)
    assert.match(told.instruction, /NOT sent/)
    assert.deepEqual(told.attachments, [{ name: '提案書.pdf', size: proposal.byteLength }])
    assert.equal(JSON.stringify(told).includes('.personal'), false)
    assert.equal(cards.length, 1)
    assert.deepEqual(current().attachments?.map(a => a.sha256), [sha(proposal)])

    // An update's list is the draft's list: [] takes every file off (and changes nothing else).
    const cleared = JSON.parse(await tools.execute('mail_draft_update', { id: MAIL, expectedVersion: 2, attachments: [] }))
    assert.deepEqual(cleared.attachments, [])
    assert.equal(seen.filter(s => s.method === 'PUT').length, 0)
    assert.equal(seen.filter(s => s.method === 'DELETE').length, 1)
    // A stale version: nothing taken off or added.
    const stale = JSON.parse(await tools.execute('mail_draft_update', { id: MAIL, expectedVersion: 1, attachments: [{ path: '営業部/.personal/提案書/提案書.pdf' }] }))
    assert.equal(stale.code, 'VERSION_CONFLICT')
    assert.equal(seen.filter(s => s.url.endsWith('/attachments')).length, 1)
  } finally {
    c.done()
  }
})

test('without a company folder no file can be attached (nothing made)', async () => {
  const { tools, seen } = await turnWith(null)
  const r = JSON.parse(await tools.execute('mail_draft_create', { bundleId: 'deal-0123456789', toRefs: [REF], subject: 's', body: 'b', attachments: [{ path: 'a.pdf' }] }))
  assert.match(r.error, /会社フォルダがない/)
  assert.equal(seen.filter(s => s.url.includes('/outbound')).length, 0)
})

test('the card\'s send names the files shown (sha256 only); anything else never leaves main', async () => {
  const seen: Seen[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body as string | undefined })
    return new Response(JSON.stringify({ success: true, data: { outcome: 'sent', draft: draft({ state: 'sent' }) } }), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  const api = createOutboundMailApi({ baseUrl: () => 'https://acb.example.jp', cookies: () => [SESSION], fetch, log: { warn: () => {} } })
  const file = 'c'.repeat(64)
  await api.send('co', MAIL, HASH, null, [file])
  assert.deepEqual(JSON.parse(seen[0].body!), { hash: HASH, attachmentsShown: [file] })
  for (const bad of [['../x'], [file, file, file, file], 'all', [{ sha256: file }]] as unknown[]) {
    assert.equal((await api.send('co', MAIL, HASH, null, bad as string[])).success, false)
  }
  assert.equal(seen.length, 1)
  await api.removeAttachment('co', MAIL, file, 3)
  assert.deepEqual([seen[1].method, seen[1].url], ['DELETE', `https://acb.example.jp/api/companies/co/outbound/${MAIL}/attachments/${file}?expectedVersion=3`])
  assert.equal(seen[1].headers.Cookie, SESSION)
  assert.equal((await api.removeAttachment('co', MAIL, '../x', 3)).success, false)
  assert.equal(seen.length, 2)
  // A stored card keeps the files as listed; a malformed list draws none.
  assert.deepEqual(readMailDraft({ ...draft(), attachments: [{ name: 'a.pdf', size: 3, sha256: file, bytesDeleted: false }] })?.attachments, [{ name: 'a.pdf', size: 3, sha256: file, bytesDeleted: false }])
  assert.deepEqual(readMailDraft({ ...draft(), attachments: [{ name: '../a.pdf', size: 3, sha256: file }] })?.attachments, [])
})

test('「開いて確かめる」: the bytes asked for, fetched with the session, saved apart and opened; other bytes are not opened', async () => {
  const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-mail-open-test-'))
  try {
    const bytes = pdf('the proposal')
    let answer = bytes
    const seen: Seen[] = []
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string> })
      return new Response(answer, { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="file.pdf"; filename*=UTF-8''${encodeURIComponent('../提案書.pdf')}` } })
    }) as unknown as typeof globalThis.fetch
    const opened: string[] = []
    const api = createOutboundMailApi({
      baseUrl: () => 'https://acb.example.jp', cookies: () => [SESSION], fetch, log: { warn: () => {} },
      shell: { openPath: async p => { opened.push(p); return '' } }, filesDir: () => filesDir,
    })
    assert.deepEqual(await api.openAttachment('co', MAIL, sha(bytes)), { success: true })
    assert.equal(seen[0].url, `https://acb.example.jp/api/companies/co/outbound/${MAIL}/attachments/${sha(bytes)}`)
    assert.equal(seen[0].headers.Cookie, SESSION)
    assert.equal(opened.length, 1)
    assert.equal(path.basename(opened[0]), '提案書.pdf')
    assert.equal(path.relative(filesDir, opened[0]).startsWith('..'), false)
    assert.deepEqual(fs.readFileSync(opened[0]), bytes)
    // The server handing other bytes (or not a PDF): nothing is opened.
    answer = pdf('something else')
    assert.equal((await api.openAttachment('co', MAIL, sha(bytes))).success, false)
    assert.equal((await api.openAttachment('co', MAIL, 'not-a-hash')).success, false)
    assert.equal(opened.length, 1)
  } finally {
    fs.rmSync(filesDir, { recursive: true, force: true })
  }
})
