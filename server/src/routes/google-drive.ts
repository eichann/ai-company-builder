/**
 * Google Drive through the Google connection (`.claude/rules/google-drive.md`).
 * The Google connector's own routes (stage 3 moves them into its plugin as a
 * whole): rules in services/google-drive.ts, shapes in shared/types/google-drive.ts.
 *
 * The member's app (session), mounted at /api/companies/:companyId:
 *   POST   /me/google/drive/picker                  { mode }  released apps' Picker window: fails closed (update the app)
 *   POST   /me/google/drive/pick-tickets            { mode, fileIds? }  a one-time pick ticket for the page in the browser
 *   GET    /me/google/drive/pick-tickets/:ticketId  the member's own ticket: waiting (saving), or its result until acknowledged
 *   DELETE /me/google/drive/pick-tickets/:ticketId  the app read the result (acknowledged) or stopped waiting
 *   POST   /me/google/drive/picks                   { mode, ids }  keep what the person picked (each checked with Google)
 *   GET  /me/google/drive/files                   the member's own picked / put files, with names (「つなぐ」's list)
 *
 * The member's AI (record token), mounted at /api/records-ai/google/drive:
 *   GET  /status            whether the Drive tools work now, the member's live picks
 *   POST /read              { fileId } a picked file, as outside text (or a PDF's bytes)        (read)
 *   POST /put               a PDF / HTML into a picked folder, or HTML / Markdown as a Google document, or a new
 *                           revision of a file an earlier put made (`updateFileId`); Idempotency-Key in a run (S10b) (act);
 *                           with `recordId`, the new file is then linked to that record (never failing the put).
 *                           A scheduled job's run: only into the folder its responsible person chose (jobs.md)
 *   GET  /puts/:putId       the member's own put (an unknown one is looked up again)          (read)
 *   There is no route that gives the AI a Google token or picks for the person.
 *
 * Public, mounted at /api/google-picker (the member's own browser; the pick ticket is the proof):
 *   GET  /                  the Picker page (static; the ticket is in the URL fragment)
 *   POST /config            { ticket } the Picker's token (drive.file only), API key, app id — once per ticket
 *   POST /result            { ticket, action, mode?, ids? } the picked Drive ids (kept as /picks keeps them) or a cancel
 */
import { createHash } from 'crypto'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { services } from '../composition'
import { logError } from '../lib/error-log'
import type { DrivePutAnswer } from '../../shared/types/google-drive'
import type { Outcome } from '../services/outcome'
import type { Member } from '../services/access'
import { NOT_IN_STEP } from '../services/not-in-step'
import type { RecordTokenHolder } from '../services/record-ai-tokens'
import type { DriveJobScope } from '../services/google-drive'
import { aiActor, keyedWrite } from './record-ai-auth'
import { refusal } from './respond'
import { aiActs, aiReads, companyMember, publicRoute, serviceBody } from './guards'

const { googleDrive, recordEngine, jobRuns } = services

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

googleDriveRoute.post('/me/google/drive/pick-tickets', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await googleDrive.startPick(member, c.var.body))
})

googleDriveRoute.get('/me/google/drive/pick-tickets/:ticketId', companyMember, (c) => {
  const member = c.var.member
  return answer(c, googleDrive.pickState(member, c.req.param('ticketId')))
})

googleDriveRoute.delete('/me/google/drive/pick-tickets/:ticketId', companyMember, (c) => {
  const member = c.var.member
  return answer(c, googleDrive.cancelPick(member, c.req.param('ticketId')))
})

googleDriveRoute.post('/me/google/drive/picks', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await googleDrive.savePicks(member, c.var.body))
})

googleDriveRoute.get('/me/google/drive/files', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, await googleDrive.ownFiles(member))
})

// ---- the member's AI (record token) ----

export const googleDriveAiRoute = new Hono()

/**
 * A token bound to an execution run reaches these routes only as a scheduled job's run with a deliverable place
 * (the record-token guard's route ceiling, `jobRunRouteAllowed`): its folder, asked again at every call (the run
 * still holds its occurrence, the job still runnable as pinned). `undefined`: no run (a consultation's token).
 */
