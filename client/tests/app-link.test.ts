// The invitation's 「アプリを開く」 link (electron/features/app-link): anyone can write such a
// link, so a fake one must never point the app at another server. Guards: only https server
// addresses (http on this computer), the origin alone, only while no server is set, and only
// after the member pressed 「つなぐ」 and that server answered as ACB — with the address main
// holds, never one the renderer names.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serverFromAppLink, appLinkInArgs } from '../electron/features/app-link/link.ts'
import { APP_LINK_ALREADY_SET, APP_LINK_NO_OFFER, APP_LINK_NOT_ACB, registerAppLinkIpc } from '../electron/features/app-link/ipc.ts'
import type { IpcRegistrar } from '../electron/ipc/registrar.ts'

const link = (server: string) => `ai-company-builder://open?server=${encodeURIComponent(server)}`

test('a link offers an https origin (http only on this computer)', () => {
  assert.equal(serverFromAppLink(link('https://acb.example.com')), 'https://acb.example.com')
  assert.equal(serverFromAppLink(link('https://acb.example.com:8443/')), 'https://acb.example.com:8443')
  assert.equal(serverFromAppLink(link('http://localhost:3001')), 'http://localhost:3001')
  assert.equal(serverFromAppLink(link('http://127.0.0.1:3001')), 'http://127.0.0.1:3001')
})

test('anything else offers nothing', () => {
  const refused = [
    link('http://acb.example.com'), // plain http on the network
    link('http://192.168.1.10:3001'),
    link('ftp://acb.example.com'),
    link('javascript:alert(1)'),
    link('https://user:pass@acb.example.com'),
    link('https://acb.example.com/api'), // more than the origin
    link('https://acb.example.com/?next=x'),
    link('https://acb.example.com/#x'),
    'ai-company-builder://open?server=https%3A%2F%2Fa.example&server=https%3A%2F%2Fb.example', // two servers
    'ai-company-builder://open',
    'ai-company-builder://signin?server=https%3A%2F%2Facb.example.com', // another action
    'other-app://open?server=https%3A%2F%2Facb.example.com',
    'https://acb.example.com',
    `${link('https://acb.example.com')}${'x'.repeat(3000)}`,
    42, null, undefined,
  ]
  for (const raw of refused) assert.equal(serverFromAppLink(raw), null, String(raw))
})

test('a launch argument is found among the others', () => {
  assert.equal(appLinkInArgs(['/app', '--flag', link('https://a.example')]), link('https://a.example'))
  assert.equal(appLinkInArgs(['/app', 'https://a.example']), null)
})

function harness(options: { server?: string; acb?: boolean } = {}) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipc = { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn), on: () => {} } as unknown as IpcRegistrar
  const state = { server: options.server ?? '', checked: [] as string[] }
  const links = registerAppLinkIpc(ipc, {
    currentServer: () => state.server,
    saveServer: origin => { state.server = origin },
    checkServer: async origin => { state.checked.push(origin); return options.acb ?? true },
  })
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: {} }, ...args)
  return { links, state, call }
}

test('the address is used only after the member pressed つなぐ and the server answered as ACB', async () => {
  const h = harness()
  h.links.offer(link('https://acb.example.com'))
  assert.deepEqual(await h.call('appLink:serverOffer'), { server: 'https://acb.example.com' })
  assert.equal(h.state.server, '', 'nothing is saved by the link itself')
  // whatever the renderer passes is ignored: main uses the address the link brought
  assert.deepEqual(await h.call('appLink:acceptServer', 'https://evil.example'), { success: true })
  assert.equal(h.state.server, 'https://acb.example.com')
  assert.deepEqual(h.state.checked, ['https://acb.example.com'])
  assert.equal(await h.call('appLink:serverOffer'), null)
})

test('a refused link, a server that is not ACB, or つながない leaves the app without a server', async () => {
  const h = harness({ acb: false })
  h.links.offer(link('http://acb.example.com'))
  assert.equal(await h.call('appLink:serverOffer'), null)
  assert.deepEqual(await h.call('appLink:acceptServer'), { success: false, error: APP_LINK_NO_OFFER })

  h.links.offer(link('https://not-acb.example'))
  assert.deepEqual(await h.call('appLink:acceptServer'), { success: false, error: APP_LINK_NOT_ACB })
  assert.equal(h.state.server, '')

  await h.call('appLink:dismissServer')
  assert.equal(await h.call('appLink:serverOffer'), null)
  assert.deepEqual(await h.call('appLink:acceptServer'), { success: false, error: APP_LINK_NO_OFFER })
})

test('a link never switches an app that already has a server', async () => {
  const h = harness({ server: 'https://ours.example.com' })
  h.links.offer(link('https://other.example.com'))
  assert.equal(await h.call('appLink:serverOffer'), null)
  assert.deepEqual(await h.call('appLink:acceptServer'), { success: false, error: APP_LINK_NO_OFFER })
  assert.equal(h.state.server, 'https://ours.example.com')

  // a server set while the offer was showing wins too
  const later = harness()
  later.links.offer(link('https://other.example.com'))
  later.state.server = 'https://ours.example.com'
  assert.deepEqual(await later.call('appLink:acceptServer'), { success: false, error: APP_LINK_ALREADY_SET })
  assert.equal(later.state.server, 'https://ours.example.com')
})
