/**
 * The fake portal holds a client to what a contract-3 service asks of it, so the
 * run path's tests mean something: no actor header, no answer; a search is POST;
 * `{id}` is a plain id; errors are one flat shape. And its faults arrive as a real
 * service's would. Also the practice redirect's gates for a host that cannot be
 * written in this public code: it can never take over a built-in service.
 */
import { describe, expect, it } from 'vitest'
import { practiceUpstreamsFrom } from '../../src/lib/config'
import { createFakePortal, parsePortalAliases, PORTAL_ACTOR_HEADER, PORTAL_EMAIL_HEADER, PORTAL_SCOPES } from '../fakes/portal/fake-portal'
import { PORTAL_SEED } from '../fakes/portal/seed'

const KEY = 'pat-fake-portal-test'
const world = (options: Parameters<typeof createFakePortal>[0] = {}) => {
  const fake = createFakePortal(options)
  fake.addKey(KEY)
  return fake
}
type Fake = ReturnType<typeof world>
const call = (fake: Fake, path: string, init: RequestInit & { actor?: string | null } = {}) => {
  const { actor = 'acb_member_1', ...rest } = init
  return fake.fetch(new Request(`http://fake${path}`, {
    ...rest,
    headers: { authorization: `Bearer ${KEY}`, ...(actor === null ? {} : { [PORTAL_ACTOR_HEADER]: actor }), 'content-type': 'application/json', ...(rest.headers as Record<string, string> | undefined) },
  }))
}

describe('what the fake portal asks of a client', () => {
  it('answers nothing without a key or the actor header, on reads too', async () => {
    const fake = world()
    expect((await fake.fetch(new Request('http://fake/api/account', { headers: { [PORTAL_ACTOR_HEADER]: 'system' } }))).status).toBe(401)
    const r = await call(fake, `/api/people/${PORTAL_SEED.member}/diagnosis`, { actor: null })
    expect([r.status, (await r.json()).code]).toEqual([400, 'INVALID_INPUT'])
    expect((await call(fake, '/api/account', { actor: 'system' })).status).toBe(200)
    expect((await call(fake, '/api/account', { actor: 'not:an:id' })).status).toBe(400)
    expect((await call(fake, '/api/account', { headers: { [PORTAL_EMAIL_HEADER]: 'not-an-address' } })).status).toBe(400)
  })

  it('a search is POST; a GET is refused, so personal data is never in a URL', async () => {
    const fake = world()
    const get = await call(fake, '/api/people/search?email=taro@example.com')
    expect([get.status, get.headers.get('allow')]).toEqual([405, 'POST'])
    const found = await (await call(fake, '/api/people/search', { method: 'POST', body: JSON.stringify({ email: 'TARO@example.com' }) })).json()
    expect(found.results.map((p: { person_ref: string }) => p.person_ref)).toEqual([PORTAL_SEED.member])
    expect(JSON.stringify(found)).not.toContain('taro@')
  })

  it('errors are one flat shape; an id out of shape is told apart from one that does not exist', async () => {
    const fake = world()
    const bad = await call(fake, '/api/people/not.an.id/diagnosis')
    expect([bad.status, await bad.json()]).toEqual([400, { code: 'INVALID_ID', summary: expect.any(String) }])
    expect((await call(fake, '/api/people/person-9999/diagnosis')).status).toBe(404)
  })

  it('a sensitive part needs the key\'s scope, and is null without being asked for', async () => {
    const fake = world()
    const plain = await (await call(fake, `/api/people/${PORTAL_SEED.member}/mail`)).json()
    expect(plain.mails[0].body).toBeNull()
    const refused = await call(fake, `/api/people/${PORTAL_SEED.member}/mail?include_body=1`)
    expect([refused.status, (await refused.json()).code]).toEqual([403, 'SCOPE_REQUIRED'])
    fake.addKey(KEY, Object.values(PORTAL_SCOPES))
    expect((await (await call(fake, `/api/people/${PORTAL_SEED.member}/mail?include_body=1`)).json()).mails[0].body).toContain('様')
  })
})

