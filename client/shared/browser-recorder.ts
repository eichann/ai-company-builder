/**
 * 「ブラウザ操作」 の記録 in the app (agent-browser.md "Recording"): what the window's one debugger owner observes while the
 * person records, turned at once into the recording's kept form (shared/core/browser-recording.ts). Pure (no Node, DOM or
 * Electron): the shell hands raw observations in (`BrowserRecordingObservation`), nothing raw is kept — a value becomes
 * its symbol (a keyed hash the app made for this recording only, then a number), an answer its key shape. Also the
 * owner of the window's DevTools connection (`createPageDebuggerOwner`): the AI's write gate and the recording never hold
 * it at the same time, and the script the recording puts into an isolated world of the page.
 */
import {
  BROWSER_RECORDING_FORMAT, BROWSER_RECORDING_LIMITS, browserAddressPattern, browserBodyFields, browserJsonShape, browserKeyPattern,
  browserLabel, browserOtherHost, createBrowserValueSymbols, isSensitiveFieldName,
  type BrowserRecordingContent, type BrowserRecordingStep, type BrowserSentField, type BrowserRecordedSource,
} from '../../shared/core/browser-recording'

/** What the shell observes while recording (raw: the recorder keeps none of it as it is). */
export type BrowserRecordingObservation =
  | { kind: 'page'; url: string }
  /** A message of the recording's script in the page's isolated world (checked here; anything else is dropped). */
  | { kind: 'action'; payload: string }
  | { kind: 'request'; id: string; method: string; url: string; resourceType: string; contentType?: string; body?: string; hasBody: boolean }
  /** `json`: the answer's text, only when it is JSON and small (the shell reads it; it is parsed here and dropped). */
  | { kind: 'response'; id: string; status: number; json?: string }
  | { kind: 'finished'; id: string }

/** The window's DevTools connection has one holder at a time: the AI's write gate or a recording, never both. */
export type PageDebuggerHolder = 'ai' | 'recording'
export function createPageDebuggerOwner() {
  let holder: PageDebuggerHolder | null = null
  return {
    /** True when `who` holds it now (it was free, or already `who`'s). */
    claim(who: PageDebuggerHolder): boolean {
      if (holder !== null && holder !== who) return false
      holder = who
      return true
    },
    release(who: PageDebuggerHolder) { if (holder === who) holder = null },
    holder: () => holder,
  }
}

/** How long after the person's action a request is taken to follow it (`推定`). */
const AFTER_MS = 3_000
const SEND_TYPES_FOR_READS = new Set(['XHR', 'Fetch'])
const isRead = (m: string) => m === 'GET' || m === 'HEAD'
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

export interface BrowserRecorderDeps {
  /** The operated host. */
  domain: string
  /** This recording's keyed hash (the app makes a new random key per recording). */
  digest: (value: string) => string
  now: () => number
}

