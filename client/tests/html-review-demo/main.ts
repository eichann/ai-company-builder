// A demo of reviewing an HTML document (doc-frame.md "Review in the document view") in a real
// Electron: the preview page tests/html-review-ui.html (the real TabbedEditorPanel, served by
// `vite -c tests/ui/vite.config.ts`) in a window whose preload hands it the REAL document views —
// doc-view.ts, the in-memory acb-doc session with its proxy, request hook and CSP, the grants and the
// review piece in the page's isolated world — and real files in a fictional company folder. Not a
// test: `run.mjs` starts it; with DEMO_SHOTS it plays the scenario and writes screenshots (the app's
// page and the document's view put together), otherwise it stays open for a person to try.
// Started with `NODE_OPTIONS=--import tsx`.
import { app, BrowserWindow, ipcMain, nativeImage, webContents as allWebContents, type WebContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { registerLocalFileScheme } from '../../electron/electron-adapter'
import { createDocViewShell } from '../../electron/doc-view'
import { createDocFrames } from '../../electron/features/doc-frames/protocol'
import { createDocViews } from '../../electron/features/doc-frames/views'
import { registerDocViewsIpc } from '../../electron/features/doc-frames/ipc'
import { typedIpc } from '../../electron/ipc/registrar'
import { SAMPLE_HTML, SAMPLE_HTML_CHANGED } from './sample'

const dir = process.env.DEMO_DIR!
const pageUrl = process.env.DEMO_PAGE!
const shots = process.env.DEMO_SHOTS || null
const company = path.join(dir, '株式会社サンプル')
const doc = path.join(company, '営業部', '月次報告.html')

app.setPath('userData', path.join(dir, 'userData'))
registerLocalFileScheme()
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** The fictional company folder, fresh each run. */
function setUp() {
  fs.rmSync(company, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(doc), { recursive: true })
  fs.writeFileSync(doc, SAMPLE_HTML)
  fs.writeFileSync(path.join(dir, 'preload.js'), `
const { contextBridge, ipcRenderer } = require('electron')
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)
const subscribe = channel => callback => {
  const listener = (_event, value) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}
contextBridge.exposeInMainWorld('electronAPI', {
  readFile: p => invoke('fs:readFile', p),
  exists: p => invoke('fs:exists', p),
  writeFile: (p, c) => invoke('fs:writeFile', p, c),
  renameItem: (a, b) => invoke('fs:rename', a, b),
  deleteItem: p => invoke('fs:delete', p),
  readDirectory: p => invoke('fs:readDirectory', p),
  onFileChanges: subscribe('fs:changes'),
  openDocView: p => invoke('docView:open', p),
  closeDocView: (id, keep) => invoke('docView:close', id, keep),
  setDocViewBounds: (id, b) => invoke('docView:setBounds', id, b),
  setDocViewZoom: (id, f) => invoke('docView:setZoom', id, f),
  reloadDocView: id => invoke('docView:reload', id),
  setDocViewReview: (id, r) => invoke('docView:review', id, r),
  findDocViewQuote: (id, i) => invoke('docView:findQuote', id, i),
  onDocViewEvent: subscribe('docView:event'),
})
`)
}

/** Files of the fictional company only (the demo's stand-in for the app's allowed roots). */
const inside = (p: unknown): string => {
  if (typeof p !== 'string') throw new Error('not a path')
  const resolved = path.resolve(p)
  if (!resolved.startsWith(company + path.sep)) throw new Error('outside the demo company')
  return resolved
}

function registerFiles(win: BrowserWindow) {
  ipcMain.handle('fs:readFile', (_e, p) => { try { return fs.readFileSync(inside(p), 'utf8') } catch { return null } })
  ipcMain.handle('fs:exists', (_e, p) => { try { return fs.existsSync(inside(p)) } catch { return false } })
  ipcMain.handle('fs:writeFile', (_e, p, content) => { try { fs.writeFileSync(inside(p), String(content)); return true } catch { return false } })
  ipcMain.handle('fs:rename', (_e, a, b) => { try { fs.renameSync(inside(a), inside(b)); return { success: true, newPath: b } } catch (err) { return { success: false, error: String(err) } } })
  ipcMain.handle('fs:delete', (_e, p) => { try { fs.rmSync(inside(p)); return { success: true } } catch (err) { return { success: false, error: String(err) } } })
  ipcMain.handle('fs:readDirectory', (_e, p) => {
    try {
      const folder = inside(p)
      return fs.readdirSync(folder, { withFileTypes: true }).map(e => ({ name: e.name, isDirectory: e.isDirectory(), path: path.join(folder, e.name) }))
    } catch { return [] }
  })
  // The watcher, as the app's company watcher reports changes (batched).
  let pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  fs.watch(company, { recursive: true }, (_event, name) => {
    if (!name) return
    pending.add(path.join(company, name.toString()))
    timer ??= setTimeout(() => {
      timer = null
      const changes = [...pending].map(p => ({ type: 'change', path: p }))
      pending = new Set()
      if (!win.isDestroyed()) win.webContents.send('fs:changes', changes)
    }, 100)
  })
}

/** The window as the member sees it: the app's page with the document's own view put on top. */
async function screenshot(win: BrowserWindow, name: string) {
  await wait(400)
  const page = await win.webContents.capturePage()
  const size = page.getSize()
  const [contentWidth] = win.getContentSize()
  const scale = size.width / contentWidth
  const bitmap = Buffer.from(page.toBitmap())
  for (const child of win.contentView.children) {
    const contents = (child as { webContents?: WebContents }).webContents
    if (!contents || !child.getVisible()) continue
    const bounds = child.getBounds()
    if (bounds.width < 1 || bounds.height < 1) continue
    const shot = await contents.capturePage()
    const s = shot.getSize()
    const pixels = shot.toBitmap()
    const left = Math.round(bounds.x * scale)
    const top = Math.round(bounds.y * scale)
    for (let y = 0; y < s.height && top + y < size.height; y++) {
      const from = y * s.width * 4
      const to = ((top + y) * size.width + left) * 4
      const width = Math.min(s.width, size.width - left) * 4
      pixels.copy(bitmap, to, from, from + width)
    }
  }
  const image = nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height, scaleFactor: scale })
  fs.mkdirSync(shots!, { recursive: true })
  fs.writeFileSync(path.join(shots!, `${name}.png`), image.toPNG())
  console.log(`[demo] wrote ${name}.png`)
}

