/**
 * 「返事の下書きを、わたしの書き方に合わせる」 on the server (services/writing-samples.ts, google-writing.ts;
 * shared/core/writing-style.ts). What it protects:
 * - the core asks the role, never a tool: only the connector serving `mail` / `chat` in the member's company now,
 *   and only when it declares the capability `sent_samples` — another registered connector, one serving another
 *   company, or one without the capability hands nothing;
 * - nothing is read without the member's own permission (`readable` false → refused, `recentSent` never called);
 * - Gmail's reader: only the member's own words (the quoted conversation, a forwarded part, `>` lines cut off),
 *   machine mail and mail to nobody else left out, 身内 = every other address of the company's domains, at most
 *   the asked number, a refusal of the read → not allowed;
 * - the summary key for a thread: the serving connector's id and its judgement of the other side.
 */
import { describe, expect, it, vi } from 'vitest'
import { resolveRole, type RoleCandidate, type RoleServing } from '../../shared/core/connector-roles'
import { audienceOfAddresses, createGoogleSentSamples, ownWords } from '../../src/services/google-writing'
import { createWritingSamples } from '../../src/services/writing-samples'
import type { MailMessage, MailReader, MailSummary } from '../../src/ports/mail'
import type { SentSamplesReader } from '../../src/ports/sent-samples'

const member = (companyId = 'co-a', userId = 'u-sato') => ({ companyId, userId, role: 'member' })

/** A role resolver over fixed candidates per company (the real `resolveRole`). */
function rolesOf(byCompany: Record<string, RoleCandidate[]>) {
  const asked: string[] = []
  return {
    asked,
    resolve: async (companyId: string, role: 'mail' | 'chat' | 'calendar' | 'meetings', operation: string | null = null) => {
      asked.push(companyId)
      return resolveRole(role, operation, byCompany[companyId] ?? [], null)
    },
  }
}
const mailServing = (capabilities: string[] = ['sent_samples']): RoleServing => ({ role: 'mail', operations: ['read', 'send'], capabilities })

function reader(over: Partial<SentSamplesReader> = {}): SentSamplesReader & { sent: ReturnType<typeof vi.fn> } {
  const sent = vi.fn(async () => ({ ok: true as const, samples: [{ text: 'お疲れさまです。', at: null, audience: 'inside' as const }] }))
  return { readable: async () => true, recentSent: sent, audienceOf: () => 'outside', ...over, sent } as never
}

