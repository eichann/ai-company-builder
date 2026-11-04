import { describe, expect, it } from 'vitest'
import type { MailListQuery, MailRead, MailSummary } from '../../src/ports/mail'
import { googleMailInboxSource, INBOX_POLL_MAX } from '../../src/services/google-mail'

function summary(k: number, over: Partial<MailSummary> = {}): MailSummary {
  return {
    id: `g${k}`, threadId: `t${k}`, from: { email: 'tanaka@client.example', name: '田中' },
    to: [{ email: 'alice@acme.example', name: '' }], cc: [], subject: `件名 ${k}`,
    receivedAt: `2026-11-04T03:0${k}:00.000Z`, messageIdHeader: `<m${k}@client.example>`, inReplyTo: null,
    bulk: false, automated: false, ...over,
  }
}

/** Gmail's list as pages, newest first; records every query it was asked. */
function reader(pages: MailSummary[][] | 'fail') {
  const asked: MailListQuery[] = []
  return {
    asked,
    async listMessages(_co: string, _u: string, query: MailListQuery): Promise<MailRead<{ messages: MailSummary[]; nextPageToken: string | null }>> {
      asked.push(query)
      if (pages === 'fail') return { ok: false, reason: 'turned-off' }
      const i = query.pageToken ? Number(query.pageToken.slice(1)) : 0
      return { ok: true, value: { messages: pages[i] ?? [], nextPageToken: i + 1 < pages.length ? `p${i + 1}` : null } }
    },
  }
}

describe('Gmail as the inbox source', () => {
  it('every page, oldest first, as pointers and header facts; what came before the window is left out', async () => {
    const r = reader([[summary(3, { inReplyTo: '<m1@acme.example>' }), summary(2)], [summary(1, { messageIdHeader: null }), summary(0, { receivedAt: '2026-11-04T02:59:59.000Z' })]])
    const got = await googleMailInboxSource(r, () => 0).listSince('a', 'u', '2026-11-04T03:00:00.000Z')
    expect(r.asked.map(q => q.pageToken ?? null)).toEqual([null, 'p1'])
    expect(r.asked[0].afterMs).toBe(Date.parse('2026-11-04T03:00:00.000Z'))
    expect(got).toEqual([
      expect.objectContaining({ messageId: 'gmail:g1', sourceRef: 'gmail:g1', threadRef: 'gmail:t1', references: [] }),
      expect.objectContaining({ messageId: '<m2@client.example>' }),
      {
        channel: 'email', messageId: '<m3@client.example>', references: ['<m1@acme.example>'], threadRef: 'gmail:t3', sourceRef: 'gmail:g3',
        occurredAt: '2026-11-04T03:03:00.000Z', subject: '件名 3', from: { address: 'tanaka@client.example', name: '田中' },
        to: [{ address: 'alice@acme.example', name: null }], cc: [], outgoing: false, bulk: false, automated: false,
      },
    ])
  })

  it('a failed read is not-connected (the poll keeps its window), and so is not ready', async () => {
    const source = googleMailInboxSource(reader('fail'), () => 0)
    expect(await source.listSince('a', 'u', '2026-11-04T03:00:00.000Z')).toBe('not-connected')
    expect(await source.ready!('a', 'u')).toBe(false)
    expect(await googleMailInboxSource(reader([[]]), () => 0).ready!('a', 'u')).toBe(true)
  })

  it('one poll stops at its limit and says so (no content in the log)', async () => {
    const page = Array.from({ length: 50 }, (_, k) => summary(1, { id: `g${k}` }))
    const logs: string[] = []
    const r = reader(Array.from({ length: INBOX_POLL_MAX / 50 + 5 }, () => page))
    const got = await googleMailInboxSource(r, () => 0, m => logs.push(m)).listSince('a', 'u', '2026-11-04T03:00:00.000Z')
    expect(got).toHaveLength(INBOX_POLL_MAX)
    expect(logs).toEqual([`[inbox] gmail poll of company a stopped at ${INBOX_POLL_MAX} messages`])
  })
})
