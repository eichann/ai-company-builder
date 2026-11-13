/**
 * Continuing a Google document people edited, the app's side (`.claude/rules/google-drive.md` "Continuing a document
 * people edited", owner decision 2026-11-14).
 *
 * Guards (each mutation-checked, see the PR):
 * - when the server answers DRIVE_OVERWRITE_NEEDS_CONFIRMATION, drive_put puts the app's own card in the reply (the
 *   server's confirmation id, the names Google gave) and tells the AI to wait — never that it was written, never to make
 *   a new file; without a card path the AI is told the app must be updated;
 * - a written update that had comments tells the AI comments may have moved;
 * - the card is stored with the message and comes back from the history; a malformed one is dropped;
 * - the press goes to the server with the member's session; the card's words for a refusal are the app's own, by code
 *   (the server's text never reaches the screen).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { UIMessage } from 'ai'
import { AllowedRoots } from '../electron/allowed-roots'
import { createRecordsApi } from '../electron/records/api'
import { createRecordTools } from '../electron/records/tools'
import { createDriveTools } from '../electron/features/google/drive'
import { createGoogleApi } from '../electron/features/google/ipc'
import { DRIVE_OVERWRITE_PART_TYPE, DRIVE_OVERWRITE_WORDS, driveOverwriteOutcome, readDriveOverwriteCard, type DriveOverwriteCard } from '../shared/drive-overwrite'
import { sessionMessageToUIMessage, uiMessageToSessionMessage } from '../src/features/chat/chatSessionMessages'

const TOKEN = 'acb_rec_co.' + 'a'.repeat(64)
const SESSION = 'better-auth.session_token=SECRET.sig'
const FOLDER = 'fake-folder-proposals-0001'
const FILE = 'fake-upload-0000001'
const CONFIRMATION = { id: 'drive-confirm-abc123', fileName: '面談報告書', editors: ['田中 誠'], commented: true, expiresAt: '2026-11-15T00:00:00.000Z' }

type PutAnswer = { status: number; body: unknown }

async function driveTools(put: PutAnswer, onCard?: (card: DriveOverwriteCard) => void) {
  const fetch = (async (url: string) => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    if (url.endsWith('/me/record-tokens')) return json(201, { success: true, data: { token: TOKEN, tokenId: 'tok-1', scope: 'act', expiresAt: 'x' } })
    if (url.endsWith('/api/records-ai/types')) return json(200, { success: true, data: { types: [] } })
    if (url.endsWith('/api/records-ai/plugins')) return json(200, { success: true, data: { plugins: [] } })
    if (url.split('?')[0].endsWith('/api/records-ai/google/drive/status')) {
      return json(200, { success: true, data: { available: true, granted: true, picks: [], puts: [{ fileId: FILE, name: '面談報告書', mimeType: 'application/vnd.google-apps.document', folderId: FOLDER, link: 'l', revisionId: 'version:3', at: 't' }] } })
    }
    if (url.endsWith('/api/records-ai/google/drive/put')) return json(put.status, put.body)
    return json(404, {})
  }) as unknown as typeof globalThis.fetch
  const api = createRecordsApi({ baseUrl: () => 'https://acb.example.jp', cookies: () => [SESSION], fetch })
  const access = await api.openTurn('co', { conversationId: 'conv-1', agent: 'claude-code', scope: 'act' })
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-drive-continue-')))
  fs.mkdirSync(path.join(root, '営業部'), { recursive: true })
  fs.writeFileSync(path.join(root, '営業部', '面談報告書.md'), '# 面談報告書（直しを取り込んだ）\n')
  const roots = new AllowedRoots()
  roots.add(root)
  const t = await createRecordTools(access!, undefined, {
    companyId: 'co', conversationId: 'conv-1',
    toolProviders: [a => createDriveTools(a, {
      picking: { pick: async () => ({ ok: false, reason: 'cancelled', message: 'x' }) }, companyId: 'co', companyRoot: root,
      local: { pathGuard: roots, notDownloaded: () => [], privateFolders: () => [] }, onOverwriteCard: onCard, newId: () => 'card-1', now: () => new Date('2026-11-14T00:00:00.000Z'),
    })],
  })
  return (input: Record<string, unknown>) => t!.execute('drive_put', { path: '営業部/面談報告書.md', folderId: FOLDER, updateFileId: FILE, ...input })
}

const NEEDS = { status: 409, body: { error: '…確認待ちです。', code: 'DRIVE_OVERWRITE_NEEDS_CONFIRMATION', confirmation: CONFIRMATION } }

test('someone else edited the document: the app\'s card goes in the reply and the AI is told to wait — never that it was written, never a new file', async () => {
  const cards: DriveOverwriteCard[] = []
  const put = await driveTools(NEEDS, c => cards.push(c))
  const out = JSON.parse(await put({}))
  assert.deepEqual(cards, [{ id: 'card-1', companyId: 'co', confirmationId: CONFIRMATION.id, fileName: '面談報告書', editors: ['田中 誠'], commented: true, expiresAt: CONFIRMATION.expiresAt, at: '2026-11-14T00:00:00.000Z' }])
  assert.equal(out.state, 'waiting-for-member')
  // The names go to the card only: people choose them in Google, so they never reach the AI's text.
  assert.match(out.instruction, /ほかの人の直し・コメント/)
  assert.ok(!JSON.stringify(out).includes('田中'))
  assert.match(out.instruction, /新しいファイルを作ったりしないでください/)
  assert.ok(!('link' in out) && !('fileId' in out))
  // No card path (an embedding without the chat's cards): the AI hears the member must update the app; nothing claimed.
  const bare = JSON.parse(await (await driveTools(NEEDS))({}))
  assert.equal(bare.code, 'DRIVE_OVERWRITE_NEEDS_CONFIRMATION')
  assert.match(bare.error, /アプリを新しく/)
  // A confirmation of the wrong shape is no card.
  const odd: DriveOverwriteCard[] = []
  const forged = await driveTools({ status: 409, body: { ...NEEDS.body, confirmation: { ...CONFIRMATION, id: '../x' } } }, c => odd.push(c))
  assert.equal(JSON.parse(await forged({})).code, 'DRIVE_OVERWRITE_NEEDS_CONFIRMATION')
  assert.deepEqual(odd, [])
})

test('a written update of a document with comments tells the AI comments may have moved; a refusal to read first is passed on', async () => {
  const done = { existing: false, continued: 'own', commentsMayMove: true, drivePut: { id: 'drive-put-1', state: 'done', name: '面談報告書', mimeType: 'application/vnd.google-apps.document', bytes: 1, sha256: 'x', folderId: FOLDER, folderName: '提案書', fileId: FILE, revisionId: 'version:4', link: 'l', createdAt: 't', finishedAt: 't', reason: null, skills: null, updatedFileId: FILE } }
  const out = JSON.parse(await (await driveTools({ status: 200, body: { success: true, data: done } }))({}))
  assert.equal(out.state, 'done')
  assert.equal(out.continued, 'own')
  assert.match(out.commentsWarning, /コメントが元の場所から外れている/)
  const plain = JSON.parse(await (await driveTools({ status: 200, body: { success: true, data: { ...done, commentsMayMove: undefined, continued: undefined } } }))({}))
  assert.ok(!('commentsWarning' in plain) && !('continued' in plain))
  const read = JSON.parse(await (await driveTools({ status: 409, body: { error: 'drive_read で今の中身を読み…', code: 'DRIVE_FILE_CHANGED_SINCE', needsRead: true } }))({}))
  assert.deepEqual(read, { error: 'drive_read で今の中身を読み…', code: 'DRIVE_FILE_CHANGED_SINCE' })
})

test('drive_put\'s words: a document people changed is read and updated in place, not copied; drive_read reads a file the member linked', async () => {
  const api = createRecordsApi({ baseUrl: () => 'https://acb.example.jp', cookies: () => [SESSION], fetch: (async (url: string) => new Response(JSON.stringify(url.endsWith('/me/record-tokens')
    ? { success: true, data: { token: TOKEN, tokenId: 't', scope: 'act', expiresAt: 'x' } }
    : { success: true, data: { available: true, granted: true, picks: [], puts: [] } }), { status: url.endsWith('/me/record-tokens') ? 201 : 200 })) as unknown as typeof fetch })
  const access = await api.openTurn('co', { conversationId: 'c', agent: 'claude-code', scope: 'act' })
  const t = await createDriveTools(access!, { picking: { pick: async () => ({ ok: false, reason: 'cancelled', message: 'x' }) }, companyId: 'co', companyRoot: null, local: { pathGuard: new AllowedRoots(), notDownloaded: () => [], privateFolders: () => [] } })
  const d = (name: string) => t!.specs.find(s => s.name === name)!.description
  assert.match(d('drive_put'), /新しいファイルを作らずに、drive_read で今の中身を読み/)
  assert.match(d('drive_put'), /do not make a new file: read it with drive_read/)
  assert.match(d('drive_read'), /やることにつないだ Drive のファイル/)
})

test('the card is kept with the message and comes back from the history; a malformed one is dropped', () => {
  const card = { id: 'card-1', companyId: 'co', confirmationId: 'drive-confirm-abc123', fileName: '面談報告書', editors: ['田中 誠'], commented: false, expiresAt: 'e', at: 'a' }
  const msg = { id: 'm1', role: 'assistant', parts: [{ type: 'text', text: '確かめてください' }, { type: DRIVE_OVERWRITE_PART_TYPE, id: 'drive-overwrite-card-1', data: card }, { type: DRIVE_OVERWRITE_PART_TYPE, data: { ...card, id: 'card-2', confirmationId: 'approval-x' } }] } as unknown as UIMessage
  const stored = uiMessageToSessionMessage(msg, new Date('2026-11-14T00:00:00.000Z'))
  assert.deepEqual(stored.driveOverwrites, [card])
  const back = sessionMessageToUIMessage(stored).parts.filter(p => p.type === DRIVE_OVERWRITE_PART_TYPE) as Array<{ data: unknown }>
  assert.deepEqual(back.map(p => p.data), [card])
  assert.equal(readDriveOverwriteCard({ ...card, editors: 'x' })?.editors.length, 0)
  assert.equal(readDriveOverwriteCard({ ...card, companyId: '' }), undefined)
})

test('the press: the member\'s session to the server; the card\'s words come from the code', async () => {
  const seen: Array<{ url: string; method: string; cookie: string; body: string }> = []
  let answer: { status: number; body: unknown } = { status: 200, body: { success: true, data: { state: 'written', drivePut: { link: 'https://docs.google.com/document/d/x/edit' }, commentsMayMove: true } } }
  const api = createGoogleApi({
    baseUrl: () => 'https://acb.example.jp', cookies: () => [SESSION], shell: { openExternal: async () => {} }, log: { warn: () => {} },
    fetch: (async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method ?? 'GET', cookie: (init.headers as Record<string, string>).Cookie, body: String(init.body) })
      return new Response(JSON.stringify(answer.body), { status: answer.status })
    }) as unknown as typeof fetch,
  })
  const written = await api.decideDriveOverwrite('co', 'drive-confirm-abc123', 'confirm')
  assert.deepEqual(written, { success: true, state: 'written', link: 'https://docs.google.com/document/d/x/edit', commentsMayMove: true })
  assert.deepEqual(seen[0], { url: 'https://acb.example.jp/api/companies/co/me/google/drive/overwrite-confirmations/drive-confirm-abc123', method: 'POST', cookie: SESSION, body: '{"action":"confirm"}' })
  assert.equal(driveOverwriteOutcome(written).text, `${DRIVE_OVERWRITE_WORDS.written}${DRIVE_OVERWRITE_WORDS.comments}`)
  // Written in Drive but not linked to the やること: the card says so (never only a server log line).
  answer = { status: 200, body: { success: true, data: { state: 'written', drivePut: { link: null }, notLinked: { recordId: 'r', code: 'FORBIDDEN' } } } }
  const unlinked = await api.decideDriveOverwrite('co', 'drive-confirm-abc123', 'confirm')
  assert.ok(unlinked.success && unlinked.state === 'written' && unlinked.notLinked === true)
  assert.match(driveOverwriteOutcome(unlinked).text, /つなげませんでした/)
  answer = { status: 409, body: { error: 'サーバーの文<script>', code: 'DRIVE_READ_AGAIN' } }
  const again = await api.decideDriveOverwrite('co', 'drive-confirm-abc123', 'confirm')
  assert.equal(again.success, false)
  assert.ok(!again.success && /AI にもう一度読み直して/.test(again.error) && !again.error.includes('script'))
  assert.equal(driveOverwriteOutcome(again).kind, 'error')
  answer = { status: 200, body: { success: true, data: { state: 'unknown', drivePut: { state: 'unknown' } } } }
  const unknown = await api.decideDriveOverwrite('co', 'drive-confirm-abc123', 'confirm')
  assert.deepEqual(unknown, { success: true, state: 'unknown' })
  assert.equal(driveOverwriteOutcome(unknown).text, DRIVE_OVERWRITE_WORDS.unknown)
  answer = { status: 200, body: { success: true, data: { state: 'declined' } } }
  assert.equal(driveOverwriteOutcome(await api.decideDriveOverwrite('co', 'drive-confirm-abc123', 'decline')).kind, 'declined')
  assert.equal(driveOverwriteOutcome(null).text, DRIVE_OVERWRITE_WORDS.offline)
})
