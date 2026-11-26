// The Electron side of tests/video-electron.test.ts: the app's real scheme registration and
// local-file / acb-media handlers (electron-adapter.ts) with real allowed roots, and a page under
// the app's own CSP (read from client/index.html) playing videos the way the editor does.
// Writes what happened as JSON to `<VIDEO_TEST_DIR>/result.json` (temporary name, then renamed).
// Started with `NODE_OPTIONS=--import tsx`.
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { registerLocalFileScheme, serveLocalFiles } from '../../electron/electron-adapter'
import { AllowedRoots } from '../../electron/allowed-roots'
import { localVideoUrl } from '../../shared/video-files'

const dir = process.env.VIDEO_TEST_DIR!
const fixtures = path.join(import.meta.dirname, '..', 'fixtures', 'video')
app.setPath('userData', path.join(dir, 'userData'))
registerLocalFileScheme()

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

/**
 * The fixture with 3 MB of padding (a `free` box) between its media data and its index (`moov`),
 * as a camera writes it: the player must ask for a byte range near the end before it knows the
 * duration. Box offsets before the index stay as they were.
 */
function indexFarAtTheEnd(file: string): Buffer {
  const data = fs.readFileSync(file)
  let at = 0
  while (at < data.length && data.toString('latin1', at + 4, at + 8) !== 'moov') at += data.readUInt32BE(at)
  if (at >= data.length) throw new Error('no moov box in the fixture')
  const pad = Buffer.alloc(3 * 1024 * 1024)
  pad.writeUInt32BE(pad.length, 0)
  pad.write('free', 4, 'latin1')
  return Buffer.concat([data.subarray(0, at), pad, data.subarray(at)])
}

void app.whenReady().then(async () => {
  try {
    const company = path.join(dir, '会社')
    const outside = path.join(dir, 'outside')
    fs.mkdirSync(path.join(company, '動画'), { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(company, '動画', '説明 #1.mov'), indexFarAtTheEnd(path.join(fixtures, 'h264-index-at-end.mov')))
    fs.copyFileSync(path.join(fixtures, 'vp9.mp4'), path.join(company, '動画', 'vp9.mp4'))
    fs.copyFileSync(path.join(fixtures, 'prores.mov'), path.join(company, '動画', 'prores.mov'))
    fs.copyFileSync(path.join(fixtures, 'vp9.mp4'), path.join(outside, 'clip.mp4'))
    fs.symlinkSync(path.join(outside, 'clip.mp4'), path.join(company, '動画', 'link-out.mp4'))
    const roots = new AllowedRoots()
    roots.add(company)
    serveLocalFiles(roots)

    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'index.html'), 'utf8'))?.[1]
    if (!csp) throw new Error('no CSP in index.html')
    const page = path.join(dir, 'page.html')
    fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><body></body>`)
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
    await win.loadFile(page)

    const urls: Record<string, string> = {
      indexAtEnd: localVideoUrl(path.join(company, '動画', '説明 #1.mov'), 2),
      vp9: localVideoUrl(path.join(company, '動画', 'vp9.mp4')),
      prores: localVideoUrl(path.join(company, '動画', 'prores.mov')),
      outside: localVideoUrl(path.join(outside, 'clip.mp4')),
      linkOut: localVideoUrl(path.join(company, '動画', 'link-out.mp4')),
    }
    const videos = await win.webContents.executeJavaScript(`(async () => {
      const play = src => new Promise(resolve => {
        const v = document.createElement('video')
        v.preload = 'metadata'
        v.controls = true
        v.onloadedmetadata = () => {
          const duration = v.duration
          v.onseeked = () => resolve({ ok: true, duration, at: v.currentTime, paused: v.paused })
          v.currentTime = duration * 0.8
        }
        v.onerror = () => resolve({ ok: false, code: v.error && v.error.code })
        setTimeout(() => resolve({ ok: false, timeout: true }), 15000)
        v.src = src
        document.body.appendChild(v)
      })
      const urls = ${JSON.stringify(urls)}
      const out = {}
      for (const [k, u] of Object.entries(urls)) out[k] = await play(u)
      return out
    })()`)
    writeResult({ videos })
    app.exit(0)
  } catch (error) {
    fail(error)
  }
})
