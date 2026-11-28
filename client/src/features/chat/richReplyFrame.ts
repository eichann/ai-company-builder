// The reply's closed frame (chat-ui-and-history.md "Rich replies: the reply's closed frame"): what a rich reply's frame
// holds and the two guards around it. Guard 1: every piece — the AI's HTML and the chat's own Markdown alike — goes
// through sanitizeReplyHtml. Guard 2: the frame the member sees runs no script and has no origin of its own
// (sandbox `allow-popups` only: a web link may ask for a new window, which the app opens in the browser), and its
// own policy loads nothing but inline pictures (FRAME_CSP). Its height is read from a hidden, inert copy
// (`measureReply`), since nothing can leave the shown frame to say how tall it is.
// Over ~300 lines would be the CSS; it stays here because the frame, its look and its measure change together.
import { sanitizeReplyHtml } from './replyHtmlCleaning'
import { parseInert } from './markupCleaning'
import { CHAT_MARKDOWN_CLASS, cssForTheme, SLIDE_HEIGHT, SLIDE_WIDTH, writtenSoFar, type RichPiece } from './richReply'
import { markdownHtml } from './richReplyMarkdown'

/** Nothing loads but a picture written into the reply; no script, form, frame, font, base or connection. */
export const FRAME_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'"
/** The shown frame: no `allow-scripts`, no `allow-same-origin`. Popups only, for a pressed web link. */
export const SHOWN_FRAME_SANDBOX = 'allow-popups'
/** The hidden copy the chat measures: readable by the chat, so no script and nothing the member can press. */
export const MEASURE_FRAME_SANDBOX = 'allow-same-origin'

export interface FrameContent {
  /** Cleaned markup for the frame's root (balanced: serialised from one tree). */
  body: string
  /** The reply's own cleaned CSS, for the app's theme. */
  css: string
}

const cleaned = new Map<string, { html: string; css: string }>()

/** One piece cleaned (kept per text and theme: a reply being written cleans only its last piece again). */
function cleanPiece(piece: RichPiece, isDark: boolean): { html: string; css: string } {
  const key = `${piece.kind}|${isDark ? 'd' : 'l'}|${piece.open ? 'o' : 'c'}|${piece.text}`
  const kept = cleaned.get(key)
  if (kept) return kept
  const source = piece.kind === 'markdown' ? markdownHtml(piece.text, isDark) : piece.open ? writtenSoFar(piece.text) : piece.text
  const result = sanitizeReplyHtml(source)
  cleaned.set(key, result)
  if (cleaned.size > 100) cleaned.delete(cleaned.keys().next().value as string)
  return result
}

/**
 * The whole reply for its frame: each piece cleaned on its own, put in the frame's wrapper for its kind, and the
 * result written out from one tree (so no piece can close another's wrapper or the root).
 */
export function frameContentOf(pieces: RichPiece[], isDark: boolean): FrameContent {
  const doc = parseInert('')
  const root = doc.createElement('div')
  const sheets: string[] = []
  for (const piece of pieces) {
    const { html, css } = cleanPiece(piece, isDark)
    if (css) sheets.push(css)
    const holder = doc.createElement('div')
    holder.className = `acb-piece acb-${piece.kind}`
    const parsed = parseInert(`<!doctype html><body>${html}`).body
    if (piece.kind === 'slide') {
      const inner = doc.createElement('div')
      inner.className = 'acb-slide-inner'
      inner.append(...Array.from(parsed.childNodes).map(node => doc.importNode(node, true)))
      holder.classList.add('not-prose')
      holder.append(inner)
    } else {
      holder.append(...Array.from(parsed.childNodes).map(node => doc.importNode(node, true)))
    }
    root.append(holder)
  }
  // The cleaning promises CSS without `<`; it is checked again here, where it goes inside a <style>.
  const css = cssForTheme(sheets.join('\n'), isDark)
  return { body: root.innerHTML, css: css.includes('<') ? '' : css }
}

// --- the frame's own look ----------------------------------------------------------------------------------------

let appCssText: string | null = null
/**
 * The app's design tokens (custom properties on `:root` and `.dark`) and its Markdown typography (the `prose` rules),
 * read once from the app's own style sheets. Only the app's CSS: nothing of the reply.
 */
