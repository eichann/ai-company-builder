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
  browserLabel, browserOtherHost, browserQueryKeptExactly, createBrowserValueSymbols, isSensitiveFieldName,
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
    // Whether the query sent is exactly its kept form (names only): a Skill's draft may name only such a query.
    const bareQuery = browserQueryKeptExactly(o.url, domain)
    const id = push({ kind: 'send', method, override, address, fields, status: null, answerKeys: null, after, count: 1, bareQuery })
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

/**
 * The member's recording in this company: none, recording (how many lines so far), or waiting to be checked and sent.
 * `notes` are main's sentences for the screen (the renderer's bundle holds only short button words).
 */
export type BrowserRecordingView =
  | { state: 'none'; message: string | null; notes: string[] }
  | { state: 'recording'; host: string; lines: number; notes: string[] }
  | {
    state: 'review'; host: string; lines: BrowserRecordingLineView[]; message: string | null; notes: string[]
    /** The list's, the words' and the hosts' headings (main's words). */
    titles: { lines: string; words: string; hosts: string }
    /** Words the person may hide everywhere (`{x}`), with how often each appears. */
    words: Array<{ word: string; count: number }>
    /** The other hosts the window's pages asked for: kept unless the person removes them. */
    hosts: Array<{ host: string; loaded: boolean }>
  }

export type BrowserRecordingResult = { ok: true; view: BrowserRecordingView } | { ok: false; message: string }

/** One change the person makes before sending: delete a line, hide a word everywhere, remove another host. */
export type BrowserRecordingEdit = { kind: 'line'; id: number } | { kind: 'word'; word: string } | { kind: 'host'; host: string }

/** The screen's words (the renderer's bundle holds only these; main's sentences are in features/browser/recording.ts). */
export const BROWSER_RECORDING_APP_WORDS = {
  record: '記録する',
  stop: '記録を止める',
  discard: '捨てる',
  send: '送る',
  deleteLine: '消す',
  hide: '伏せる',
}

/** What the window's title adds while it records (the shell's). */
export const BROWSER_RECORDING_WINDOW_TITLE = '（記録中）'

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
  // Labels only from real controls (independent review of #846: a page makes whole rows buttons, and their text is data):
  // a form field's own aria-label, <label> words, placeholder or title — never text another element points at; a native
  // button's own text only when it holds few elements; anything else acting as a button or a choice only its aria-label
  // or title, and nothing from a row, a list item or a cell, or an element holding many others.
  const SMALL = 8;
  const rowLike = (el) => el.matches('tr, td, th, li, [role=row], [role=gridcell], [role=cell], [role=listitem], [role=option], [role=menuitem]');
  // A <label> of its field: its own words only, never the field's options or value.
  const ownText = (label) => { const c = label.cloneNode(true); c.querySelectorAll('input, select, textarea, option, datalist').forEach(n => n.remove()); return c.textContent || ''; };
  const fieldLabel = (el) => clip(el.getAttribute('aria-label')
    || (el.labels && el.labels[0] && ownText(el.labels[0])) || el.getAttribute('placeholder') || el.getAttribute('title') || '');
  const nativeButton = (el) => el instanceof HTMLButtonElement || (el instanceof HTMLInputElement && /^(submit|button|reset|image)$/.test(el.type));
  const controlLabel = (el) => {
    if (el instanceof HTMLInputElement) return nativeButton(el) ? clip(el.getAttribute('aria-label') || el.value || el.getAttribute('title') || '') : fieldLabel(el);
    if (rowLike(el) || el.querySelectorAll('*').length > SMALL) return '';
    if (nativeButton(el)) return clip(el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || '');
    return clip(el.getAttribute('aria-label') || el.getAttribute('title') || '');
  };
  document.addEventListener('click', (e) => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const t = e.target;
    const button = t.closest('button, [role=button], input[type=submit], input[type=button], input[type=reset], input[type=image]');
    const choice = t.closest('input[type=checkbox], input[type=radio], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch]');
    const link = t.closest('a[href]');
    if (button) send({ type: 'click', role: 'button', label: controlLabel(button) });
    else if (choice) send({ type: 'click', role: 'choice', label: controlLabel(choice) });
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
