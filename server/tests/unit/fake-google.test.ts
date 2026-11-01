/**
 * The fake Google (tests/fakes/google) answers like the real one where the
 * server's connector depends on it (milestone 4 design N13 / G2): if it were
 * more lenient than Google — no PKCE check, scopes not enforced, a real-looking
 * secret accepted — the connector's tests would pass against it and fail on
 * div's Workspace.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import {
  createFakeGoogle, FAKE_ACCESS_TOKEN_PREFIX, FAKE_REFRESH_TOKEN_PREFIX, GOOGLE_SCOPES, MILESTONE4_SCOPES,
  type FakeClient, type FakeGoogle, type FakeGoogleOptions,
} from '../fakes/google/fake-google'
import { GOOGLE_SEED as S } from '../fakes/google/seed'

const REDIRECT = 'http://localhost:3001/api/oauth/google/callback'
const VERIFIER = 'v'.repeat(20) + '-verifier-0123456789abcdefghij'
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')

let fake: FakeGoogle
let client: FakeClient
afterEach(() => fake?.close())

function make(opts: FakeGoogleOptions = {}) {
  fake = createFakeGoogle(opts)
  client = fake.addClient({ redirectUris: [REDIRECT] })
  return fake
}

function authorizeUrl(params: Record<string, string | undefined> = {}) {
  const q = new URLSearchParams()
  const all: Record<string, string | undefined> = {
    client_id: client.clientId, redirect_uri: REDIRECT, response_type: 'code', scope: 'openid email ' + MILESTONE4_SCOPES.slice(2).join(' '),
    state: 'st-1', code_challenge: CHALLENGE, code_challenge_method: 'S256', access_type: 'offline', ...params,
  }
  for (const [k, v] of Object.entries(all)) if (v !== undefined) q.set(k, v)
  return `/o/oauth2/v2/auth?${q}`
}

const form = (body: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() })

async function authorize(params: Record<string, string | undefined> = {}) {
  const res = await fake.app.request(authorizeUrl(params))
  return { res, back: res.status === 302 ? new URL(res.headers.get('location')!) : null }
}

async function exchange(code: string, verifier = VERIFIER) {
  return fake.app.request('/token', form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.clientId, client_secret: client.clientSecret, code_verifier: verifier }))
}

interface Tokens { access_token: string; refresh_token?: string; scope: string; expires_in: number; token_type: string; id_token?: string }

/** The whole consent → token flow; returns the token answer. */
async function grant(params: Record<string, string | undefined> = {}): Promise<Tokens> {
  const { back } = await authorize(params)
  const res = await exchange(back!.searchParams.get('code')!)
  expect(res.status).toBe(200)
  return await res.json() as Tokens
}

const api = (path: string, token: string, init: { method?: string; body?: unknown } = {}) =>
  fake.app.request(path, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })

