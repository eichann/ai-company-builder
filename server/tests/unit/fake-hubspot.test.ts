/**
 * The fake HubSpot (tests/fakes/hubspot) answers like the real one where the
 * plugin's guards depend on it (design 節目3 §3): if the fake were more
 * lenient than HubSpot, the plugin's tests would pass against it and the
 * plugin would still fail on a real account.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { serve, type ServerType } from '@hono/node-server'
import type { AddressInfo } from 'net'
import { createFakeHubSpot, HUBSPOT_SCOPES, NOTE_TO_DEAL, PLUGIN_BASE_SCOPES, type FakeHubSpot } from '../fakes/hubspot/fake-hubspot'

const KEY = 'pat-fake-na1-test-0001'
const DEAL = '1000000001'

let fake: FakeHubSpot
afterEach(() => fake?.close())

function make(opts: Parameters<typeof createFakeHubSpot>[0] = {}, scopes?: readonly string[]) {
  fake = createFakeHubSpot(opts)
  fake.addKey(KEY, scopes)
  return fake
}

const call = (path: string, init: { method?: string; body?: unknown; key?: string | null } = {}) =>
  fake.app.request(path, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.key === null ? {} : { authorization: `Bearer ${init.key ?? KEY}` }),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })

describe('fake HubSpot: shapes of the documented API', () => {
  it('a deal has HubSpot\'s object shape and the same deal is reached by the v3 and the dated paths', async () => {
    make()
    const v3 = await call(`/crm/v3/objects/deals/${DEAL}?properties=dealname,juchu_kakudo&associations=companies`)
    const dated = await call(`/crm/objects/2026-03/deals/${DEAL}?properties=dealname,juchu_kakudo&associations=companies`)
    expect(v3.status).toBe(200)
    const a = await v3.json() as Record<string, unknown>
    expect(await dated.json()).toEqual(a)
    expect(a).toMatchObject({ id: DEAL, archived: false, properties: { dealname: expect.any(String), juchu_kakudo: 'medium', hs_object_id: DEAL } })
    expect(typeof a.createdAt).toBe('string')
    expect(typeof a.updatedAt).toBe('string')
    // Property values are strings in HubSpot, numbers included.
    const full = await (await call(`/crm/v3/objects/deals/${DEAL}`)).json() as { properties: Record<string, unknown> }
    expect(full.properties.amount).toBe('1200000')
    expect(a.associations).toEqual({ companies: { results: [{ id: '2000000001', type: 'deal_to_company' }] } })
  })

  it('search filters, pages with paging.next.after and refuses a page over 200', async () => {
    make()
    const body = { filterGroups: [{ filters: [{ propertyName: 'hubspot_owner_id', operator: 'EQ', value: '75123001' }] }], properties: ['dealname'], limit: 2 }
    const first = await call('/crm/objects/2026-09/deals/search', { method: 'POST', body })
    expect(first.status).toBe(200)
    const p1 = await first.json() as { total: number; results: { id: string }[]; paging?: { next: { after: string } } }
    expect(p1.total).toBe(4)
    expect(p1.results).toHaveLength(2)
    const p2 = await (await call('/crm/v3/objects/deals/search', { method: 'POST', body: { ...body, after: p1.paging!.next.after } })).json() as typeof p1
    expect(p2.paging).toBeUndefined()
    expect(new Set([...p1.results, ...p2.results].map(r => r.id)).size).toBe(4)

    const tooBig = await call('/crm/v3/objects/deals/search', { method: 'POST', body: { ...body, limit: 201 } })
    expect(tooBig.status).toBe(400)
  })

  it('the deal properties list carries the custom 受注確度 and which values cannot be written', async () => {
    make()
    const res = await call('/crm/properties/2026-03/deals')
    const { results } = await res.json() as { results: { name: string; options: { value: string }[]; calculated: boolean; modificationMetadata: { readOnlyValue: boolean } }[] }
    const kakudo = results.find(p => p.name === 'juchu_kakudo')!
    expect(kakudo.options.map(o => o.value)).toEqual(['high', 'medium', 'low'])
    expect(kakudo.modificationMetadata.readOnlyValue).toBe(false)
    const closedWon = results.find(p => p.name === 'hs_is_closed_won')!
    expect(closedWon.calculated).toBe(true)
    expect(closedWon.modificationMetadata.readOnlyValue).toBe(true)

    const pipelines = await (await call('/crm/pipelines/2026-03/deals')).json() as { results: { id: string; stages: { id: string; metadata: { probability: string } }[] }[] }
    expect(pipelines.results[0].stages.find(s => s.id === 'qualifiedtobuy')!.metadata.probability).toBe('0.4')
  })
})

describe('fake HubSpot: refusals the plugin must handle', () => {
  it('without a fake key every call is 401 INVALID_AUTHENTICATION, including a real-looking key', async () => {
    make()
    // A real key's shape (pat-na1-<uuid>), assembled so secret scanners do not take it for a key.
    const realShaped = ['pat', 'na1', '00000000', '0000', '0000', '0000', '000000000000'].join('-')
    for (const key of [null, realShaped, 'pat-fake-unknown']) {
      const res = await call(`/crm/v3/objects/deals/${DEAL}`, { key })
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ status: 'error', category: 'INVALID_AUTHENTICATION' })
    }
  })

  it('a key without the scope gets HubSpot\'s 403 MISSING_SCOPES naming the scope, and nothing is written', async () => {
    make({}, [HUBSPOT_SCOPES.dealsRead])
    const before = fake.deal(DEAL)!.properties.hs_next_step
    const res = await call(`/crm/v3/objects/deals/${DEAL}`, { method: 'PATCH', body: { properties: { hs_next_step: 'x' } } })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      status: 'error',
      category: 'MISSING_SCOPES',
      errors: [{ context: { requiredGranularScopes: [HUBSPOT_SCOPES.dealsWrite] } }],
    })
    expect(fake.deal(DEAL)!.properties.hs_next_step).toBe(before)
  })

  it('notes need the contacts write scope (HubSpot has no note scope): the four base scopes cannot add one', async () => {
    make({}, PLUGIN_BASE_SCOPES)
    const res = await call('/crm/objects/2026-03/notes', { method: 'POST', body: { properties: { hs_timestamp: '2026-11-01T00:00:00Z', hs_note_body: 'メモ' } } })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ errors: [{ context: { requiredGranularScopes: [HUBSPOT_SCOPES.contactsWrite] } }] })
  })

  it('writing a read-only, unknown or not-allowed value is a 400 VALIDATION_ERROR and changes nothing', async () => {
    make()
    const before = fake.deal(DEAL)!
    for (const properties of [{ hs_is_closed_won: 'true' }, { hs_lastmodifieddate: '2020-01-01T00:00:00Z' }, { no_such_property: 'x' }, { juchu_kakudo: 'S' }, { dealstage: 'nope' }]) {
      const res = await call(`/crm/v3/objects/deals/${DEAL}`, { method: 'PATCH', body: { properties: { hs_next_step: 'should not land', ...properties } } })
      expect(res.status, JSON.stringify(properties)).toBe(400)
      expect(await res.json()).toMatchObject({ status: 'error', category: 'VALIDATION_ERROR' })
    }
    expect(fake.deal(DEAL)).toEqual(before)
  })

  it('rate limits: the 101st call in 10 s and the 6th search in a second get 429 RATE_LIMIT', async () => {
    let t = 1_800_000_000_000
    make({ now: () => t, rateLimits: true })
    for (let i = 0; i < 100; i++) expect((await call(`/crm/v3/objects/deals/${DEAL}`)).status).toBe(200)
    const over = await call(`/crm/v3/objects/deals/${DEAL}`)
    expect(over.status).toBe(429)
    expect(await over.json()).toMatchObject({ status: 'error', errorType: 'RATE_LIMIT', policyName: 'TEN_SECONDLY_ROLLING' })
    t += 10_001
    expect((await call(`/crm/v3/objects/deals/${DEAL}`)).status).toBe(200)

    const search = () => call('/crm/v3/objects/deals/search', { method: 'POST', body: {} })
    for (let i = 0; i < 5; i++) expect((await search()).status).toBe(200)
    expect((await search()).status).toBe(429)
    t += 1001
    expect((await search()).status).toBe(200)
  })
})

describe('fake HubSpot: writes, notes and faults', () => {
  it('an update moves hs_lastmodifieddate forward and the stage sets the closed flags', async () => {
    const t = 1_800_000_000_000
    make({ now: () => t })
    const before = fake.deal(DEAL)!.properties.hs_lastmodifieddate!
    const res = await call(`/crm/v3/objects/deals/${DEAL}`, { method: 'PATCH', body: { properties: { juchu_kakudo: 'high', dealstage: 'closedwon' } } })
    expect(res.status).toBe(200)
    const after = fake.deal(DEAL)!.properties
    expect(Date.parse(after.hs_lastmodifieddate!)).toBeGreaterThan(Date.parse(before))
    expect(after).toMatchObject({ juchu_kakudo: 'high', hs_is_closed_won: 'true', hs_is_closed: 'true' })
    // Same clock reading: the next change still gets a newer stamp.
    fake.changeDealOutside(DEAL, { hs_next_step: 'b' })
    expect(Date.parse(fake.deal(DEAL)!.properties.hs_lastmodifieddate!)).toBeGreaterThan(Date.parse(after.hs_lastmodifieddate!))
  })

  it('a change made "in HubSpot" is what the next read sees (the plugin\'s changed-since check)', async () => {
    make()
    fake.changeDealOutside(DEAL, { juchu_kakudo: 'low' })
    const res = await call(`/crm/v3/objects/deals/${DEAL}?properties=juchu_kakudo`)
    expect((await res.json() as { properties: Record<string, string> }).properties.juchu_kakudo).toBe('low')
  })

  it('a note is created with the 214 note → deal association and DELETE puts it in the recycling bin', async () => {
    make()
    const res = await call('/crm/v3/objects/notes', {
      method: 'POST',
      body: { properties: { hs_timestamp: '2026-11-01T00:00:00Z', hs_note_body: '商談で前向き' }, associations: [{ to: { id: DEAL }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_DEAL }] }] },
    })
    expect(res.status).toBe(201)
    const { id } = await res.json() as { id: string }
    expect(fake.note(id)!.dealIds).toEqual([DEAL])
    expect((await call(`/crm/objects/2026-03/notes/${id}`, { method: 'DELETE' })).status).toBe(204)
    expect(fake.note(id)!.archived).toBe(true)
    expect((await call(`/crm/v3/objects/notes/${id}`)).status).toBe(404)

    const wrongType = await call('/crm/v3/objects/notes', {
      method: 'POST',
      body: { properties: { hs_timestamp: '2026-11-01T00:00:00Z' }, associations: [{ to: { id: DEAL }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 227 }] }] },
    })
    expect(wrongType.status).toBe(400)
  })

  it('failNext answers 500 without doing the write', async () => {
    make()
    fake.faults.failNext(1)
    const res = await call(`/crm/v3/objects/deals/${DEAL}`, { method: 'PATCH', body: { properties: { hs_next_step: 'x' } } })
    expect(res.status).toBe(500)
    expect(fake.deal(DEAL)!.properties.hs_next_step).toBe('資料送付')
    expect((await call(`/crm/v3/objects/deals/${DEAL}`, { method: 'PATCH', body: { properties: { hs_next_step: 'x' } } })).status).toBe(200)
  })

  describe('a write whose answer never arrives', () => {
    let server: ServerType | undefined
    afterEach(() => new Promise<void>(r => (server ? server.close(() => r()) : r())))

    it('over a socket: the connection is cut, yet HubSpot has the new value (「届いたか分からない」)', async () => {
      make()
      const port = await new Promise<number>(r => {
        server = serve({ fetch: fake.app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => r(info.port))
      })
      fake.faults.dropAnswerAfterWrite(1)
      const sent = fetch(`http://127.0.0.1:${port}/crm/v3/objects/deals/${DEAL}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ properties: { hs_next_step: '11/7 デモ' } }),
      })
      await expect(sent).rejects.toThrow()
      expect(fake.deal(DEAL)!.properties.hs_next_step).toBe('11/7 デモ')
    })

    it('through app.fetch: the answer stays pending while the write is applied; reads still answer', async () => {
      make()
      fake.faults.dropAnswerAfterWrite(1)
      let answered = false
      const pending = Promise.resolve(call(`/crm/v3/objects/deals/${DEAL}`, { method: 'PATCH', body: { properties: { hs_next_step: 'held' } } })).then(r => { answered = true; return r })
      await new Promise(r => setTimeout(r, 50))
      expect(answered).toBe(false)
      expect(fake.deal(DEAL)!.properties.hs_next_step).toBe('held')
      expect((await call(`/crm/v3/objects/deals/${DEAL}`)).status).toBe(200)
      fake.close()
      await pending
    })
  })
})