/** Runs in the app's page (the demo's driver, not the app). */
const inPage = (win: BrowserWindow, code: string) => win.webContents.executeJavaScript(code, true)
const clickText = (win: BrowserWindow, text: string, within = 'document') => inPage(win, `(() => {
  const el = [...${within}.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(text)}))
  if (!el) return false
  el.click()
  return true
})()`)
const typeInto = async (win: BrowserWindow, text: string) => {
  win.webContents.focus()
  await wait(150)
  await win.webContents.insertText(text)
}

/** The document's view (the driver finds where words are in it; a person would just look). */
function docView(win: BrowserWindow): WebContents | null {
  for (const child of win.contentView.children) {
    const contents = (child as { webContents?: WebContents }).webContents
    if (contents && contents.getURL().startsWith('acb-doc:') && child.getVisible()) return contents
  }
  return null
}

/** Drags the mouse over `text` in the document, as the member would (real input events into the view). */
async function selectInDocument(view: WebContents, text: string) {
  const rect = await view.executeJavaScript(`(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.data.indexOf(${JSON.stringify(text)})
      if (at < 0 || !n.parentElement.checkVisibility()) continue
      const r = new Range(); r.setStart(n, at); r.setEnd(n, at + ${text.length})
      const b = r.getBoundingClientRect()
      return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }
    }
    return null
  })()`, true)
  if (!rect) throw new Error(`not in the document: ${text}`)
  const y = Math.round((rect.top + rect.bottom) / 2)
  const x1 = Math.round(rect.left) + 1
  const x2 = Math.round(rect.right) - 1
  view.sendInputEvent({ type: 'mouseDown', x: x1, y, button: 'left', clickCount: 1 })
  for (let i = 1; i <= 6; i++) view.sendInputEvent({ type: 'mouseMove', x: Math.round(x1 + ((x2 - x1) * i) / 6), y, button: 'left', modifiers: ['leftButtonDown'] })
  view.sendInputEvent({ type: 'mouseUp', x: x2, y, button: 'left', clickCount: 1 })
  await wait(500)
}

/** Clicks a word in the document (the page's own tab buttons). */
async function clickInDocument(view: WebContents, text: string) {
  const at = await view.executeJavaScript(`(() => {
    const el = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
  })()`, true)
  if (!at) throw new Error(`no button in the document: ${text}`)
  view.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  view.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  await wait(500)
}

/** Clicks the side panel's comment whose quote starts with `quote`. */
const clickComment = (win: BrowserWindow, quote: string) => inPage(win, `(() => {
  const card = [...document.querySelectorAll('[data-comment-id]')].find(c => c.textContent.includes(${JSON.stringify(quote)}))
  if (!card) return false
  card.click()
  return true
})()`)
const clickInComment = (win: BrowserWindow, quote: string, button: string) => inPage(win, `(() => {
  const card = [...document.querySelectorAll('[data-comment-id]')].find(c => c.textContent.includes(${JSON.stringify(quote)}))
  const el = card && [...card.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(button)})
  if (!el) return false
  el.click()
  return true
})()`)

async function until(check: () => Promise<boolean> | boolean, what: string, ms = 10_000) {
  for (let i = 0; i < ms / 100; i++) {
    if (await check()) return
    await wait(100)
  }
  throw new Error(`timed out: ${what}`)
}

async function comment(win: BrowserWindow, quote: string, body: string) {
  const view = docView(win)!
  await selectInDocument(view, quote)
  await until(() => inPage(win, `!!document.querySelector('textarea[placeholder^="コメントを入力"]')`), 'the comment box')
  await typeInto(win, body)
  await clickText(win, 'コメント')
  await until(() => inPage(win, `!document.querySelector('textarea[placeholder^="コメントを入力"]')`), 'the comment saved')
}

