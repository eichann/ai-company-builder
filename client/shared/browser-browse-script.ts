/**
 * The scripts the window runs for the operator's window tools (agent-browser.md "The operator's window tools"), in an
 * **isolated world** of the window's main frame (`executeJavaScriptInIsolatedWorld`): they share the page's DOM but not its
 * JavaScript, so the page's script can neither see the element list kept there nor replace the functions used. Plain
 * strings (never a function's `toString()`, which a bundler may rewrite). Pure: the shell (electron/browser-window.ts)
 * runs them; numbers and texts put into them are checked by the caller and written with `JSON.stringify`.
 *
 * - The snapshot keeps the usable elements in `window.__acbBrowse` (the isolated world's own global) and answers JSON:
 *   the address, the title, the visible text (`innerText`, bounded) and the elements — visible ones only, a password
 *   field's value never read, a text field named by its label / placeholder only (never by what is in it) — and, as role
 *   `item`, elements that act as controls without being one (a click handler, a pointer cursor, a list or tree item under a
 *   clickable list); each with where it is on the screen (`box`) for the numbered marks of the operator's screen image.
 * - The element scripts find an element by its number in that list, and answer null when it is gone (another page).
 */
import { BROWSER_BROWSE_LIMITS as L } from './browser-browse'

/** The isolated world the window's scripts run in (one number, never the page's own world 0). */
export const BROWSER_BROWSE_WORLD = 1207