function jobScope(c: Context, h: RecordTokenHolder): DriveJobScope | undefined | Response {
  if (!h.run) return undefined
  const runId = h.run.id
  const place = jobRuns.deliveryPlace(h.member, runId)
  if (!place || place.connector !== 'google' || place.kind !== 'drive_folder' || typeof place.ref !== 'string') {
    return c.json({ error: NOT_IN_STEP.error, code: NOT_IN_STEP.code }, 403)
  }
  return { folderId: place.ref, sameJob: other => jobRuns.sameJob(h.member, runId, other) }
}

googleDriveAiRoute.get('/status', aiReads, async (c) => {
  const h = c.var.holder
  const scope = jobScope(c, h)
  if (scope instanceof Response) return scope
  return answer(c, await googleDrive.aiStatus(h.member, scope))
})

googleDriveAiRoute.post('/read', aiReads, serviceBody, async (c) => {
  const h = c.var.holder
  return answer(c, await googleDrive.read(h.member, c.var.body))
})

googleDriveAiRoute.post('/put', aiActs, serviceBody, async (c) => {
  const h = c.var.holder
  const body = c.var.body
  const actor = aiActor(h)
  const scope = jobScope(c, h)
  if (scope instanceof Response) return scope
  return keyedWrite(c, h, 'drive-put', body, async () => {
    const put = await googleDrive.put(h.member, { kind: 'ai', conversationId: actor.conversationId, runId: actor.runId }, body, scope)
    if (!put.ok) return answer(c, put)
    // A job's run links its puts to the やること its finish makes (jobs.md), never to a record its body names.
    const recordId = scope ? undefined : (body as { recordId?: unknown } | null)?.recordId
    const linked = typeof recordId === 'string' ? linkPutToRecord(h.member, actor, recordId, put.value) : false
    return answer(c, { ok: true, value: linked ? { ...put.value, linkedTo: { recordId: recordId as string } } : put.value })
  })
})

/**
 * The file a put just made, linked to the consultation's record (google-drive.md "Linked to a
 * record"): only a new put (a replay links nothing), only once it is done in Drive, with the facts
 * of the member's own receipt (never a body's file id), through every record check of the engine.
 * Anything refused or thrown is logged with its code only; the put stays done and is answered as is.
 */
function linkPutToRecord(member: Member, actor: ReturnType<typeof aiActor>, recordId: string, put: DrivePutAnswer): boolean {
  if (put.existing || put.drivePut.state !== 'done') return false
  try {
    const file = googleDrive.putLinkable(member, put.drivePut.id)
    if (!file) return false
    const r = recordEngine.linkDrivePut(member, actor, recordId, file)
    if (!r.ok) {
      const code = typeof r.body.code === 'string' && /^[A-Z_]{1,60}$/.test(r.body.code) ? r.body.code : r.kind
      console.warn(`[google-drive] the put's file was not linked to the record: ${code}`)
      return false
    }
    return r.value.changed
  } catch (error) {
    logError('google-drive', 'linking the put\'s file to the record failed', error)
    return false
  }
}

googleDriveAiRoute.get('/puts/:putId', aiReads, async (c) => {
  const h = c.var.holder
  const scope = jobScope(c, h)
  if (scope instanceof Response) return scope
  return answer(c, await googleDrive.putState(h.member, c.req.param('putId'), scope))
})

// ---- the Picker page (public, static) and its two calls (the pick ticket is the proof) ----

/**
 * The page the app opens in the member's **own browser** (google-drive.md "Picker and its token"):
 * Google Picker needs a browser signed in to Google, and Google blocks signing in inside an embedded
 * browser, so it is not shown in a window of the app. The page holds no secret: it reads the one-time
 * pick ticket from the URL fragment (`#t=`; never sent to a server, a Referer or a log) and removes it
 * from the address, asks `config` for the token, the API key and the app id (once per ticket), runs
 * Google Picker, and posts only the picked ids — or a cancel, also when the page is closed — to `result`.
 * With `fileIds` (a Drive link the member pasted on a task card) the view shows just those files
 * (`DocsView.setFileIds`, which Google says not to combine with `setEnableDrives`); the member still
 * presses 「選択」 — that is the pick. Served from the server so the Picker's origin is the one the admin
 * allows on the API key (`<origin>/*`: with this Referrer-Policy Google sees the origin only).
 */
