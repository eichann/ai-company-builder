/**
 * Asking before a put into a place others see, the app's side (`.claude/rules/google-drive.md` "Asking before a put",
 * owner decisions 2026-11-14).
 *
 * Guards (each mutation-checked, see the PR):
 * - drive_put says it can ask (`askAudience`) in a consultation with the card; on DRIVE_PUT_NEEDS_CONFIRMATION the app's
 *   own card goes in the reply (a new file: 置く; the domains on the card only, never in the AI's text) and the AI waits;
 * - a private folder's file is sent (`privateSource`) only to a server that checks it, and only where the card can ask;
 *   otherwise it is refused here and nothing is sent;
 * - the card: 「このフォルダはもう聞かない」 only where offered (never for a link for anyone or a private folder's file),
 *   and the press sends `trust` only with 「置く」;
 * - 設定 → Google: the trusted folders are read and taken away with the session.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AllowedRoots } from '../electron/allowed-roots'
import { createRecordsApi } from '../electron/records/api'
import { createRecordTools } from '../electron/records/tools'
import { createDriveTools } from '../electron/features/google/drive'
import { createGoogleApi } from '../electron/features/google/ipc'
import { DRIVE_PUT_ASK_WORDS, driveAudienceLines, driveOverwriteOutcome, readDriveOverwriteCard, type DriveOverwriteCard } from '../shared/drive-overwrite'

const TOKEN = 'acb_rec_co.' + 'a'.repeat(64)
const SESSION = 'better-auth.session_token=SECRET.sig'
const FOLDER = 'fake-folder-shared-outside-0001'
const ASK = {
  id: 'drive-confirm-put0001', fileName: '見積.pdf', editors: [], commented: false, expiresAt: '2026-11-15T00:00:00.000Z', update: false, edited: false,
  audience: { anyone: false, outsideDomains: ['a-corp.example'], insideOthers: 0, privateSource: false, trustOffered: true },
}

async function setup(opts: { put: { status: number; body: unknown }; privateSourceChecked?: boolean; onCard?: ((card: DriveOverwriteCard) => void) | null; onlyUnder?: string }) {
  const sent: Array<Record<string, unknown>> = []
  const fetch = (async (url: string, init?: RequestInit) => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    if (url.endsWith('/me/record-tokens')) return json(201, { success: true, data: { token: TOKEN, tokenId: 'tok-1', scope: 'act', expiresAt: 'x' } })
    if (url.endsWith('/api/records-ai/types')) return json(200, { success: true, data: { types: [] } })
    if (url.endsWith('/api/records-ai/plugins')) return json(200, { success: true, data: { plugins: [] } })
    if (url.split('?')[0].endsWith('/api/records-ai/google/drive/status')) {
      return json(200, { success: true, data: { available: true, granted: true, picks: [], puts: [], ...(opts.privateSourceChecked ? { privateSourceChecked: true } : {}) } })
    }
    if (url.endsWith('/api/records-ai/google/drive/put')) { sent.push(JSON.parse(String(init?.body))); return json(opts.put.status, opts.put.body) }
    return json(404, {})
  }) as unknown as typeof globalThis.fetch
  const api = createRecordsApi({ baseUrl: () => 'https://acb.example.jp', cookies: () => [SESSION], fetch })
  const access = await api.openTurn('co', { conversationId: 'conv-1', agent: 'claude-code', scope: 'act' })
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-drive-audience-')))
  fs.mkdirSync(path.join(root, '営業部', '非公開の案件'), { recursive: true })
  fs.mkdirSync(path.join(root, '.personal', 'job'), { recursive: true })
  fs.writeFileSync(path.join(root, '営業部', '見積.pdf'), '%PDF-1.7\n% quote\n%%EOF\n')
  fs.writeFileSync(path.join(root, '営業部', '非公開の案件', '報告.pdf'), '%PDF-1.7\n% private\n%%EOF\n')
  const roots = new AllowedRoots()
  roots.add(root)
  const t = await createRecordTools(access!, undefined, {
    companyId: 'co', conversationId: 'conv-1',
    toolProviders: [a => createDriveTools(a, {
      picking: { pick: async () => ({ ok: false, reason: 'cancelled', message: 'x' }) }, companyId: 'co', companyRoot: root,
      local: { pathGuard: roots, notDownloaded: () => [], privateFolders: () => ['営業部/非公開の案件'], ...(opts.onlyUnder !== undefined ? { onlyUnder: opts.onlyUnder } : {}) },
      ...(opts.onCard !== null ? { onOverwriteCard: opts.onCard ?? (() => {}) } : {}), newId: () => 'card-1', now: () => new Date('2026-11-14T00:00:00.000Z'),
    })],
  })
  const put = async (p: string) => JSON.parse(await t!.execute('drive_put', { path: p, folderId: FOLDER }))
  return { put, sent, root }
}

const DONE = { status: 200, body: { success: true, data: { existing: false, drivePut: { id: 'drive-put-1', state: 'done', name: '見積.pdf', folderName: 'f', link: 'l', fileId: 'fake-upload-1', revisionId: 'r', mimeType: 'application/pdf', updatedFileId: null } } } }

test('a place others see: the app says it can ask; the card (置く) goes in the reply and the AI waits; the domains stay on the card', async () => {
  const cards: DriveOverwriteCard[] = []
  const { put, sent } = await setup({ put: { status: 409, body: { error: '…', code: 'DRIVE_PUT_NEEDS_CONFIRMATION', confirmation: ASK } }, onCard: c => cards.push(c) })
  const out = await put('営業部/見積.pdf')
  assert.equal(sent[0].askAudience, true)
  assert.ok(!('privateSource' in sent[0]))
  assert.equal(out.state, 'waiting-for-member')
  assert.ok(!JSON.stringify(out).includes('a-corp'))
  assert.equal(cards.length, 1)
  assert.deepEqual([cards[0].update, cards[0].edited, cards[0].audience?.outsideDomains, cards[0].audience?.trustOffered], [false, false, ['a-corp.example'], true])
  assert.equal(DRIVE_PUT_ASK_WORDS.title(cards[0]), '社外の人も見られる場所に置きます')
  assert.equal(DRIVE_PUT_ASK_WORDS.confirm(cards[0]), '置く')
  assert.deepEqual(driveAudienceLines(cards[0].audience!), ['社外の人（a-corp.example の人）も見られます。'])
  // Without the card path (no chat cards): never says it can ask.
  const bare = await setup({ put: DONE, onCard: null })
  await bare.put('営業部/見積.pdf')
  assert.ok(!('askAudience' in bare.sent[0]))
  // A scheduled job's run (its one area): never asks — nobody is there to press.
  const job = await setup({ put: DONE, onlyUnder: '.personal/job' })
  fs.writeFileSync(path.join(job.root, '.personal', 'job', '日報.pdf'), '%PDF-1.7\n% job\n%%EOF\n')
  await job.put('.personal/job/日報.pdf')
  assert.ok(!('askAudience' in job.sent[0]))
})

test('a private folder\'s file: sent (privateSource) only to a server that checks it and only where the card can ask; else refused, nothing sent', async () => {
  const ok = await setup({ put: DONE, privateSourceChecked: true })
  await ok.put('営業部/非公開の案件/報告.pdf')
  assert.deepEqual([ok.sent[0].privateSource, ok.sent[0].askAudience], [true, true])
  const older = await setup({ put: DONE })
  assert.match((await older.put('営業部/非公開の案件/報告.pdf')).error, /限られた人だけのフォルダ/)
  assert.equal(older.sent.length, 0)
  const noCard = await setup({ put: DONE, privateSourceChecked: true, onCard: null })
  assert.match((await noCard.put('営業部/非公開の案件/報告.pdf')).error, /限られた人だけのフォルダ/)
  assert.equal(noCard.sent.length, 0)
  // A plain file is never marked private.
  await ok.put('営業部/見積.pdf')
  assert.ok(!('privateSource' in ok.sent[1]))
})

test('the card: 「もう聞かない」 only where offered — never for a link for anyone or a private folder\'s file; odd domains dropped', () => {
  const base = { id: 'c', companyId: 'co', confirmationId: ASK.id, fileName: 'x.pdf', editors: [], commented: false, expiresAt: 'e', at: 'a', update: false, edited: false }
  assert.equal(readDriveOverwriteCard({ ...base, audience: ASK.audience })?.audience?.trustOffered, true)
  assert.equal(readDriveOverwriteCard({ ...base, audience: { ...ASK.audience, anyone: true } })?.audience?.trustOffered, false)
  assert.equal(readDriveOverwriteCard({ ...base, audience: { ...ASK.audience, privateSource: true } })?.audience?.trustOffered, false)
  assert.deepEqual(readDriveOverwriteCard({ ...base, audience: { ...ASK.audience, outsideDomains: ['a-corp.example', '<b>x</b>', '?'] } })?.audience?.outsideDomains, ['a-corp.example', '?'])
  const priv = readDriveOverwriteCard({ ...base, audience: { anyone: false, outsideDomains: [], insideOthers: 'domain', privateSource: true, trustOffered: false } })!
  assert.equal(DRIVE_PUT_ASK_WORDS.title(priv), '非公開フォルダの資料を、ほかの人も見られる場所に置きます')
  assert.deepEqual(driveAudienceLines(priv.audience!), ['限られた人だけのフォルダ（非公開フォルダ）の中のファイルです。', '社内の全員が見られます。'])
})

test('the press sends trust only with 置く; a new file\'s outcome says 置きました; the trusted folders go with the session', async () => {
  const seen: Array<{ url: string; method: string; cookie: string; body: string }> = []
  let answer: { status: number; body: unknown } = { status: 200, body: { success: true, data: { state: 'written', drivePut: { link: 'l' }, commentsMayMove: false, update: false } } }
  const api = createGoogleApi({
    baseUrl: () => 'https://acb.example.jp', cookies: () => [SESSION], shell: { openExternal: async () => {} }, log: { warn: () => {} },
    fetch: (async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method ?? 'GET', cookie: (init.headers as Record<string, string>).Cookie, body: String(init.body) })
      return new Response(JSON.stringify(answer.body), { status: answer.status })
    }) as unknown as typeof fetch,
  })
  const written = await api.decideDriveOverwrite('co', ASK.id, 'confirm', true)
  assert.equal(seen[0].body, '{"action":"confirm","trust":true}')
  assert.equal(driveOverwriteOutcome(written, false).text, '置きました。')
  answer = { status: 200, body: { success: true, data: { state: 'declined' } } }
  await api.decideDriveOverwrite('co', ASK.id, 'decline', true)
  assert.equal(seen[1].body, '{"action":"decline"}')
  answer = { status: 409, body: { code: 'DRIVE_SHARING_CHANGED', error: 'x' } }
  const changed = await api.decideDriveOverwrite('co', ASK.id, 'confirm')
  assert.ok(!changed.success && /見られる人が変わりました/.test(changed.error))
  answer = { status: 200, body: { success: true, data: { folders: [{ folderId: FOLDER, folderName: '共有', outsideDomains: ['a-corp.example'], createdAt: 't' }, { folderId: 1 }] } } }
  const listed = await api.driveTrustedFolders('co')
  assert.ok(listed.success && listed.folders.length === 1 && listed.folders[0].folderName === '共有')
  assert.equal(seen[3].url, 'https://acb.example.jp/api/companies/co/me/google/drive/trusted-folders')
  assert.equal(seen[3].cookie, SESSION)
  answer = { status: 404, body: { code: 'DRIVE_TRUST_NOT_FOUND' } }
  assert.deepEqual(await api.untrustDriveFolder('co', FOLDER), { success: true })
  assert.deepEqual([seen[4].method, seen[4].url], ['DELETE', `https://acb.example.jp/api/companies/co/me/google/drive/trusted-folders/${FOLDER}`])
})