export function createBrowserRecorder(deps: BrowserRecorderDeps) {
  const { domain } = deps
  const symbols = createBrowserValueSymbols(deps.digest)
  const steps: BrowserRecordingStep[] = []
  const hosts = new Map<string, boolean>()
  /** request id → the send step it made (null: another host, not kept as a step). */
  const requests = new Map<string, { step: number | null; host: string | null }>()
  const reads = new Map<string, number>()
  /** digest of a value seen in an answer → where (first seen). */
  const answerValues = new Map<string, BrowserRecordedSource>()
  let nextId = 1
  let lastAction: { id: number; at: number } | null = null
  let full = false

  type NewStep = BrowserRecordingStep extends infer S ? S extends BrowserRecordingStep ? Omit<S, 'id'> : never : never
  const push = (step: NewStep): number | null => {
    if (steps.length >= BROWSER_RECORDING_LIMITS.steps) { full = true; return null }
    const id = nextId++
    steps.push({ ...step, id } as BrowserRecordingStep)
    return id
  }
  const seenIn = (value: string): BrowserRecordedSource | null => (value.length >= 2 ? answerValues.get(deps.digest(value)) ?? null : null)

  function action(payload: string) {
    let a: unknown
    try { a = JSON.parse(payload) } catch { return }
    if (!a || typeof a !== 'object' || Array.isArray(a)) return
    const o = a as Record<string, unknown>
    if (o.type === 'click') {
      if (o.role === 'link') {
        const address = typeof o.href === 'string' ? browserAddressPattern(o.href, domain) : null
        const id = push({ kind: 'click', target: 'link', label: null, address })
        if (id !== null) lastAction = { id, at: deps.now() }
      } else if (o.role === 'button' || o.role === 'choice') {
        const id = push({ kind: 'click', target: o.role, label: browserLabel(o.label), address: null })
        if (id !== null) lastAction = { id, at: deps.now() }
      }
      return
    }
    if (o.type === 'change') {
      const inputType = typeof o.inputType === 'string' ? o.inputType : ''
      if (inputType === 'hidden') return
      const rawName = typeof o.name === 'string' && o.name !== '' ? o.name : null
      const name = rawName === null ? null : isSensitiveFieldName(rawName) ? '{x}' : browserKeyPattern(rawName)
      const secret = inputType === 'password' || (rawName !== null && isSensitiveFieldName(rawName))
      const value = secret ? 'secret' : inputType === 'file' ? 'file' : typeof o.value === 'string' ? symbols.symbol(o.value) : 'empty'
      const from = !secret && typeof o.value === 'string' ? seenIn(o.value) : null
      const id = push({ kind: 'input', label: browserLabel(o.label), name, value, from })
      if (id !== null) lastAction = { id, at: deps.now() }
    }
  }

  function fieldsOf(contentType: string | undefined, body: string | undefined, hasBody: boolean): { fields: BrowserSentField[] | null; override: string | null } {
    if (body === undefined) return { fields: hasBody ? null : [], override: null }
    const raw = browserBodyFields(contentType, body)
    if (raw === null) return { fields: null, override: null }
    const out: BrowserSentField[] = []
    let override: string | null = null
    for (const f of raw) {
      if (f.name === '_method') {
        const m = f.value.toUpperCase()
        if (m === 'PUT' || m === 'PATCH' || m === 'DELETE') override = m
        continue
      }
      // A password / token / session field is gone already (browserBodyFields); its masked name is checked again.
      const name = f.name
      if (isSensitiveFieldName(name)) continue
      const value = f.file ? 'file' : symbols.symbol(f.value)
      const from = f.file ? null : seenIn(f.value)
      if (out.some(x => x.name === name && x.value === value)) continue
      if (out.length >= BROWSER_RECORDING_LIMITS.fieldsPerSend) break
      out.push({ name, value, from })
    }
    return { fields: out, override }
  }

  function request(o: Extract<BrowserRecordingObservation, { kind: 'request' }>) {
    if (requests.has(o.id)) return // a redirect of a request already seen
    let host: string
    try { host = new URL(o.url).hostname } catch { return }
    if (host !== domain) {
      const other = browserOtherHost(o.url, domain)
      if (other && (hosts.has(other) || hosts.size < BROWSER_RECORDING_LIMITS.hosts)) hosts.set(other, hosts.get(other) ?? false)
      requests.set(o.id, { step: null, host: other })
      return
    }
    const method = METHODS.has(o.method.toUpperCase()) ? o.method.toUpperCase() : 'OTHER'
    // A page's own load is its page step; a read of a part (script, style, image) is not the work.
    if (isRead(method) && !SEND_TYPES_FOR_READS.has(o.resourceType)) return
    const address = browserAddressPattern(o.url, domain)
    if (address === null) return
    if (isRead(method)) {
      const seen = reads.get(`${method} ${address}`)
      if (seen !== undefined) {
        const s = steps.find(x => x.id === seen)
        if (s && s.kind === 'send' && s.count < BROWSER_RECORDING_LIMITS.count) s.count++
        requests.set(o.id, { step: null, host: null })
        return
      }
    }
    const { fields, override } = isRead(method) ? { fields: [] as BrowserSentField[], override: null } : fieldsOf(o.contentType, o.body, o.hasBody)
    const after = lastAction && deps.now() - lastAction.at <= AFTER_MS ? lastAction.id : null
    const id = push({ kind: 'send', method, override, address, fields, status: null, answerKeys: null, after, count: 1 })
    if (id === null) return
    if (isRead(method)) reads.set(`${method} ${address}`, id)
    requests.set(o.id, { step: id, host: null })
  }

  function response(o: Extract<BrowserRecordingObservation, { kind: 'response' }>) {
    const r = requests.get(o.id)
    if (!r) return
    if (r.host) { hosts.set(r.host, true); return }
    const s = r.step === null ? undefined : steps.find(x => x.id === r.step)
    if (!s || s.kind !== 'send') return
    if (s.status === null && Number.isInteger(o.status) && o.status >= 100 && o.status <= 599) s.status = o.status
    if (o.json === undefined || s.answerKeys !== null) return
    let parsed: unknown
    try { parsed = JSON.parse(o.json) } catch { return }
    const shape = browserJsonShape(parsed)
    s.answerKeys = shape.keys
    for (const leaf of shape.leaves) {
      if (leaf.value.length < 2) continue
      const d = deps.digest(leaf.value)
      if (!answerValues.has(d)) answerValues.set(d, { step: s.id, key: leaf.key })
    }
  }

  return {
    observe(o: BrowserRecordingObservation) {
      try {
        switch (o.kind) {
          case 'page': {
            const address = browserAddressPattern(o.url, domain)
            const last = steps[steps.length - 1]
            if (address !== null && !(last && last.kind === 'page' && last.address === address)) push({ kind: 'page', address })
            return
          }
          case 'action': return action(o.payload)
          case 'request': return request(o)
          case 'response': return response(o)
          case 'finished': {
            const r = requests.get(o.id)
            if (r?.host) hosts.set(r.host, true)
          }
        }
      } catch { /* an observation that cannot be read is left out */ }
    },
    /** The recording as kept (a copy). */
    content(): BrowserRecordingContent {
      return {
        format: BROWSER_RECORDING_FORMAT,
        domain,
        steps: steps.map(s => structuredClone(s)),
        hosts: [...hosts].map(([host, loaded]) => ({ host, loaded })),
      }
    },
    lines: () => steps.length,
    /** True once the step limit stopped the recording from growing. */
    full: () => full,
  }
}
export type BrowserRecorder = ReturnType<typeof createBrowserRecorder>