describe('the core asks the role, never a tool', () => {
  it('lists and reads only the connector serving the role in this company, with the capability', async () => {
    const roles = rolesOf({ 'co-a': [{ connectorId: 'mailco', servings: [mailServing()], usable: true }] })
    const ws = createWritingSamples({ roles, labelOf: id => `L:${id}` })
    const mail = reader()
    const other = reader()
    ws.register('mailco', mail)
    ws.register('elsewhere', other)
    const sources = await ws.sources(member())
    expect(sources.ok && sources.value.sources).toEqual([{ connectorId: 'mailco', label: 'L:mailco', readable: true }])
    const r = await ws.samples(member(), 'mailco')
    expect(r.ok && r.value.samples).toHaveLength(1)
    // Registered on the server but serving no role here: the one 404, nothing read.
    const no = await ws.samples(member(), 'elsewhere')
    expect(no.ok ? null : no.body.code).toBe('WRITING_SOURCE_NOT_FOUND')
    expect(other.sent).not.toHaveBeenCalled()
    // Asked for the member's own company only.
    expect(new Set(roles.asked)).toEqual(new Set(['co-a']))
  })

  it('a connector without the capability, or serving only another company, hands nothing', async () => {
    const roles = rolesOf({
      'co-a': [{ connectorId: 'mailco', servings: [mailServing([])], usable: true }],
      'co-b': [{ connectorId: 'mailco', servings: [mailServing()], usable: true }],
    })
    const ws = createWritingSamples({ roles, labelOf: id => id })
    const mail = reader()
    ws.register('mailco', mail)
    const sources = await ws.sources(member('co-a'))
    expect(sources.ok && sources.value.sources).toEqual([])
    const r = await ws.samples(member('co-a'), 'mailco')
    expect(r.ok ? null : r.body.code).toBe('WRITING_SOURCE_NOT_FOUND')
    expect(mail.sent).not.toHaveBeenCalled()
    expect(await ws.keyForThread(member('co-a'), 'mail', [])).toBeNull()
  })

  it('a connector switched off serves no role: nothing read', async () => {
    const ws = createWritingSamples({ roles: rolesOf({ 'co-a': [{ connectorId: 'mailco', servings: [mailServing()], usable: false }] }), labelOf: id => id })
    const mail = reader()
    ws.register('mailco', mail)
    const r = await ws.samples(member(), 'mailco')
    expect(r.ok).toBe(false)
    expect(mail.sent).not.toHaveBeenCalled()
  })

  it('without the member\'s own permission nothing is read', async () => {
    const ws = createWritingSamples({ roles: rolesOf({ 'co-a': [{ connectorId: 'mailco', servings: [mailServing()], usable: true }] }), labelOf: id => id })
    const mail = reader({ readable: async () => false })
    ws.register('mailco', mail)
    const sources = await ws.sources(member())
    expect(sources.ok && sources.value.sources[0].readable).toBe(false)
    const r = await ws.samples(member(), 'mailco')
    expect(r.ok ? null : [r.kind, r.body.code]).toEqual(['conflict', 'WRITING_SOURCE_NOT_READABLE'])
    expect(mail.sent).not.toHaveBeenCalled()
  })

  it('a thread\'s key is the serving connector and its judgement; none without one', async () => {
    const ws = createWritingSamples({ roles: rolesOf({ 'co-a': [{ connectorId: 'mailco', servings: [mailServing()], usable: true }] }), labelOf: id => id })
    ws.register('mailco', reader({ audienceOf: () => 'inside' }))
    expect(await ws.keyForThread(member(), 'mail', [])).toEqual({ connectorId: 'mailco', audience: 'inside' })
    expect(await ws.keyForThread(member(), 'chat', [])).toBeNull()
    expect(() => ws.register('mailco', reader())).toThrow()
  })
})

const summary = (id: string, to: string[], over: Partial<MailSummary> = {}): MailSummary => ({
  id, threadId: `t-${id}`, from: { email: 'sato@div.example', name: '' }, to: to.map(email => ({ email, name: '' })), cc: [],
  subject: 's', receivedAt: '2026-11-20T00:00:00Z', messageIdHeader: null, inReplyTo: null, bulk: false, automated: false, ...over,
})

function gmail(list: MailSummary[], texts: Record<string, string>, over: Partial<MailReader> = {}) {
  const get = vi.fn(async (_c: string, _u: string, id: string) => ({ ok: true as const, value: { ...list.find(m => m.id === id)!, text: texts[id] ?? '', truncated: false } as MailMessage }))
  const mail = {
    listMessages: vi.fn(async () => ({ ok: true as const, value: { messages: list, nextPageToken: null } })),
    getMessage: get, ...over,
  } as unknown as Pick<MailReader, 'listMessages' | 'getMessage'> & { getMessage: typeof get }
  return mail
}