const PICKER_SCRIPT = `(function () {
  var msg = document.getElementById('msg')
  var say = function (t) { msg.textContent = t }
  var m = String(window.location.hash || '').match(/^#t=([0-9a-f]{64})$/)
  try { window.history.replaceState(null, '', window.location.pathname) } catch (e) { /* keep going */ }
  if (!m) { say('この画面は、アプリで「Google Drive から選ぶ」を始めたときに開きます。アプリに戻ってください。'); return }
  var ticket = m[1]
  var base = window.location.pathname.replace(/\\/+$/, '')
  var post = function (path, body, keepalive) {
    return window.fetch(base + path, {
      method: 'POST', credentials: 'omit', cache: 'no-store', keepalive: !!keepalive,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    }).then(function (r) { return r.json().catch(function () { return {} }).then(function (j) { return { ok: r.ok, j: j } }) })
  }
  var problem = function (a, fallback) { return a && a.j && typeof a.j.error === 'string' ? a.j.error : fallback }
  var LOST = 'アプリに伝えられませんでした。アプリに戻って、もう一度お試しください。'
  var BACK_TO_APP = 'アプリに戻ってください。（このタブは閉じてかまいません）'
  var finished = false
  // keepalive: the answer still reaches the server when the tab is closed right after 「選択」.
  var finish = function (body, done) {
    if (finished) return
    finished = true
    say('アプリに伝えています…')
    var giveUp = function () { if (body.action !== 'cancel') post('/result', { ticket: ticket, action: 'cancel' }, true).then(null, function () {}); say(LOST) }
    var send = function (again) {
      post('/result', body, true).then(function (a) {
        if (a.ok) say(done)
        // The first try may have reached the server: a retry told the ticket is used says nothing alarming.
        else if (!again && a.j && a.j.code === 'PICK_TICKET_GONE') say(BACK_TO_APP)
        else if (a.j && typeof a.j.error === 'string') say(a.j.error)
        else if (again) send(false)
        else giveUp()
      }, function () { if (again) send(false); else giveUp() })
    }
    send(true)
  }
  window.addEventListener('pagehide', function () {
    if (finished) return
    finished = true
    try { post('/result', { ticket: ticket, action: 'cancel' }, true) } catch (e) { /* the page is going */ }
  })
  var BACK = '（このタブは閉じてかまいません）'
  post('/config', { ticket: ticket }).then(function (a) {
    var cfg = a.ok && a.j && a.j.data
    if (!cfg) { finished = true; say(problem(a, 'Google Drive のファイル選びを始められませんでした。アプリに戻ってください。')); return }
    var s = document.createElement('script')
    s.src = cfg.scriptOrigin + '/js/api.js'
    s.onerror = function () { finish({ ticket: ticket, action: 'cancel' }, 'Google の画面を読み込めませんでした。アプリに戻ってください。' + BACK) }
    s.onload = function () {
      window.gapi.load('picker', { callback: function () {
        var P = window.google.picker
        var folder = cfg.mode === 'folder'
        var mimes = folder ? 'application/vnd.google-apps.folder' : cfg.mimeTypes.join(',')
        // One view per place, each with only the calls that go together (setParent, setEnableDrives and setOwnedByMe
        // are never combined on one view); the first is the tab the Picker opens on.
        function place(label) {
          var v = new P.DocsView(folder ? P.ViewId.FOLDERS : P.ViewId.DOCS).setMimeTypes(mimes).setIncludeFolders(true)
          if (folder) v = v.setSelectFolderEnabled(true)
          if (typeof v.setLabel === 'function') v = v.setLabel(label)
          return v
        }
        var views = []
        var only = cfg.mode === 'files' && Array.isArray(cfg.fileIds) ? cfg.fileIds.filter(function (id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{10,200}$/.test(id) }).slice(0, 10) : []
        if (only.length > 0) {
          // A pasted link: just those files (Google: setFileIds is not combined with setEnableDrives).
          var picked = new P.DocsView(P.ViewId.DOCS).setMimeTypes(mimes)
          if (picked.setFileIds) picked.setFileIds(only.join(','))
          views.push(picked)
        } else {
          var mine = place('マイドライブ')
          if (typeof mine.setParent === 'function') mine = mine.setParent('root')
          views.push(mine)
          var drives = place('共有ドライブ')
          if (typeof drives.setEnableDrives === 'function') drives = drives.setEnableDrives(true)
          views.push(drives)
          var withMe = place('共有アイテム')
          if (typeof withMe.setOwnedByMe === 'function') { withMe = withMe.setOwnedByMe(false); views.push(withMe) }
        }
        var b = new P.PickerBuilder()
        views.forEach(function (v) { b = b.addView(v) })
        b = b.setOAuthToken(cfg.accessToken).setDeveloperKey(cfg.apiKey).setAppId(cfg.appId)
          .setOrigin(window.location.origin).setLocale('ja').setTitle(cfg.mode === 'folder' ? '置き場所のフォルダを選んでください' : '読ませるファイルを選んでください')
          .setCallback(function (data) {
            if (data.action === P.Action.PICKED) {
              var ids = (data.docs || []).map(function (d) { return d && d.id }).filter(function (id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{10,200}$/.test(id) }).slice(0, cfg.maxItems)
              if (ids.length === 0) finish({ ticket: ticket, action: 'cancel' }, '選べるものがありませんでした。アプリに戻ってください。' + BACK)
              else finish({ ticket: ticket, mode: cfg.mode, action: 'picked', ids: ids }, '選びました。アプリに戻ってください。' + BACK)
            } else if (data.action === P.Action.CANCEL) {
              finish({ ticket: ticket, action: 'cancel' }, '選ぶのをやめました。アプリに戻ってください。' + BACK)
            }
          })
        if (cfg.mode === 'files') b = b.enableFeature(P.Feature.MULTISELECT_ENABLED).setMaxItems(cfg.maxItems)
        if (typeof cfg.account === 'string' && typeof b.setAuthUser === 'function') b = b.setAuthUser(cfg.account)
        b.build().setVisible(true)
        cfg.accessToken = ''
        say(typeof cfg.account === 'string' ? 'Google アカウント「' + cfg.account + '」で選んでください（ブラウザで別のアカウントになっているときは、このアカウントに切り替えてください）。' : '')
      }, onerror: function () { finish({ ticket: ticket, action: 'cancel' }, 'Google の画面を読み込めませんでした。アプリに戻ってください。' + BACK) } })
    }
    document.head.appendChild(s)
  }, function () { finished = true; say('サーバーに接続できませんでした。アプリに戻ってください。') })
})()`