// ---------------------------------------------------------------------------
// The member's screen (Settings › 「ブラウザ操作」, each site's 「記録する」) and its IPC payloads
// ---------------------------------------------------------------------------

/** One line of the list the person sees before sending (only what the recording holds). */
export interface BrowserRecordingLineView { id: number; kind: string; text: string; estimated: string | null }

/** The member's recording in this company: none, recording (how many lines so far), or waiting to be checked and sent. */
export type BrowserRecordingView =
  | { state: 'none'; message: string | null }
  | { state: 'recording'; host: string; lines: number; full: boolean }
  | { state: 'review'; host: string; lines: BrowserRecordingLineView[]; full: boolean; message: string | null }

export type BrowserRecordingResult = { ok: true; view: BrowserRecordingView } | { ok: false; message: string }

/** The screen's words (the renderer's bundle holds only these; main's own sentences are in features/browser/recording.ts). */
export const BROWSER_RECORDING_APP_WORDS = {
  record: '記録する',
  windowRecording: '（記録中）',
  recordNote: 'いつもの作業を、サイトの窓で1回通してやってください。押したボタンと入力した欄の見出し、開いたページの形だけを記録します。入力した値・パスワード・ログインの情報は記録しません。',
  recording: (host: string, lines: number) => `${host} を記録しています（${lines}行）。作業が終わったら［記録を止める］を押してください。`,
  stop: '記録を止める',
  discard: '捨てる',
  send: '送る',
  deleteLine: '消す',
  reviewTitle: '送る前に確かめてください',
  reviewNote: '要らない行は［消す］で消せます。送った記録は、あなたと会社のオーナー・管理者だけが見られ、30日で消えます。',
  full: '長いので、ここで記録を止めました（500行まで）。',
}

