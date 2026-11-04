import { describe, expect, it } from 'vitest'
import type { MailListQuery, MailRead, MailSummary } from '../../src/ports/mail'
import { googleMailInboxSource, INBOX_POLL_MAX, mailSummaryOf } from '../../src/services/google-mail'
import { threadPointerOf } from '../../src/services/threads'

function summary(k: number, over: Partial<MailSummary> = {}): MailSummary {
  return {
    id: `g${k}`, threadId: `t${k}`, from: { email: 'tanaka@client.example', name: '田中' },
    to: [{ email: 'alice@acme.example', name: '' }], cc: [], subject: `件名 ${k}`,
    receivedAt: `2026-11-04T03:0${k}:00.000Z`, messageIdHeader: `<m${k}@client.example>`, inReplyTo: null,
    bulk: false, automated: false, ...over,
  }
}

/** Gmail's list as pages, newest first (the Inbox label; the Sent label's own pages); records every query it was asked. */
function reader(pages: MailSummary[][] | 'fail', sentPages: MailSummary[][] | 'fail' = []) {
  const asked: MailListQuery[] = []
  return {
    asked,
    async listMessages(_co: string, _u: string, query: MailListQuery): Promise<MailRead<{ messages: MailSummary[]; nextPageToken: string | null }>> {
      asked.push(query)
      const list = query.label === 'sent' ? sentPages : pages
      if (list === 'fail') return { ok: false, reason: 'turned-off' }
      const i = query.pageToken ? Number(query.pageToken.slice(1)) : 0
      return { ok: true, value: { messages: list[i] ?? [], nextPageToken: i + 1 < list.length ? `p${i + 1}` : null } }
    },
  }
}

