/**
 * Google Drive through the Google connection (`.claude/rules/google-drive.md`).
 * The Google connector's own routes (stage 3 moves them into its plugin as a
 * whole): rules in services/google-drive.ts, shapes in shared/types/google-drive.ts.
 *
 * The member's app (session), mounted at /api/companies/:companyId:
 *   POST /me/google/drive/picker   { mode }       the Picker window's token (drive.file only), API key, app id
 *   POST /me/google/drive/picks    { mode, ids }  keep what the person picked (each checked with Google)
 *
 * The member's AI (record token), mounted at /api/records-ai/google/drive:
 *   GET  /status            whether the Drive tools work now, the member's live picks
 *   POST /read              { fileId } a picked file, as outside text (or a PDF's bytes)        (read)
 *   POST /put               a PDF / HTML into a picked folder; Idempotency-Key in a run (S10b) (act)
 *   GET  /puts/:putId       the member's own put (an unknown one is looked up again)          (read)
 *   There is no route that gives the AI a Google token or picks for the person.
 *
 * Public, mounted at /api/google-picker:
 *   GET  /                  the Picker page (static; it gets its token only from the app's Picker window)
 */
import { createHash } from 'crypto'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { services } from '../composition'
import type { Outcome } from '../services/outcome'
import { aiActor, keyedWrite } from './record-ai-auth'
import { refusal } from './respond'
import { aiActs, aiReads, companyMember, publicRoute, serviceBody } from './guards'

const { googleDrive } = services

function answer<T>(c: Context, result: Outcome<T>) {
  c.header('Cache-Control', 'no-store')
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
}

// ---- the member's app (session) ----

export const googleDriveRoute = new Hono()

googleDriveRoute.post('/me/google/drive/picker', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await googleDrive.pickerSession(member, c.var.body))
})

googleDriveRoute.post('/me/google/drive/picks', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await googleDrive.savePicks(member, c.var.body))
})

// ---- the member's AI (record token) ----

export const googleDriveAiRoute = new Hono()

googleDriveAiRoute.get('/status', aiReads, async (c) => {
  const h = c.var.holder
  return answer(c, await googleDrive.aiStatus(h.member))
})

googleDriveAiRoute.post('/read', aiReads, serviceBody, async (c) => {
  const h = c.var.holder
  return answer(c, await googleDrive.read(h.member, c.var.body))
})

googleDriveAiRoute.post('/put', aiActs, serviceBody, async (c) => {
  const h = c.var.holder
  const body = c.var.body
  const { conversationId, runId } = aiActor(h)
  return keyedWrite(c, h, 'drive-put', body, async () => answer(c, await googleDrive.put(h.member, { kind: 'ai', conversationId, runId }, body)))
})

googleDriveAiRoute.get('/puts/:putId', aiReads, async (c) => {
  const h = c.var.holder
  return answer(c, await googleDrive.putState(h.member, c.req.param('putId')))
})

// ---- the Picker page (public, static) ----

/**
 * The page the app's Picker window loads (google-drive.md "The Picker"). It
 * holds no secret: it asks `window.acbPicker` — present only in the app's
 * dedicated Picker window (its own preload) — for the token, the API key and
 * the app id, runs Google Picker, and hands back only the picked ids. Served
 * from the server so the Picker's origin is the one the admin allows on the
 * API key (`<PUBLIC_URL>/api/google-picker`).
 */
const PICKER_SCRIPT = `(function () {
  var msg = document.getElementById('msg')
  var say = function (t) { msg.textContent = t }
  var bridge = window.acbPicker
  if (!bridge) { say('この画面はアプリの中でだけ使えます。'); return }
  var done = function (r) { try { bridge.done(r) } catch (e) { /* the window is closing */ } }
  bridge.config().then(function (cfg) {
    if (!cfg) { say('Google Drive のファイル選びを始められませんでした。'); return }
    var s = document.createElement('script')
    s.src = cfg.scriptOrigin + '/js/api.js'
    s.onerror = function () { say('Google の画面を読み込めませんでした。'); done({ action: 'error' }) }
    s.onload = function () {
      window.gapi.load('picker', { callback: function () {
        var P = window.google.picker
        var view
        if (cfg.mode === 'folder') {
          view = new P.DocsView(P.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes('application/vnd.google-apps.folder')
        } else {
          view = new P.DocsView(P.ViewId.DOCS).setMimeTypes(cfg.mimeTypes.join(','))
        }
        if (view.setEnableDrives) view.setEnableDrives(true)
        var b = new P.PickerBuilder().addView(view).setOAuthToken(cfg.accessToken).setDeveloperKey(cfg.apiKey).setAppId(cfg.appId)
          .setOrigin(window.location.origin).setLocale('ja').setTitle(cfg.mode === 'folder' ? '置き場所のフォルダを選んでください' : '読ませるファイルを選んでください')
          .setCallback(function (data) {
            if (data.action === P.Action.PICKED) done({ action: 'picked', ids: (data.docs || []).map(function (d) { return d.id }) })
            else if (data.action === P.Action.CANCEL) done({ action: 'cancel' })
          })
        if (cfg.mode === 'files') b = b.enableFeature(P.Feature.MULTISELECT_ENABLED).setMaxItems(cfg.maxItems)
        b.build().setVisible(true)
        cfg.accessToken = ''
        say('')
      }, onerror: function () { say('Google の画面を読み込めませんでした。'); done({ action: 'error' }) } })
    }
    document.head.appendChild(s)
  }, function () { say('Google Drive のファイル選びを始められませんでした。') })
})()`

const PICKER_SCRIPT_HASH = createHash('sha256').update(PICKER_SCRIPT).digest('base64')

function pickerPage(): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Google Drive から選ぶ</title><style>body{font-family:system-ui,sans-serif;margin:0;padding:24px;color:#333;background:#fff}</style></head>
<body><p id="msg">Google Drive を開いています…</p><script>${PICKER_SCRIPT}</script></body></html>`
}

export const googlePickerPageRoute = new Hono()

googlePickerPageRoute.get('/', publicRoute('a static page holding no secret; the token reaches it only from the app\'s own Picker window'), (c) => {
  const extra = googleDrive.pickerScriptOrigin === 'https://apis.google.com' ? '' : ` ${googleDrive.pickerScriptOrigin}`
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Content-Security-Policy', [
    "default-src 'none'",
    `script-src 'sha256-${PICKER_SCRIPT_HASH}' https://apis.google.com https://www.gstatic.com https://*.google.com${extra}`,
    `style-src 'unsafe-inline' https://*.gstatic.com https://fonts.googleapis.com https://*.google.com${extra}`,
    'img-src https: data:',
    'font-src https://fonts.gstatic.com',
    `frame-src https://docs.google.com https://drive.google.com https://*.google.com${extra}`,
    `connect-src https://*.googleapis.com https://*.google.com${extra}`,
    "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join('; '))
  return c.html(pickerPage())
})