/** Who hears a recording's observations; `ended`: the window closed or the connection was lost (the recording is discarded). */
export interface BrowserRecordingObserver {
  observe(o: BrowserRecordingObservation): void
  ended(reason: 'closed' | 'lost'): void
}

/** What a window offers a recording (the shell's window: its debugger owner attaches, never the recording). */
export interface BrowserRecordSurface {
  /** True once the window's pages are observed; false when it cannot start (the AI operates it, it is closed, it failed). */
  start(observer: BrowserRecordingObserver): Promise<boolean>
  /** Stops observing (nothing more is heard); safe to call twice. */
  stop(): Promise<void>
  active(): boolean
}

/** The binding the recording's script calls (only in its isolated world: the page's own world never has it). */
export const BROWSER_RECORDING_BINDING = '__acbRecord'
export const BROWSER_RECORDING_WORLD = 'acb-recording'

/**
 * The script the recording runs in an isolated world of the page (the page's scripts cannot see or call into it): trusted
 * clicks on buttons, choices and links, and changed fields. A link is sent as its address only (never its text); a
 * password field's value is never read.
 */
export const BROWSER_RECORDING_SCRIPT = `(() => {
  if (globalThis.__acbRecording || typeof document === 'undefined') return; globalThis.__acbRecording = true;
  // The binding's name is BROWSER_RECORDING_BINDING (spelled out: no call runs when the renderer loads this module).
  const send = (o) => { try { globalThis.__acbRecord(JSON.stringify(o)); } catch (e) {} };
  const clip = (s) => (typeof s === 'string' ? s : '').slice(0, 200);
  const byIds = (ids) => (ids || '').split(/\\s+/).map(id => document.getElementById(id)).filter(Boolean).map(el => el.innerText || '').join(' ');
  // A <label> wrapping its field: its own words only, never the field's options or value.
  const ownText = (label) => { const c = label.cloneNode(true); c.querySelectorAll('input, select, textarea, option, datalist').forEach(n => n.remove()); return c.textContent || ''; };
  const fieldLabel = (el) => clip(el.getAttribute('aria-label') || byIds(el.getAttribute('aria-labelledby'))
    || (el.labels && el.labels[0] && ownText(el.labels[0])) || el.getAttribute('placeholder') || el.getAttribute('title') || '');
  const buttonLabel = (el) => clip(el.getAttribute('aria-label') || byIds(el.getAttribute('aria-labelledby'))
    || (el instanceof HTMLInputElement ? el.value : el.innerText) || el.getAttribute('title') || '');
  document.addEventListener('click', (e) => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const t = e.target;
    const button = t.closest('button, [role=button], input[type=submit], input[type=button], input[type=reset], input[type=image]');
    const choice = t.closest('input[type=checkbox], input[type=radio], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch]');
    const link = t.closest('a[href]');
    if (button) send({ type: 'click', role: 'button', label: buttonLabel(button) });
    // An option or a menu item is often the data itself (a customer in a list): no label.
    else if (choice) send({ type: 'click', role: 'choice', label: choice instanceof HTMLInputElement ? fieldLabel(choice) : choice.matches('[role=option], [role=menuitem]') ? '' : buttonLabel(choice) });
    else if (link) send({ type: 'click', role: 'link', href: link.href });
  }, true);
  document.addEventListener('change', (e) => {
    if (!e.isTrusted) return;
    const t = e.target;
    if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement)) return;
    const type = t instanceof HTMLInputElement ? (t.type || 'text').toLowerCase() : t instanceof HTMLSelectElement ? 'select' : 'textarea';
    if (type === 'hidden') return;
    const base = { type: 'change', inputType: type, label: fieldLabel(t), name: t.name || null };
    if (type === 'password' || type === 'file') { send(base); return; }
    const value = (type === 'checkbox' || type === 'radio') ? (t.checked ? 'on' : 'off') : t.value;
    send({ ...base, value: typeof value === 'string' ? value.slice(0, 2000) : '' });
  }, true);
})()`