describe('fake Google: OAuth', () => {
  it('consent redirects back with code and state; the code + verifier give practice tokens with the long scope names and the account in userinfo', async () => {
    make()
    const { back } = await authorize()
    expect(back!.origin + back!.pathname).toBe(REDIRECT)
    expect(back!.searchParams.get('state')).toBe('st-1')
    expect(back!.searchParams.get('hd')).toBe(S.internalDomain)
    const t = await grant()
    expect(t.access_token.startsWith(FAKE_ACCESS_TOKEN_PREFIX)).toBe(true)
    expect(t.refresh_token!.startsWith(FAKE_REFRESH_TOKEN_PREFIX)).toBe(true)
    expect(t).toMatchObject({ expires_in: 3599, token_type: 'Bearer', id_token: expect.any(String) })
    // `email` is granted (and reported) as userinfo.email.
    expect(t.scope.split(' ')).toEqual(expect.arrayContaining([GOOGLE_SCOPES.email, GOOGLE_SCOPES.gmailSend]))
    expect(await (await api('/oauth2/v3/userinfo', t.access_token)).json()).toMatchObject({ email: S.member, email_verified: true, hd: S.internalDomain })

    // Without access_type=offline there is no refresh token.
    expect((await grant({ access_type: undefined })).refresh_token).toBeUndefined()
  })

  it('PKCE: a wrong or missing verifier is invalid_grant, and a code works once', async () => {
    make()
    const code = (await authorize()).back!.searchParams.get('code')!
    const wrong = await exchange(code, 'w'.repeat(43))
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toEqual({ error: 'invalid_grant', error_description: 'Invalid code verifier.' })
    expect((await exchange(code)).status).toBe(200)
    expect((await exchange(code)).status).toBe(400)
    // An authorization request without an S256 challenge is refused before any redirect.
    for (const p of [{ code_challenge: undefined }, { code_challenge_method: 'plain' }]) {
      const { res } = await authorize(p)
      expect(res.status).toBe(400)
    }
  })

  it('an unregistered redirect URI, a wrong client secret and a non-practice secret are refused', async () => {
    make()
    const { res } = await authorize({ redirect_uri: 'https://evil.example/cb' })
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
    const code = (await authorize()).back!.searchParams.get('code')!
    const bad = await fake.app.request('/token', form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.clientId, client_secret: 'fake-google-secret-wrong', code_verifier: VERIFIER }))
    expect(bad.status).toBe(401)
    expect(await bad.json()).toMatchObject({ error: 'invalid_client' })
    // A secret that is not a practice one cannot even be registered.
    expect(() => fake.addClient({ clientSecret: 'GOCSPX-' + 'x'.repeat(28), redirectUris: [REDIRECT] })).toThrow(/fake-google-secret-/)
  })

  it('the person declines → access_denied; another account or withheld scopes come back as chosen', async () => {
    make()
    fake.signIn({ deny: true })
    const denied = await authorize()
    expect(denied.back!.searchParams.get('error')).toBe('access_denied')
    expect(denied.back!.searchParams.get('code')).toBeNull()

    fake.signIn({ email: S.privateAccount })
    const priv = await grant()
    expect(await (await api('/oauth2/v3/userinfo', priv.access_token)).json()).toMatchObject({ email: S.privateAccount })

    fake.signIn({ email: S.member, withholdScopes: [GOOGLE_SCOPES.gmailSend] })
    const partial = await grant()
    expect(partial.scope.split(' ')).not.toContain(GOOGLE_SCOPES.gmailSend)
  })

  it('revoked access: refresh is invalid_grant and the access token 401; /revoke ends the grant', async () => {
    make()
    const t = await grant()
    const refresh = () => fake.app.request('/token', form({ grant_type: 'refresh_token', refresh_token: t.refresh_token!, client_id: client.clientId, client_secret: client.clientSecret }))
    const ok = await refresh()
    expect(ok.status).toBe(200)
    expect(await ok.json()).not.toHaveProperty('refresh_token')

    fake.revokeAllFor(S.member)
    const r = await refresh()
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
    expect((await api('/oauth2/v3/userinfo', t.access_token)).status).toBe(401)

    const t2 = await grant()
    expect((await fake.app.request('/revoke', form({ token: t2.access_token }))).status).toBe(200)
    expect((await api('/oauth2/v3/userinfo', t2.access_token)).status).toBe(401)
    expect(fake.refreshTokenCount(client.clientId, S.member)).toBe(0)
  })

  it('past the refresh-token limit the oldest stops working; an expired access token is 401', async () => {
    let now = 1_800_000_000_000
    make({ refreshTokenLimit: 2, now: () => now })
    const first = await grant()
    await grant()
    await grant()
    expect(fake.refreshTokenCount(client.clientId, S.member)).toBe(2)
    const r = await fake.app.request('/token', form({ grant_type: 'refresh_token', refresh_token: first.refresh_token!, client_id: client.clientId, client_secret: client.clientSecret }))
    expect(r.status).toBe(400)
    const t = await grant()
    now += 3600_000
    expect((await api('/oauth2/v3/userinfo', t.access_token)).status).toBe(401)
  })
})