function appCss(): string {
  if (appCssText !== null) return appCssText
  const walk = (rules: CSSRuleList): string => {
    let text = ''
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        const selector = rule.selectorText.trim()
        if (selector === ':root' || selector === '.dark') {
          const props: string[] = []
          for (let i = 0; i < rule.style.length; i++) {
            const name = rule.style[i]
            if (name.startsWith('--')) props.push(`${name}: ${rule.style.getPropertyValue(name)}`)
          }
          if (props.length) text += `${selector} { ${props.join('; ')} }\n`
        } else if (/prose|markdown-message/.test(selector)) text += `${rule.cssText}\n`
      } else if (rule instanceof CSSMediaRule) {
        const inner = walk(rule.cssRules)
        if (inner) text += `@media ${rule.conditionText} {\n${inner}}\n`
      }
    }
    return text
  }
  let out = ''
  for (const sheet of Array.from(document.styleSheets)) {
    try { out += walk(sheet.cssRules) } catch { /* a sheet that cannot be read is not the app's */ }
  }
  // Only for <style>: the app's own CSS never holds `<`, but nothing is left to chance.
  appCssText = out.replace(/</g, '')
  return appCssText
}

/** The chat's reply text (MessageParts' TextPartView), a few resets the app's base layer gives, and the ready-made boxes. */
const FRAME_CSS = `
  *, ::before, ::after { box-sizing: border-box; margin: 0; padding: 0; border: 0 solid; }
  html { color-scheme: light; } html.dark { color-scheme: dark; }
  html, body { background: transparent; overflow: hidden; }
  body { font-size: 14px; line-height: 1.625; color: var(--color-text); -webkit-font-smoothing: antialiased; }
  .acb-root { display: flow-root; max-width: none; overflow-wrap: break-word; }
  .acb-root > .acb-piece:first-child > :first-child { margin-top: 0 }
  .acb-root > .acb-piece:last-child > :last-child { margin-bottom: 0 }
  img, svg { max-width: 100%; height: auto; }
  table { border-collapse: collapse; }
  summary { cursor: pointer; }
  a { color: var(--color-link); }
  :not(pre) > code { padding: 2px 4px; border-radius: var(--radius-small); background: var(--color-surface-sunken); font-size: .85em; }
  .acb-root :not(pre) > code::before, .acb-root :not(pre) > code::after { content: none; }
  .acb-note, .acb-warn, .acb-ok, .acb-key { border: 1px solid; border-radius: var(--radius-card); padding: var(--space-2) var(--space-3); margin: .6em 0 }
  .acb-note { background: var(--color-info-bg); border-color: var(--color-info-border); color: var(--color-info-text) }
  .acb-warn { background: var(--color-warning-bg); border-color: var(--color-warning-border); color: var(--color-warning-text) }
  .acb-ok { background: var(--color-success-bg); border-color: var(--color-success-border); color: var(--color-success-text) }
  .acb-key { background: var(--color-ai-bg); border-color: var(--color-ai-border); color: var(--color-ai-text) }
  .acb-note > :first-child, .acb-warn > :first-child, .acb-ok > :first-child, .acb-key > :first-child { margin-top: 0 }
  .acb-note > :last-child, .acb-warn > :last-child, .acb-ok > :last-child, .acb-key > :last-child { margin-bottom: 0 }
  .acb-muted { color: var(--color-text-muted) }
  ol.acb-steps { list-style: none; counter-reset: step; padding-left: 0 }
  ol.acb-steps > li { counter-increment: step; position: relative; padding-left: 2.2em }
  ol.acb-steps > li::before { content: counter(step); position: absolute; left: 0; top: .1em; width: 1.6em; height: 1.6em;
    border-radius: 50%; background: var(--color-primary); color: var(--color-on-primary); font-size: .85em; font-weight: 600;
    display: flex; align-items: center; justify-content: center }
  ol.acb-steps details > summary { font-weight: 600 }
  ol.acb-steps details > :not(summary) { color: var(--color-text-muted) }
  table.acb-compare .best { background: var(--color-selected-bg) }
  .acb-yes { color: var(--color-success-text); font-weight: 700 } .acb-mid { color: var(--color-warning-text); font-weight: 700 }
  .acb-no { color: var(--color-danger-text); font-weight: 700 }
  .acb-tabs { margin: .6em 0 }
  .acb-tabs > input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0 }
  .acb-tabs > label { display: inline-block; padding: 4px 12px; border-bottom: 2px solid transparent; cursor: pointer; color: var(--color-text-muted); font-weight: 600 }
  .acb-tabs > input:checked + label { color: var(--color-text); border-bottom-color: var(--color-primary) }
  .acb-tabs > input:focus-visible + label { outline: 2px solid var(--color-focus-ring); outline-offset: 2px; border-radius: var(--radius-small) }
  .acb-tabs > .acb-tab { display: none; border-top: 1px solid var(--color-border); padding-top: var(--space-2) }
  .acb-tabs > input:nth-of-type(1):checked ~ .acb-tab:nth-of-type(1), .acb-tabs > input:nth-of-type(2):checked ~ .acb-tab:nth-of-type(2),
  .acb-tabs > input:nth-of-type(3):checked ~ .acb-tab:nth-of-type(3), .acb-tabs > input:nth-of-type(4):checked ~ .acb-tab:nth-of-type(4),
  .acb-tabs > input:nth-of-type(5):checked ~ .acb-tab:nth-of-type(5) { display: block }
  .acb-tip { position: relative; border-bottom: 1px dotted var(--color-text-muted); cursor: help }
  .acb-tip > .acb-tip-text { display: none; position: absolute; left: 0; top: 1.6em; z-index: 1; width: max-content; max-width: 240px;
    background: var(--color-surface-raised); color: var(--color-text); border: 1px solid var(--color-border); border-radius: var(--radius-control);
    padding: 6px 10px; font-size: var(--font-size-small); font-weight: 400; box-shadow: var(--shadow-pop) }
  .acb-tip:hover > .acb-tip-text { display: block }
  .acb-bar { height: 10px; border-radius: 999px; background: var(--color-surface-sunken); overflow: hidden }
  .acb-bar > span { display: block; height: 100%; border-radius: 999px; background: var(--color-primary); animation: acb-grow .8s ease-out }
  @keyframes acb-grow { from { width: 0 } }
  .acb-slide { width: 100%; aspect-ratio: 16 / 9; overflow: hidden; position: relative; border-radius: var(--radius-card); margin: .6em 0; container-type: inline-size }
  .acb-slide-inner { width: ${SLIDE_WIDTH}px; height: ${SLIDE_HEIGHT}px; overflow: hidden; transform-origin: 0 0; transform: scale(calc(100cqw / ${SLIDE_WIDTH}px)) }
`