async function scenario(win: BrowserWindow) {
  await until(() => !!docView(win), 'the document view')
  await wait(1200)
  await until(() => clickText(win, 'レビューする'), 'レビューする')
  await wait(600)
  // 1. Selecting text in the document opens the comment box (over the side panel, never over the document).
  const view = docView(win)!
  await selectInDocument(view, '前年同月比 112%')
  await until(() => inPage(win, `!!document.querySelector('textarea[placeholder^="コメントを入力"]')`), 'the comment box')
  await typeInto(win, '前年同月の数字の出どころを書いてください。')
  await screenshot(win, '1-select-and-comment')
  await clickText(win, 'コメント')
  await wait(800)
  await comment(win, '新規のお客さまは 18 社', '「新規」の数え方（初回の契約日？）を一言そえてください。')
  // A comment inside the document's second tab (its script shows one tab at a time).
  await clickInDocument(docView(win)!, '来月の目標')
  await comment(win, '目標は 2,600 万円', '目標の根拠を書いてください。')
  await clickInDocument(docView(win)!, '今月の売上')
  await wait(600)
  // 2. Marks in the document and the side panel; a click on a comment scrolls to it and makes it flash.
  await clickComment(win, '新規のお客さまは 18 社')
  await wait(500)
  await screenshot(win, '2-highlights-and-side-panel')
  // 3. Hidden right now: the comment's words sit in the closed tab.
  await clickComment(win, '目標は 2,600 万円')
  await until(() => inPage(win, `document.body.textContent.includes('いま隠れています')`), 'the hidden notice')
  await screenshot(win, '3-hidden-in-a-closed-tab')
  // 4. A reply.
  await clickInComment(win, '前年同月比 112%', '返信')
  await wait(300)
  await typeInto(win, '経理の月次集計（11 月 30 日締め）です。追記しました。')
  await clickInComment(win, '前年同月比 112%', '返信')
  await until(() => inPage(win, `document.body.textContent.includes('追記しました')`), 'the reply')
  await screenshot(win, '4-reply')
  // 5. Resolved: the mark turns green, the card fades.
  await clickInComment(win, '前年同月比 112%', '解決')
  await wait(800)
  await screenshot(win, '5-resolved')
  // The review is completed; then someone (the AI) rewrites a sentence of the document.
  await clickText(win, 'レビュー完了')
  await wait(800)
  fs.writeFileSync(doc, SAMPLE_HTML_CHANGED)
  await wait(1500)
  // Opening the document again (as after switching tabs): 「位置不明」 is computed when the reviews load.
  win.webContents.reload()
  await until(() => !!docView(win), 'the document view again')
  await wait(1200)
  await until(() => clickText(win, 'レビュー履歴'), 'レビュー履歴')
  await wait(300)
  await inPage(win, `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('件のコメント') || b.textContent.includes('山田')); b && b.click() })()`)
  await until(() => inPage(win, `document.body.textContent.includes('位置不明')`), '位置不明')
  await screenshot(win, '6-orphaned-after-the-html-changed')
  // 「変更を確認」: the page's words then and now, not its tags.
  await clickText(win, '変更を確認')
  await wait(800)
  await screenshot(win, '7-changes-since-the-review')
  console.log('[demo] the files next to the document:')
  for (const name of fs.readdirSync(path.dirname(doc))) console.log(`[demo]   ${name}`)
}

app.whenReady().then(async () => {
  setUp()
  const docFrames = createDocFrames({
    paths: { validate: p => inside(p), rootOf: p => (path.resolve(p).startsWith(company + path.sep) ? company : null) },
    notDownloaded: () => [],
  })
  let win: BrowserWindow | null = null
  const docViews = createDocViews({
    frames: docFrames,
    shell: createDocViewShell({ serve: request => docFrames.serve(request) }),
    notify: (_windowId, event) => { if (win && !win.isDestroyed()) win.webContents.send('docView:event', event) },
  })
  win = new BrowserWindow({ width: 1320, height: 820, title: 'ACB — HTML のレビュー（デモ）', webPreferences: { preload: path.join(dir, 'preload.js'), contextIsolation: true, sandbox: true } })
  const mainId = win.webContents.id
  registerDocViewsIpc(typedIpc(ipcMain), { frames: docFrames, views: docViews, fromMainWindow: event => event.sender.id === mainId && allWebContents.fromId(mainId) !== undefined })
  registerFiles(win)
  const query = new URLSearchParams({ root: company, doc })
  await win.loadURL(`${pageUrl}?${query}`)
  if (!shots) return
  try {
    await scenario(win)
    app.exit(0)
  } catch (err) {
    console.error('[demo] failed:', err)
    await screenshot(win, 'failed').catch(() => {})
    app.exit(1)
  }
})
app.on('window-all-closed', () => app.quit())