describe('the fake portal\'s faults', () => {
  it('a 429 says Retry-After; its own limit does too', async () => {
    const fake = world()
    fake.failNext({ status: 429, retryAfter: 7 })
    const limited = await call(fake, '/api/account')
    expect([limited.status, limited.headers.get('retry-after'), (await limited.json()).code]).toEqual([429, '7', 'RATE_LIMITED'])
    expect((await call(fake, '/api/account')).status).toBe(200)
    const counting = world({ rateLimit: 1 })
    expect((await call(counting, '/api/account')).status).toBe(200)
    expect((await call(counting, '/api/account')).status).toBe(429)
  })

  it('an undeclared field arrives in the answer, and the instruction-like name is a real seed', async () => {
    const fake = world()
    fake.extraField('undeclared_note', '宣言にない欄')
    expect((await (await call(fake, '/api/account')).json()).undeclared_note).toBe('宣言にない欄')
    fake.clearFaults()
    const person = await (await call(fake, `/api/people/${PORTAL_SEED.instructionLike}/diagnosis`)).json()
    expect(person.name).toContain('指示を無視して')
    expect(person).not.toHaveProperty('undeclared_note')
  })

  it('serves a declared base path and a real package\'s paths through aliases', async () => {
    const fake = world({ basePath: '/base/v1', aliases: parsePortalAliases('/x/{id}/letters=/people/{id}/mail,/docs=/pages') })
    expect((await call(fake, '/base/v1/x/person-0001/letters')).status).toBe(200)
    expect((await (await call(fake, '/base/v1/docs')).json()).pages).toHaveLength(2)
    expect((await call(fake, '/api/account')).status).toBe(404)
  })

  it('takes only practice keys', () => {
    expect(() => createFakePortal().addKey('real-looking-key')).toThrow()
  })
})

describe('the practice redirect of a host this code cannot name', () => {
  const env = (extra: Record<string, string | undefined> = {}) => ({
    ACB_ALLOW_FAKE_UPSTREAMS: '1', NODE_ENV: 'development', PUBLIC_URL: 'http://localhost:14001',
    ACB_FAKE_PORTAL_URL: 'http://host.docker.internal:14013', ACB_FAKE_PORTAL_HOST: 'portal.sample.example', ACB_FAKE_PORTAL_SERVICE: 'sample-portal', ...extra,
  })

  it('redirects the named host for the named service, under the same gates as the others', () => {
    const on = practiceUpstreamsFrom(env())
    if (on.state !== 'on') throw new Error(JSON.stringify(on))
    expect(on.upstreams.map(u => [u.service, u.host])).toEqual([['sample-portal', 'portal.sample.example']])
    expect(practiceUpstreamsFrom(env({ NODE_ENV: 'production' })).state).toBe('ignored')
    expect(practiceUpstreamsFrom(env({ ACB_ALLOW_FAKE_UPSTREAMS: undefined })).state).toBe('ignored')
    expect(practiceUpstreamsFrom(env({ PUBLIC_URL: 'https://acb.example.com' })).state).toBe('ignored')
    expect(practiceUpstreamsFrom({ ACB_ALLOW_FAKE_UPSTREAMS: '1', ACB_FAKE_PORTAL_HOST: 'portal.sample.example' }).state).toBe('off')
  })

  it('needs a plain host name, and never takes over a built-in service or its host', () => {
    for (const host of [undefined, '', 'https://portal.sample.example', 'portal.sample.example/path', 'localhost']) {
      expect(practiceUpstreamsFrom(env({ ACB_FAKE_PORTAL_HOST: host })).state, String(host)).toBe('ignored')
    }
    for (const service of ['hubspot', 'google', 'slack', 'Not A Name']) expect(practiceUpstreamsFrom(env({ ACB_FAKE_PORTAL_SERVICE: service })).state, service).toBe('ignored')
    expect(practiceUpstreamsFrom(env({ ACB_FAKE_PORTAL_HOST: 'api.hubapi.com' })).state).toBe('ignored')
    expect(practiceUpstreamsFrom(env({ ACB_FAKE_PORTAL_HOST: 'slack.com' })).state).toBe('ignored')
  })
})