/**
 * The frame's whole document: its policy first (before anything of the reply is read), the app's look, then the
 * reply's own CSS in a <style> of its own (it cannot reach into ours), then the reply.
 */
export function frameDocument({ body, css }: FrameContent, isDark: boolean): string {
  const font = getComputedStyle(document.body).fontFamily.replace(/[<>{};]/g, '')
  return `<!doctype html><html lang="ja"${isDark ? ' class="dark"' : ''}><head>`
    + `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><meta charset="utf-8">`
    // No name lookups ahead of a press for the links' hosts (Blink does that on http pages).
    + '<meta http-equiv="x-dns-prefetch-control" content="off"><base target="_blank">'
    + `<style>${appCss()}\nbody { font-family: ${font}; }\n${FRAME_CSS}</style><style>${css}</style></head>`
    + `<body><div class="acb-root ${CHAT_MARKDOWN_CLASS}">${body}</div></body></html>`
}

/** A frame the member sees, before its document is given (hidden until it has drawn). */
export function shownFrame(height: number, isDark: boolean): HTMLIFrameElement {
  const frame = document.createElement('iframe')
  // sandbox before srcdoc: the document is never parsed without it.
  frame.setAttribute('sandbox', SHOWN_FRAME_SANDBOX)
  frame.setAttribute('title', 'AI の返事')
  frame.setAttribute('scrolling', 'no')
  frame.dataset.richReplyFrame = ''
  frame.style.cssText = `position:absolute;left:0;top:0;width:100%;border:0;background:transparent;visibility:hidden;color-scheme:${isDark ? 'dark' : 'light'};height:${height}px`
  return frame
}