describe('Gmail as the inbox source', () => {
  it('every page, oldest first, as pointers and header facts; what came before the window is left out', async () => {
    const r = reader([[summary(3, { inReplyTo: '<m1@acme.example>' }), summary(2)], [summary(1, { messageIdHeader: null }), summary(0, { receivedAt: '2026-11-04T02:59:59.000Z' })]])
    const got = await googleMailInboxSource(r, () => 0).listSince('a', 'u', '2026-11-04T03:00:00.000Z')
    expect(r.asked[0].afterMs).toBe(Date.parse('2026-11-04T03:00:00.000Z'))
    expect(got).toEqual([
      expect.objectContaining({ messageId: 'gmail:g1', sourceRef: 'gmail:g1', threadRef: 'gmail:t1', references: [] }),
      expect.objectContaining({ messageId: '<m2@client.example>' }),
      {
        channel: 'email', messageId: '<m3@client.example>', references: ['<m1@acme.example>'], threadRef: 'gmail:t3', sourceRef: 'gmail:g3',
        occurredAt: '2026-11-04T03:03:00.000Z', subject: '件名 3', from: { address: 'tanaka@client.example', name: '田中' }, senderAddress: null,
        to: [{ address: 'alice@acme.example', name: null }], cc: [], outgoing: false, bulk: false, automated: false,
      },
    ])
    // The pointers are the ones the card's 元のスレッド reads (threads.ts).
    const [one] = got as Array<{ threadRef: string; sourceRef: string }>
    expect(threadPointerOf({ thread_ref: one.threadRef })).toEqual({ kind: 'mail', threadId: 't1', messageId: null })
    expect(threadPointerOf({ source_ref: one.sourceRef })).toEqual({ kind: 'mail', threadId: null, messageId: 'g1' })
  })

  it('the Sender header is carried (an invitation "via Google Calendar"), asked for in the metadata read', async () => {
    const got = await googleMailInboxSource(reader([[summary(1, { sender: { email: 'calendar-notification@google.com', name: 'Google Calendar' } })]]), () => 0)
      .listSince('a', 'u', '2026-11-04T03:00:00.000Z')
    expect(got).toEqual([expect.objectContaining({ from: { address: 'tanaka@client.example', name: '田中' }, senderAddress: 'calendar-notification@google.com' })])
    const parsed = mailSummaryOf({ id: 'g1', threadId: 't1', payload: { headers: [{ name: 'From', value: 'Tanaka <tanaka@client.example>' }, { name: 'Sender', value: 'Google Calendar <calendar-notification@google.com>' }] } })
    expect(parsed?.sender).toEqual({ email: 'calendar-notification@google.com', name: 'Google Calendar' })
  })

  it('a failed read is not-connected (the poll keeps its window), and so is not ready', async () => {
    const source = googleMailInboxSource(reader('fail'), () => 0)
    expect(await source.listSince('a', 'u', '2026-11-04T03:00:00.000Z')).toBe('not-connected')
    expect(await source.ready!('a', 'u')).toBe(false)
    expect(await googleMailInboxSource(reader([[]]), () => 0).ready!('a', 'u')).toBe(true)
  })

  it('one poll stops at its limit: the newest are kept and it says where they start', async () => {
    const pages = Array.from({ length: INBOX_POLL_MAX / 50 + 5 }, (_, p) => Array.from({ length: 50 }, (_, k) => {
      const n = p * 50 + k
      return summary(0, { id: `g${n}`, receivedAt: new Date(Date.parse('2026-11-10T00:00:00.000Z') - n * 1000).toISOString() })
    }))
    const got = await googleMailInboxSource(reader(pages), () => 0).listSince('a', 'u', '2026-11-01T00:00:00.000Z')
    if (Array.isArray(got) || got === 'not-connected') throw new Error('expected a cut answer')
    expect(got.messages).toHaveLength(INBOX_POLL_MAX)
    expect(got.readFrom).toBe(new Date(Date.parse('2026-11-10T00:00:00.000Z') - (INBOX_POLL_MAX - 1) * 1000).toISOString())
    expect(await googleMailInboxSource(reader([[summary(1)]]), () => 0).listSince('a', 'u', '2026-11-04T03:00:00.000Z')).toHaveLength(1)
  })

  it('the member\'s Sent mail (a reply from the phone) comes as outgoing, with References and In-Reply-To; once even when in both labels', async () => {
    const reply = summary(5, {
      id: 'g5', from: { email: 'alice@acme.example', name: 'Alice' }, to: [{ email: 'tanaka@client.example', name: '' }],
      messageIdHeader: '<r5@acme.example>', inReplyTo: '<m1@client.example>', references: ['<m0@client.example>', '<m1@client.example>'],
    })
    const toSelf = summary(4, { id: 'g4', from: { email: 'alice@acme.example', name: '' } })
    const got = await googleMailInboxSource(reader([[toSelf, summary(2)]], [[reply, toSelf]]), () => 0).listSince('a', 'u', '2026-11-04T03:00:00.000Z')
    if (!Array.isArray(got)) throw new Error('expected a list')
    expect(got.map(m => [m.messageId, m.outgoing])).toEqual([['<m2@client.example>', false], ['<m4@client.example>', true], ['<r5@acme.example>', true]])
    expect(got.at(-1)).toMatchObject({ references: ['<m0@client.example>', '<m1@client.example>'], sourceRef: 'gmail:g5', from: { address: 'alice@acme.example' } })
    // A failing Sent list is a failed read: the window stays.
    expect(await googleMailInboxSource(reader([[summary(1)]], 'fail'), () => 0).listSince('a', 'u', '2026-11-04T03:00:00.000Z')).toBe('not-connected')
    // References is a header fact the metadata read asks for.
    expect(mailSummaryOf({ id: 'g9', threadId: 't9', payload: { headers: [{ name: 'References', value: '<a@x.example> <b@x.example>' }] } })?.references).toEqual(['<a@x.example>', '<b@x.example>'])
  })

  it('one cap for both lists: the newest are kept across Inbox and Sent, and a cut list says where it stops', async () => {
    const at = (n: number) => new Date(Date.parse('2026-11-10T00:00:00.000Z') - n * 1000).toISOString()
    const inboxPages = Array.from({ length: INBOX_POLL_MAX / 50 }, (_, p) => Array.from({ length: 50 }, (_, k) => summary(0, { id: `i${p * 50 + k}`, receivedAt: at(2 * (p * 50 + k)) })))
    const sentPages = [Array.from({ length: 10 }, (_, k) => summary(0, { id: `s${k}`, receivedAt: at(2 * k + 1), from: { email: 'alice@acme.example', name: '' } }))]
    const got = await googleMailInboxSource(reader(inboxPages, sentPages), () => 0).listSince('a', 'u', '2026-11-01T00:00:00.000Z')
    if (Array.isArray(got) || got === 'not-connected') throw new Error('expected a cut answer')
    expect(got.messages).toHaveLength(INBOX_POLL_MAX)
    expect(got.messages.filter(m => (m as { outgoing: boolean }).outgoing)).toHaveLength(10)
    expect(Date.parse(got.readFrom)).toBeGreaterThan(Date.parse(at(2 * INBOX_POLL_MAX)))
  })
})