export const BROWSER_SNAPSHOT_SCRIPT = `(() => {
  const MAX_TEXT = ${L.pageText + 1}, MAX_EL = ${L.elements}, MAX_NAME = ${L.name}, MAX_OPTIONS = ${L.options}
  const MAX_CLICKABLE = ${L.clickables}, MAX_SCAN = ${L.clickableScan}
  const vw = window.innerWidth, vh = window.innerHeight
  const refs = []
  window.__acbBrowse = refs
  const clean = s => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().slice(0, MAX_NAME)
  const visible = el => {
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none'
  }
  // Where the element is on the screen now (CSS pixels of the viewport), or null when none of it is on screen: the
  // numbered marks drawn on the operator's screen image.
  const boxOf = el => {
    const r = el.getBoundingClientRect()
    if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return null
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]
  }
  const roleOf = el => {
    const tag = el.tagName.toLowerCase()
    const aria = (el.getAttribute('role') || '').toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'select') return 'select'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase()
      if (t === 'password') return 'password'
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      if (['submit', 'button', 'reset', 'image'].includes(t)) return 'button'
      if (['file', 'hidden', 'range', 'color'].includes(t)) return 'other'
      return 'textbox'
    }
    if (tag === 'button' || tag === 'summary') return 'button'
    if (['link', 'button', 'tab', 'checkbox', 'radio', 'option'].includes(aria)) return aria
    if (aria === 'menuitem') return 'button'
    if (el.isContentEditable) return 'textbox'
    return 'other'
  }
  const labelOf = el => {
    const aria = el.getAttribute('aria-label')
    if (aria) return aria
    const by = el.getAttribute('aria-labelledby')
    if (by) { const t = by.split(/\\s+/).map(id => { const x = document.getElementById(id); return x ? x.innerText : '' }).join(' '); if (t.trim()) return t }
    if (el.labels && el.labels.length > 0) return el.labels[0].innerText
    return ''
  }
  const nameOf = (el, role) => {
    const label = labelOf(el)
    if (label) return clean(label)
    if (role === 'textbox' || role === 'password' || role === 'select' || role === 'checkbox' || role === 'radio') {
      return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '')
    }
    if (el.tagName.toLowerCase() === 'input') return clean(role === 'button' ? (el.value || el.getAttribute('alt') || el.getAttribute('title') || '') : (el.getAttribute('alt') || el.getAttribute('title') || ''))
    return clean(el.innerText || el.getAttribute('title') || el.getAttribute('alt') || '')
  }
  // The run log's label (never what the operator sees as a name): the recording's rules (shared/browser-recorder.ts,
  // BROWSER_RECORDING_SCRIPT, independent review of #846) — a field's own aria-label, <label> words, placeholder or title;
  // a native button's own text only when it holds few elements; anything else only its aria-label or title; nothing from a
  // row, a list item or a cell, or an element holding many others. A page's data never becomes a stored label.
  const SMALL = 8
  const rowLike = el => el.matches('tr, td, th, li, [role=row], [role=gridcell], [role=cell], [role=listitem], [role=option], [role=menuitem]')
  const ownText = label => { const c = label.cloneNode(true); c.querySelectorAll('input, select, textarea, option, datalist').forEach(n => n.remove()); return c.textContent || '' }
  const fieldLabel = el => clean(el.getAttribute('aria-label') || (el.labels && el.labels[0] && ownText(el.labels[0])) || el.getAttribute('placeholder') || el.getAttribute('title') || '')
  const nativeButton = el => el instanceof HTMLButtonElement || (el instanceof HTMLInputElement && /^(submit|button|reset|image)$/.test(el.type))
  const controlLabel = el => {
    if (el instanceof HTMLInputElement) return nativeButton(el) ? clean(el.getAttribute('aria-label') || el.value || el.getAttribute('title') || '') : fieldLabel(el)
    if (rowLike(el) || el.querySelectorAll('*').length > SMALL) return ''
    if (nativeButton(el)) return clean(el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || '')
    return clean(el.getAttribute('aria-label') || el.getAttribute('title') || '')
  }
  const logLabelOf = (el, role) => {
    if (role === 'link' || role === 'option') return ''
    if (['textbox', 'password', 'select', 'checkbox', 'radio'].includes(role) && !el.isContentEditable) return fieldLabel(el)
    return controlLabel(el)
  }
  const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=option],[contenteditable=""],[contenteditable=true]'
  const elements = []
  for (const el of document.querySelectorAll(sel)) {
    if (elements.length >= MAX_EL) break
    if (el.disabled || !visible(el)) continue
    const role = roleOf(el)
    // Never a hidden input, and never a file chooser (the operator must not open a dialog of this computer).
    if (el.tagName.toLowerCase() === 'input' && ['hidden', 'file'].includes((el.getAttribute('type') || '').toLowerCase())) continue
    const ref = refs.length
    refs.push(el)
    const item = { ref, role, name: nameOf(el, role), logLabel: logLabelOf(el, role) }
    if (role === 'link') item.href = el.href
    if (role === 'textbox' && !el.isContentEditable) item.value = clean(el.value)
    if (role === 'select') item.options = Array.from(el.options).slice(0, MAX_OPTIONS).map(o => clean(o.text))
    if (role === 'checkbox' || role === 'radio') item.checked = !!el.checked
    const box = boxOf(el)
    if (box) item.box = box
    elements.push(item)
  }
  // Elements that act as controls without being one (a folder tree's rows, a card with a click handler): role \`item\`.
  // Signs: an onclick attribute, tabindex >= 0, an interactive role the list above does not take, or the top of a
  // cursor:pointer subtree (cursor is inherited: only the outermost element of each subtree is a candidate, so a row and
  // each of its children are never all listed). A pointer subtree holding two or more list / tree items (event
  // delegation on the list) gives its items instead. Never one inside a real control listed above, never the page itself
  // or a container covering most of the screen, never one without its own words; each named by its own text only (a
  // nested item's text is the nested item's). Bounded: MAX_CLICKABLE of them, the page's first MAX_SCAN elements looked at.
  const listed = new Set(refs)
  const insideControl = el => { for (let p = el.parentElement; p; p = p.parentElement) if (listed.has(p)) return true; return false }
  const pointer = el => getComputedStyle(el).cursor === 'pointer'
  const ITEM = 'li, tr, [role=treeitem], [role=listitem], [role=row], [role=option], [role=menuitem]'
  const ownWords = el => {
    const c = el.cloneNode(true)
    c.querySelectorAll(ITEM + ', script, style, template, input, select, textarea, option').forEach(n => n.remove())
    return clean(c.textContent || '')
  }
  const candidates = []
  for (const el of document.querySelectorAll('[onclick], [tabindex]:not([tabindex^="-"]), [role=treeitem], [role=switch], [role=menuitemcheckbox], [role=menuitemradio]')) candidates.push(el)
  const all = document.body ? document.body.getElementsByTagName('*') : []
  for (let i = 0; i < all.length && i < MAX_SCAN; i++) {
    const el = all[i]
    if (pointer(el) && !(el.parentElement && pointer(el.parentElement))) {
      const items = Array.from(el.querySelectorAll(ITEM)).filter(visible)
      if (items.length >= 2) candidates.push(...items)
      else candidates.push(el)
    }
  }
  // In document order (an ancestor before what is inside it), each once.
  const ordered = Array.from(new Set(candidates)).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
  const picked = new Set()
  // Inside an element already picked: left out (its click is the picked one's), except an item inside an item (a tree's
  // folder inside its parent folder: each is its own target, named by its own words).
  const insidePicked = el => {
    for (let p = el.parentElement; p; p = p.parentElement) if (picked.has(p) && !(p.matches(ITEM) && el.matches(ITEM))) return true
    return false
  }
  let clickables = 0
  for (const el of ordered) {
    if (elements.length >= MAX_EL || clickables >= MAX_CLICKABLE) break
    if (listed.has(el) || el === document.body || el === document.documentElement) continue
    if (!visible(el) || insideControl(el) || insidePicked(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width * r.height > 0.4 * vw * vh) continue
    const name = ownWords(el) || clean(el.getAttribute('aria-label') || el.getAttribute('title') || '')
    if (!name) continue
    picked.add(el)
    clickables++
    const ref = refs.length
    refs.push(el)
    const item = { ref, role: 'item', name, logLabel: controlLabel(el) }
    const box = boxOf(el)
    if (box) item.box = box
    elements.push(item)
  }
  const text = document.body ? String(document.body.innerText || '') : ''
  return JSON.stringify({ address: location.href, title: document.title, text: text.slice(0, MAX_TEXT), truncated: text.length >= MAX_TEXT, elements, viewport: [vw, vh] })
})()`