// --- the hidden copy that is measured ------------------------------------------------------------------------------

let measurer: Promise<HTMLIFrameElement> | null = null
let measurerFrame: HTMLIFrameElement | null = null
let queue: Promise<unknown> = Promise.resolve()

function measureFrame(): Promise<HTMLIFrameElement> {
  // Made again if it was taken out of the page (a measure there would read 0 and hide the reply).
  if (measurer && measurerFrame?.isConnected) return measurer
  measurer = new Promise(resolve => {
    const frame = document.createElement('iframe')
    // sandbox before srcdoc: the document is never parsed without it.
    frame.setAttribute('sandbox', MEASURE_FRAME_SANDBOX)
    frame.setAttribute('aria-hidden', 'true')
    frame.setAttribute('tabindex', '-1')
    frame.setAttribute('inert', '')
    frame.dataset.richReplyMeasure = ''
    frame.style.cssText = 'position:fixed;left:-20000px;top:0;height:100px;border:0;visibility:hidden;pointer-events:none'
    frame.onload = () => resolve(frame)
    frame.srcdoc = frameDocument({ body: '', css: '' }, false)
    measurerFrame = frame
    document.body.append(frame)
  })
  return measurer
}

/** At most this many inputs are tried per reply, and only once it is written (see `tallestState`): the layouts run on the app's thread. */
const MAX_INPUTS = 24

export interface ReplyHeight {
  /** As written: nothing opened or switched. */
  shown: number
  /** The tallest it becomes when the member opens or switches what it holds. */
  tallest: number
}

/**
 * The tallest the reply can become when the member opens or switches what it holds — every `<details>` open, every
 * check box either way, each choice of each radio group —, as the shown frame cannot tell the chat it grew.
 */
function tallestState(root: HTMLElement, shown: number): number {
  const measure = () => Math.ceil(root.getBoundingClientRect().height)
  const details = Array.from(root.querySelectorAll('details'))
  const inputs = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="checkbox"], input[type="radio"]')).slice(0, MAX_INPUTS)
  const boxes = inputs.filter(input => input.type === 'checkbox')
  const radios = inputs.filter(input => input.type === 'radio')
  if (!details.length && !inputs.length) return shown
  let tallest = shown
  for (const d of details) d.open = true
  for (const checked of [true, false]) {
    for (const box of boxes) box.checked = checked
    tallest = Math.max(tallest, measure())
    // Each choice in turn (a choice unchecks the rest of its group).
    for (const radio of radios) {
      radio.checked = true
      tallest = Math.max(tallest, measure())
    }
  }
  return tallest
}

/**
 * How tall `content` is at `width` in the app's theme — as written, and (`settled`: the reply is written) at its
 * tallest —, laid out in the hidden copy (its pictures decoded first), which is emptied again afterwards. One at a
 * time. The copy is never pressed or hovered (inert, off screen) and runs nothing (no `allow-scripts`, and the policy).
 */
export function measureReply(content: FrameContent, width: number, isDark: boolean, settled: boolean): Promise<ReplyHeight | null> {
  const run = async (): Promise<ReplyHeight | null> => {
    const frame = await measureFrame()
    const doc = frame.contentDocument
    const root = doc?.querySelector<HTMLElement>('.acb-root')
    const styles = doc?.querySelectorAll('style')
    if (!doc || !root || !styles || styles.length < 2) return null
    frame.style.width = `${Math.max(1, Math.round(width))}px`
    doc.documentElement.classList.toggle('dark', isDark)
    styles[styles.length - 1].textContent = content.css
    root.innerHTML = content.body
    try {
      await Promise.all(Array.from(root.querySelectorAll('img')).map(img => img.decode().catch(() => undefined)))
      const shown = Math.ceil(root.getBoundingClientRect().height)
      return { shown, tallest: settled ? tallestState(root, shown) : shown }
    } finally {
      root.replaceChildren()
      styles[styles.length - 1].textContent = ''
    }
  }
  const result = queue.then(run, run)
  queue = result.catch(() => undefined)
  return result
}
