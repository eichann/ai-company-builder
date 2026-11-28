// The Electron side of tests/reply-frame-electron.test.ts: two windows showing a rich reply's frame as the chat makes it
// (sandbox `allow-popups`, a srcdoc with the frame's policy), one under the app's own `keepAppPageInWindow` and one
// without it. The frame holds a link that would navigate the frame itself (a way the renderer's guards would have
// missed: no `<base target>`, a `target` kept); a real mouse press on it shows whether main stops it. Then the page
// gives the frame a new srcdoc, as the chat does for each drawing. Writes what happened as JSON to
// `<REPLY_FRAME_TEST_DIR>/result.json`. Started with `NODE_OPTIONS=--import tsx`.
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { keepAppPageInWindow } from '../../electron/electron-adapter'

const dir = process.env.REPLY_FRAME_TEST_DIR!
const target = process.env.REPLY_FRAME_TARGET!
app.setPath('userData', path.join(dir, 'userData'))
// One window after the other: the first one closing must not end the app.
app.on('window-all-closed', () => {})

const writeResult = (value: unknown) => {
  const file = path.join(dir, 'result.json')
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value))
  fs.renameSync(`${file}.tmp`, file)
}
const fail = (error: unknown) => {
  writeResult({ error: error instanceof Error ? error.stack : String(error) })
  app.exit(1)
}
setTimeout(() => fail(new Error('the harness timed out')), 90_000)
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// The rich reply's frame policy (richReplyFrame.ts FRAME_CSP): it does not govern navigation, which is the point.
const FRAME_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'"
const reply = (label: string) => `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"></head>`
  + `<body style="margin:0"><a href="${target}/${label}" target="_self" style="display:block;width:300px;height:200px;background:#ccc">返事のリンク</a></body></html>`

function page(label: string): string {
  const file = path.join(dir, `${label}.html`)
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><body style="margin:0">
<script>
  window.loads = 0
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-popups')
  frame.style.cssText = 'position:absolute;left:0;top:0;width:300px;height:200px;border:0'
  frame.onload = () => { window.loads++ }
  frame.srcdoc = ${JSON.stringify(reply(label))}
  document.body.append(frame)
  window.again = () => { frame.srcdoc = '<!doctype html><p>次の返事</p>' }
</script></body>`)
  return file
}

async function run(label: string, guarded: boolean) {
  const file = page(label)
  const win = new BrowserWindow({ show: true, width: 400, height: 300, webPreferences: { sandbox: true, contextIsolation: true } })
  if (guarded) keepAppPageInWindow(win.webContents, { file })
  // What main saw (after the guard's own listener): the press did reach this window, and whether it was refused.
  const navigations: Array<{ url: string; refused: boolean }> = []
  win.webContents.on('will-frame-navigate', event => { if (!event.isMainFrame) navigations.push({ url: event.url, refused: event.defaultPrevented }) })
  await win.loadFile(file)
  const contents = win.webContents
  for (let i = 0; i < 50 && (await contents.executeJavaScript('window.loads')) < 1; i++) await wait(100)
  // The frame drawn and ready to be hit (it may be in a process of its own).
  await wait(1500)
  // A real press through the browser's input path (DevTools' input events reach the frame's own process too).
  contents.debugger.attach('1.3')
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: 60, y: 60, button: 'left', clickCount: 1 })
  }
  await wait(2000)
  const frameAfterPress = contents.mainFrame.frames[0]?.url ?? null
  const loadsBefore = await contents.executeJavaScript('window.loads')
  await contents.executeJavaScript('window.again()')
  for (let i = 0; i < 30 && (await contents.executeJavaScript('window.loads')) <= loadsBefore; i++) await wait(100)
  const result = {
    navigations,
    frameAfterPress,
    newReplyLoaded: (await contents.executeJavaScript('window.loads')) > loadsBefore,
    frameAfterNewReply: contents.mainFrame.frames[0]?.url ?? null,
    pageStayed: contents.getURL().endsWith(`${label}.html`),
  }
  win.destroy()
  return result
}

void app.whenReady().then(async () => {
  try {
    const unguarded = await run('unguarded', false)
    const guarded = await run('guarded', true)
    writeResult({ guarded, unguarded })
    app.exit(0)
  } catch (error) {
    fail(error)
  }
})