const element = (ref: number) => `(window.__acbBrowse || [])[${JSON.stringify(ref)}]`

/**
 * Scrolls the element into view and answers its centre in the viewport (CSS pixels) as JSON, or null when it is gone —
 * after two frames, so the press lands on what is drawn (a page not drawn yet answers nothing and the press fails).
 */
export function browsePointScript(ref: number): string {
  return `(async () => {
  const el = ${element(ref)}
  if (!el || !el.isConnected) return null
  el.scrollIntoView({ block: 'center', inline: 'center' })
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  if (!el.isConnected) return null
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return null
  return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
})()`
}

/** Focuses a text field and selects what is in it (what is typed next replaces it); true, or null when it is gone. */
export function browseFocusScript(ref: number): string {
  return `(() => {
  const el = ${element(ref)}
  if (!el || !el.isConnected) return null
  el.scrollIntoView({ block: 'center', inline: 'center' })
  el.focus()
  if (typeof el.select === 'function') el.select()
  else if (el.isContentEditable) { const range = document.createRange(); range.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(range) }
  return document.activeElement === el
})()`
}

/** Chooses the option with exactly this text in a select, as a person would (input and change events); true or null. */
export function browseSelectScript(ref: number, option: string): string {
  return `(() => {
  const el = ${element(ref)}
  if (!el || !el.isConnected || el.tagName.toLowerCase() !== 'select') return null
  const want = ${JSON.stringify(option)}
  const found = Array.from(el.options).find(o => String(o.text).replace(/\\s+/g, ' ').trim() === want)
  if (!found) return null
  el.value = found.value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`
}
