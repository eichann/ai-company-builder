import { describe, expect, it } from 'vitest'
import type { MailListQuery, MailRead, MailSummary } from '../../src/ports/mail'
import { googleMailInboxSource, INBOX_POLL_MAX } from '../../src/services/google-mail'
import { threadPointerOf } from '../../src/services/threads'

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
    // The pointers are the ones the card's 元のスレッド reads (threads.ts).
    const [one] = got as Array<{ threadRef: string; sourceRef: string }>
    expect(threadPointerOf({ thread_ref: one.threadRef })).toEqual({ kind: 'mail', threadId: 't1', messageId: null })
    expect(threadPointerOf({ source_ref: one.sourceRef })).toEqual({ kind: 'mail', threadId: null, messageId: 'g1' })
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
})