const PICKER_SCRIPT_HASH = createHash('sha256').update(PICKER_SCRIPT).digest('base64')

function pickerPage(): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Google Drive から選ぶ</title><style>body{font-family:system-ui,sans-serif;margin:0;padding:24px;color:#333;background:#fff}</style></head>
<body><p id="msg">Google Drive を開いています…</p><script>${PICKER_SCRIPT}</script></body></html>`
}

/** The page's own answers: never cached, never sent on as a Referer beyond the origin. */
function pickerHeaders(c: Context) {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('X-Content-Type-Options', 'nosniff')
}

export const googlePickerPageRoute = new Hono()

googlePickerPageRoute.get('/', publicRoute('a static page holding no secret; the pick ticket reaches it only in the URL fragment, from the member\'s app'), (c) => {
  const extra = googleDrive.pickerScriptOrigin === 'https://apis.google.com' ? '' : ` ${googleDrive.pickerScriptOrigin}`
  pickerHeaders(c)
  c.header('Content-Security-Policy', [
    "default-src 'none'",
    `script-src 'sha256-${PICKER_SCRIPT_HASH}' https://apis.google.com https://www.gstatic.com https://*.google.com${extra}`,
    `style-src 'unsafe-inline' https://*.gstatic.com https://fonts.googleapis.com https://*.google.com${extra}`,
    'img-src https: data:',
    'font-src https://fonts.gstatic.com',
    `frame-src https://docs.google.com https://drive.google.com https://*.google.com${extra}`,
    `connect-src 'self' https://*.googleapis.com https://*.google.com${extra}`,
    "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join('; '))
  return c.html(pickerPage())
})

/** The Picker's config, once per pick ticket (the ticket is the proof; it holds the company and the member). */
googlePickerPageRoute.post('/config', publicRoute('the one-time pick ticket the member\'s app asked for with its session is the proof (found by its sha256; once; 10 minutes)'), serviceBody, async (c) => {
  pickerHeaders(c)
  return answer(c, await googleDrive.pageConfig(c.var.body))
})

/** The person's choice (Drive ids only) or a cancel, once per pick ticket; kept as `POST /me/google/drive/picks` keeps it. */
googlePickerPageRoute.post('/result', publicRoute('the one-time pick ticket is the proof; only Drive ids, checked with Google for the ticket\'s member'), serviceBody, async (c) => {
  pickerHeaders(c)
  return answer(c, await googleDrive.pageResult(c.var.body))
})