describe('Gmail\'s reader of the member\'s own sent mail', () => {
  const deps = (mail: Pick<MailReader, 'listMessages' | 'getMessage'>, ready = true) => ({
    mail, ready: async () => ready, internalDomains: () => ['div.example'], emailOf: () => 'sato@div.example', nowMs: () => Date.parse('2026-11-28T00:00:00Z'),
  })

  it('only the member\'s own words: quoted and forwarded parts cut off', () => {
    expect(ownWords('了解です。\n明日送ります。\n\n2026年11月27日(木) 10:00 山田 <y@a.example>:\n> 資料をください')).toBe('了解です。\n明日送ります。')
    expect(ownWords('Thanks!\n\nOn Thu, Nov 27, 2026 at 10:00 AM Yamada <y@a.example> wrote:\n> please')).toBe('Thanks!')
    expect(ownWords('転送します。\n\n---------- Forwarded message ---------\nFrom: x')).toBe('転送します。')
    expect(ownWords('本文\n> 引用\nつづき')).toBe('本文\nつづき')
    expect(ownWords('本文です\n-- \n山田太郎\n03-1234-5678')).toBe('本文です')
    // Gmail folds a long 「On … wrote:」 onto two lines; the name and address go too.
    expect(ownWords('OK!\n\nOn Thu, Nov 27, 2026 at 10:00 AM Yamada Taro\n<yamada@a.example> wrote:\n> please')).toBe('OK!')
    // A line of the member's own that ends with a colon is not an attribution.
    expect(ownWords('以下の通りです：\n> 引用したい一文\n- 一つ目')).toBe('以下の通りです：\n- 一つ目')
  })

  it('身内 only when every other address is of the company\'s domains', () => {
    expect(audienceOfAddresses(['a@div.example', 'sato@div.example'], 'sato@div.example', ['div.example'])).toBe('inside')
    expect(audienceOfAddresses(['a@div.example', 'b@a-corp.example'], 'sato@div.example', ['div.example'])).toBe('outside')
    // A look-alike sub-domain is someone else.
    expect(audienceOfAddresses(['a@sub.div.example'], null, ['div.example'])).toBe('outside')
    expect(audienceOfAddresses(['sato@div.example'], 'sato@div.example', ['div.example'])).toBeNull()
  })

  it('leaves out machine mail and mail to nobody else, stops at max, and reads the Sent label only', async () => {
    const list = [
      summary('m1', ['a@div.example']),
      summary('m2', ['b@a-corp.example']),
      summary('m3', ['c@a-corp.example'], { automated: true }),
      summary('m4', ['sato@div.example']),
      summary('m5', ['d@div.example']),
    ]
    const mail = gmail(list, { m1: 'お疲れさまです。', m2: 'いつもお世話になっております。', m3: '不在のため自動で返信しています', m4: '自分あてのメモ', m5: '了解！' })
    const r = await createGoogleSentSamples(deps(mail)).recentSent('co-a', 'u-sato', 3)
    expect(r).toEqual({ ok: true, samples: [
      { text: 'お疲れさまです。', at: '2026-11-20T00:00:00Z', audience: 'inside' },
      { text: 'いつもお世話になっております。', at: '2026-11-20T00:00:00Z', audience: 'outside' },
      { text: '了解！', at: '2026-11-20T00:00:00Z', audience: 'inside' },
    ] })
    expect(mail.listMessages).toHaveBeenCalledWith('co-a', 'u-sato', expect.objectContaining({ label: 'sent' }))
    expect(mail.getMessage.mock.calls.map(c => c[2])).toEqual(['m1', 'm2', 'm5'])
    // Stops at max.
    expect((await createGoogleSentSamples(deps(gmail(list, { m1: 'お疲れさまです。', m2: 'はい' }))).recentSent('co-a', 'u-sato', 1) as { samples: unknown[] }).samples).toHaveLength(1)
  })

  it('a refused read is not allowed; readable follows the member\'s 受信を読む', async () => {
    const mail = gmail([], {}, { listMessages: vi.fn(async () => ({ ok: false as const, reason: 'turned-off' as const })) })
    const g = createGoogleSentSamples(deps(mail, false))
    expect(await g.readable('co-a', 'u-sato')).toBe(false)
    expect(await g.recentSent('co-a', 'u-sato', 20)).toEqual({ ok: false, reason: 'not-allowed' })
  })

  it('judges a thread by every address in it but the member\'s own', () => {
    const g = createGoogleSentSamples(deps(gmail([], {})))
    expect(g.audienceOf('co-a', 'u-sato', [{ mine: false, fromAddress: 'a@div.example', to: ['sato@div.example'], cc: [] }])).toBe('inside')
    expect(g.audienceOf('co-a', 'u-sato', [
      { mine: false, fromAddress: 'a@div.example', to: ['sato@div.example'], cc: ['x@a-corp.example'] },
    ])).toBe('outside')
  })
})