describe('fake Google: APIs', () => {
  it('a call needing a scope that was not granted is 403 PERMISSION_DENIED; a non-fake bearer is 401', async () => {
    make()
    const t = await grant({ scope: 'openid email' })
    const res = await api(`/calendar/v3/calendars/primary/events`, t.access_token)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: { code: 403, status: 'PERMISSION_DENIED', errors: [{ reason: 'insufficientPermissions' }] } })
    expect((await api('/calendar/v3/calendars/primary/events', 'ya29.a0-real-looking')).status).toBe(401)
  })

  it('calendar: events in a window, by start time, with attendees, organizer, self and the Meet code; an outside change is seen', async () => {
    make()
    const t = await grant()
    const q = new URLSearchParams({ timeMin: '2026-11-05T00:00:00+09:00', timeMax: '2026-11-06T00:00:00+09:00', singleEvents: 'true', orderBy: 'startTime' })
    const res = await api(`/calendar/v3/calendars/primary/events?${q}`, t.access_token)
    expect(res.status).toBe(200)
    const body = await res.json() as { kind: string; items: { id: string; summary: string; start: { dateTime: string }; organizer: { email: string; self?: boolean }; attendees: { email: string; self?: boolean; organizer?: boolean; displayName?: string }[]; conferenceData: { conferenceId: string; entryPoints: { uri: string }[] }; hangoutLink: string; updated: string }[] }
    expect(body.kind).toBe('calendar#events')
    expect(body.items.map(e => e.id)).toEqual([S.internalEvent, S.salesEvent])
    const sales = body.items[1]
    expect(sales.organizer).toEqual({ email: S.member, self: true })
    expect(sales.attendees).toEqual(expect.arrayContaining([
      { email: S.member, organizer: true, self: true, responseStatus: 'accepted' },
      { email: S.customerSuzuki, displayName: '鈴木 一郎', responseStatus: 'accepted' },
    ]))
    expect(sales.conferenceData.conferenceId).toBe(S.salesMeetingCode)
    expect(sales.hangoutLink).toBe(`https://meet.google.com/${S.salesMeetingCode}`)

    // orderBy=startTime needs singleEvents=true, as in Calendar.
    expect((await api('/calendar/v3/calendars/primary/events?orderBy=startTime', t.access_token)).status).toBe(400)

    fake.changeEvent(S.salesEvent, { removeAttendee: S.customerYamaguchi })
    const again = await (await api(`/calendar/v3/calendars/primary/events/${S.salesEvent}`, t.access_token)).json() as typeof sales
    expect(again.attendees.map(a => a.email)).not.toContain(S.customerYamaguchi)
    expect(Date.parse(again.updated)).toBeGreaterThan(Date.parse(sales.updated))
  })

  it('Meet: the record found by meeting code, its smart notes and transcript in docsDestination; nothing found is {}; another member sees only their meetings', async () => {
    make()
    const t = await grant()
    const filter = encodeURIComponent(`space.meeting_code = "${S.salesMeetingCode}"`)
    const list = await (await api(`/v2/conferenceRecords?filter=${filter}`, t.access_token)).json() as { conferenceRecords: { name: string; space: string; startTime: string; endTime: string; expireTime: string }[] }
    expect(list.conferenceRecords).toEqual([expect.objectContaining({ name: `conferenceRecords/${S.salesConference}`, space: 'spaces/fakeSpaceSales01', endTime: expect.any(String), expireTime: expect.any(String) })])
    const notes = await (await api(`/v2/conferenceRecords/${S.salesConference}/smartNotes`, t.access_token)).json()
    expect(notes).toEqual({ smartNotes: [expect.objectContaining({
      name: `conferenceRecords/${S.salesConference}/smartNotes/fake-note-sales-01`,
      state: 'FILE_GENERATED',
      docsDestination: { document: S.salesNotesDoc, exportUri: `https://docs.google.com/document/d/${S.salesNotesDoc}/view` },
    })] })
    const transcripts = await (await api(`/v2/conferenceRecords/${S.salesConference}/transcripts`, t.access_token)).json() as { transcripts: { docsDestination: { document: string } }[] }
    expect(transcripts.transcripts[0].docsDestination.document).toBe(S.salesTranscriptDoc)

    const none = await api(`/v2/conferenceRecords?filter=${encodeURIComponent('space.meeting_code = "zzz-zzzz-zzz"')}`, t.access_token)
    expect(await none.json()).toEqual({})

    // Before the file is generated there is no docsDestination.
    fake.setArtifactState(S.salesConference, 'smartNotes', 'fake-note-sales-01', 'ENDED')
    const ended = await (await api(`/v2/conferenceRecords/${S.salesConference}/smartNotes`, t.access_token)).json() as { smartNotes: Record<string, unknown>[] }
    expect(ended.smartNotes[0]).not.toHaveProperty('docsDestination')

    fake.signIn({ email: S.colleague })
    const other = await grant()
    expect((await api(`/v2/conferenceRecords/${S.salesConference}/smartNotes`, other.access_token)).status).toBe(404)
  })

  it('Drive: Meet documents export as text (BOM, CRLF) with a version that moves on edits; drive.meet.readonly cannot open a hand-made file; over 10 MB is 403', async () => {
    make({ exportLimitBytes: 2000 })
    const t = await grant()
    const res = await api(`/drive/v3/files/${S.salesNotesDoc}/export?mimeType=text/plain`, t.access_token)
    expect(res.status).toBe(200)
    // Raw bytes: Response.text() would drop the byte-order mark the consumer has to handle.
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8')
    expect(text.startsWith('﻿会議メモ\r\n')).toBe(true)
    expect(text).toContain('120万円から150万円')

    const meta = async () => (await (await api(`/drive/v3/files/${S.salesNotesDoc}?fields=id,modifiedTime,version,headRevisionId`, t.access_token)).json()) as { id: string; version: string; modifiedTime: string }
    const before = await meta()
    expect(before).toEqual({ id: S.salesNotesDoc, version: '7', modifiedTime: expect.any(String) })
    fake.changeDoc(S.salesNotesDoc)
    expect(Number((await meta()).version)).toBe(8)

    const plain = await api(`/drive/v3/files/${S.plainDoc}/export?mimeType=text/plain`, t.access_token)
    expect(plain.status).toBe(404)
    expect(await plain.json()).toMatchObject({ error: { code: 404, errors: [{ reason: 'notFound' }] } })

    fake.changeDoc(S.salesNotesDoc, 'あ'.repeat(1000))
    const big = await api(`/drive/v3/files/${S.salesNotesDoc}/export?mimeType=text/plain`, t.access_token)
    expect(big.status).toBe(403)
    expect(await big.json()).toMatchObject({ error: { code: 403, errors: [{ reason: 'exportSizeLimitExceeded' }] } })
  })

  const mail = (from: string) => Buffer.from([
    `From: 佐藤 健 <${from}>`,
    `To: ${S.customerSuzuki}, ${S.customerYamaguchi}`,
    `Subject: =?UTF-8?B?${Buffer.from('本日のお礼').toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('鈴木様\n本日はありがとうございました。').toString('base64'),
  ].join('\r\n')).toString('base64url')

  it('Gmail: a send is stored decoded and answered with SENT; a From that is not the account is refused', async () => {
    make()
    const t = await grant()
    const res = await api('/gmail/v1/users/me/messages/send', t.access_token, { method: 'POST', body: { raw: mail(S.member) } })
    expect(res.status).toBe(200)
    const { id, threadId, labelIds } = await res.json() as { id: string; threadId: string; labelIds: string[] }
    expect(labelIds).toEqual(['SENT'])
    expect(fake.sent).toEqual([expect.objectContaining({ id, threadId, account: S.member, to: [S.customerSuzuki, S.customerYamaguchi], subject: '本日のお礼', body: '鈴木様\n本日はありがとうございました。' })])

    const spoof = await api('/gmail/v1/users/me/messages/send', t.access_token, { method: 'POST', body: { raw: mail(S.colleague) } })
    expect(spoof.status).toBe(400)
    expect(fake.sent).toHaveLength(1)
  })

  it('a send whose answer never arrives is still sent; failNext answers Google\'s 500 / 429 shapes', async () => {
    make()
    const t = await grant()
    fake.faults.dropAnswerAfterSend(1)
    let answered = false
    const pending = Promise.resolve(api('/gmail/v1/users/me/messages/send', t.access_token, { method: 'POST', body: { raw: mail(S.member) } })).then(r => { answered = true; return r })
    await new Promise(r => setTimeout(r, 50))
    expect(answered).toBe(false)
    expect(fake.sent).toHaveLength(1)
    fake.close()
    await pending

    fake.faults.failNext(1, 429)
    const limited = await api('/calendar/v3/calendars/primary/events', t.access_token)
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } })
    fake.faults.failNext(1)
    const failed = await api('/gmail/v1/users/me/messages/send', t.access_token, { method: 'POST', body: { raw: mail(S.member) } })
    expect(failed.status).toBe(500)
    expect(fake.sent).toHaveLength(1)
  })
})
