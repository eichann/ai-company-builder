// A plugin's screen in Chromium (plugin-frame.md): the real frame (`sandbox="allow-scripts"`, no
// same-origin) with the CSP `acb-plugin://` gives (`pluginFrameCsp`) reaches no network, not the
// app's window, electronAPI or storage, gets its bridge port once, and its calls reach main only
// as bridge 1's ops. The page is served from this preview server's own origin on purpose: even
// same-origin, the sandbox makes it a stranger.
import { test, expect, type Frame, type Page } from '@playwright/test'
import { pluginFrameCsp } from '../../shared/plugin-bridge'
import { expectNoPageErrors, openPreview } from './helpers'

const BASE_PATH = '/__plugin/planning/0.1.0/ui/'

const FILES: Record<string, [string, string]> = {
  'index.html': ['text/html; charset=utf-8', '<!doctype html><html><head><link rel="stylesheet" href="./app.css"><script src="./app.js"></script><script>window.__inline = 1</script><script src="/__plugin/planning/0.2.0/ui/app.js"></script></head><body><p id="t">番組の画面</p><img src="https://example.com/pixel.png"></body></html>'],
  'app.js': ['text/javascript', `window.__ports = 0
window.addEventListener('message', event => {
  if (!event.ports[0]) return
  window.__ports += 1
  window.__hello = event.data
  window.__port = event.ports[0]
  window.__answers = []
  window.__port.onmessage = e => window.__answers.push(e.data)
})`],
  'app.css': ['text/css', 'p { color: rgb(1, 2, 3); }'],
}

async function servePlugin(page: Page) {
  const network: string[] = []
  await page.route('**/__plugin/**', async route => {
    const url = new URL(route.request().url())
    const name = url.pathname.startsWith(BASE_PATH) ? url.pathname.slice(BASE_PATH.length) : ''
    const file = FILES[name]
    if (!file) { network.push(url.pathname); return route.fulfill({ status: 404, body: '' }) }
    return route.fulfill({ status: 200, contentType: file[0], body: file[1], headers: { 'Content-Security-Policy': pluginFrameCsp(`${url.origin}${BASE_PATH}`) } })
  })
  // Anything else the frame might reach: recorded, never answered from outside.
  await page.route(/example\.com|\/api\//, route => { network.push(route.request().url()); return route.abort() })
  return network
}

async function pluginFrame(page: Page): Promise<Frame> {
  await expect(page.frameLocator('iframe[title="番組"]').locator('#t')).toHaveText('番組の画面')
  const frame = page.frames().find(f => f.url().includes(BASE_PATH))!
  await expect.poll(() => frame.evaluate(() => (window as unknown as { __ports: number }).__ports)).toBe(1)
  return frame
}

test('the frame reaches no network, not the app\'s window, electronAPI, storage or cookies', async ({ page }) => {
  const network = await servePlugin(page)
  const state = await openPreview(page, 'plugin-frame')
  const frame = await pluginFrame(page)

  const tried = await frame.evaluate(async () => {
    const w = window as unknown as Record<string, unknown>
    const out: Record<string, string> = {}
    const attempt = async (name: string, fn: () => unknown) => { try { await fn(); out[name] = 'reached' } catch (e) { out[name] = `refused:${(e as Error).name}` } }
    await attempt('fetch same server', () => fetch('/api/companies'))
    await attempt('fetch outside', () => fetch('https://example.com/'))
    await attempt('xhr', () => new Promise((resolve, reject) => { const x = new XMLHttpRequest(); x.onload = resolve; x.onerror = () => reject(new TypeError('xhr')); x.open('GET', '/api/x'); x.send() }))
    await attempt('websocket', () => new Promise((resolve, reject) => { const s = new WebSocket('wss://example.com/'); s.onopen = resolve; s.onerror = () => reject(new TypeError('ws')) }))
    await attempt('localStorage', () => localStorage.getItem('acb-secret'))
    await attempt('indexedDB', () => indexedDB.open('x'))
    await attempt('cookie', () => document.cookie)
    await attempt('parent electronAPI', () => { if (!(parent as unknown as { electronAPI?: unknown }).electronAPI) throw new TypeError('none') })
    await attempt('parent document', () => parent.document.title)
    out.ownElectronAPI = typeof w.electronAPI
    out.inline = String(w.__inline)
    out.popup = String(window.open('https://example.com/'))
    // A beacon is queued (true) and then refused by the CSP: the network list below stays empty.
    navigator.sendBeacon('/api/beacon', 'x')
    out.style = getComputedStyle(document.getElementById('t')!).color
    return out
  })
  expect(tried['fetch same server']).toBe('refused:TypeError')
  expect(tried['fetch outside']).toBe('refused:TypeError')
  expect(tried.xhr).toBe('refused:TypeError')
  expect(tried.websocket).toBe('refused:TypeError')
  for (const k of ['localStorage', 'indexedDB', 'cookie', 'parent electronAPI', 'parent document']) expect(tried[k], k).toBe('refused:SecurityError')
  expect(tried.ownElectronAPI).toBe('undefined')
  // An inline script and another version's script never ran; the package's own style applied.
  expect(tried.inline).toBe('undefined')
  expect(tried.popup).toBe('null')
  expect(tried.style).toBe('rgb(1, 2, 3)')
  await page.waitForTimeout(200)
  expect(network).toEqual([])
  expectNoPageErrors(state)
})

test('the port is handed once; only bridge 1\'s calls on it reach main, the window\'s messages reach nothing', async ({ page }) => {
  await servePlugin(page)
  await openPreview(page, 'plugin-frame')
  const frame = await pluginFrame(page)
  expect(await frame.evaluate(() => (window as unknown as { __hello: unknown }).__hello)).toEqual({ type: 'acb-bridge', bridge: 1 })

  await frame.evaluate(() => {
    const port = (window as unknown as { __port: MessagePort }).__port
    port.postMessage({ id: 1, op: 'records.query', args: { type: 'program_plan' } })
    port.postMessage({ id: 2, op: 'approvals.approve', args: { approvalId: 'x' } })
    port.postMessage({ id: 3, op: 'ui.open', args: { target: 'record', recordId: 'program_plan-abc123' } })
    // Outside the port: nothing listens.
    parent.postMessage({ id: 4, op: 'records.get', args: { recordId: 'program_plan-abc123' } }, '*')
  })
  const received = page.getByRole('list', { name: '本体が受け取ったもの' })
  await expect(received.getByRole('listitem')).toHaveText([
    'main co-preview planning@0.1.0 records.query {"type":"program_plan"}',
    'open {"target":"record","recordId":"program_plan-abc123"}',
  ])
  await expect.poll(() => frame.evaluate(() => (window as unknown as { __answers: unknown[] }).__answers.length)).toBe(3)
  const answers = await frame.evaluate(() => (window as unknown as { __answers: Array<{ id: number }> }).__answers.sort((a, b) => a.id - b.id))
  expect(answers).toEqual([
    { id: 1, ok: true, data: { total: 0, records: [] } },
    { id: 2, ok: false, error: { code: 'UNKNOWN_OP', message: 'unknown op' } },
    { id: 3, ok: true, data: null },
  ])

  // The frame loads again (in the app a frame's navigation is refused; here the reload goes through): no second port.
  await frame.evaluate(() => location.reload())
  await expect(page.frameLocator('iframe[title="番組"]').locator('#t')).toHaveText('番組の画面')
  const reloaded = page.frames().find(f => f.url().includes(BASE_PATH))!
  await page.waitForTimeout(200)
  expect(await reloaded.evaluate(() => (window as unknown as { __ports: number }).__ports)).toBe(0)
})
