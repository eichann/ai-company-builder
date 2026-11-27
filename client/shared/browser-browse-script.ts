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
 *   **Ordered before the cap** (production 2026-11-27: a row's popup menu, appended last in the page, got no ref): an open
 *   overlay's elements first (a menu, listbox, dialog, popover, a popper / portal container, a floating layer new since the
 *   previous snapshot), then what is on the screen, then the rest in document order, what is behind an open modal last;
 *   the refs follow that order, and an element an open overlay covers (or behind an open modal) gets no mark.
 * - The element scripts find an element by its number in that list, and answer null when it is gone (another page).
 */
import { BROWSER_BROWSE_LIMITS as L } from './browser-browse'

/** The isolated world the window's scripts run in (one number, never the page's own world 0). */
export const BROWSER_BROWSE_WORLD = 1207

export const BROWSER_SNAPSHOT_SCRIPT = `(() => {
  const MAX_TEXT = ${L.pageText + 1}, MAX_EL = ${L.elements}, MAX_NAME = ${L.name}, MAX_OPTIONS = ${L.options}
  const MAX_CLICKABLE = ${L.clickables}, MAX_SCAN = ${L.clickableScan}, MAX_POOL = ${L.elementPool}, SCAN_TAIL = ${L.scanTail}
  const vw = window.innerWidth, vh = window.innerHeight
  const refs = []
  window.__acbBrowse = refs
  // The positioned layers the previous snapshot of this document saw (null on its first: nothing counts as new then).
  const seenLayers = window.__acbLayers || null
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
  const rowLike = el => el.matches('tr, td, th, li, [role=row], [role=gridcell], [role=cell], [role=listitem], [role=option], [role=menuitem], [role=treeitem]')
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

  // ── What matters first (production 2026-11-27: a row's popup menu, appended last, got no ref past the cap) ──────────
  // Open overlays — menus, listboxes, dialogs, popovers, a popper or portal container, a positioned layer with a z-index
  // that was not there at the previous snapshot — come first; then what is on the screen; then the rest of the page in
  // document order; what sits behind an open modal last. The cap applies after this order.
  const positioned = cs => cs.position === 'fixed' || cs.position === 'absolute'
  const OVERLAY_ROLE = '[role=menu], [role=listbox], [role=dialog], [role=alertdialog], [aria-modal="true"], dialog[open], [popover]'
  const OVERLAY = OVERLAY_ROLE + ', [data-popper-placement], [class*="dropdown-menu"], [class*="popover"], [class*="popper"], [class*="menu__content"], [class*="portal"]'
  // A class-named container counts only when it floats (absolute / fixed): a trigger named like one does not.
  const overlayRoot = r => visible(r) && (r.matches(OVERLAY_ROLE) || positioned(getComputedStyle(r)))
  const overlayCache = new Map()
  const overlayOf = el => {
    if (overlayCache.has(el)) return overlayCache.get(el)
    let found = null
    for (let r = el.closest(OVERLAY); r; r = r.parentElement ? r.parentElement.closest(OVERLAY) : null) if (overlayRoot(r)) { found = r; break }
    overlayCache.set(el, found)
    return found
  }
  // The nearest absolute / fixed ancestor with a z-index above 0 (a floating layer), or null.
  const layerCache = new Map()
  const layerOf = el => {
    const path = []
    let found = null
    for (let p = el; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      if (layerCache.has(p)) { found = layerCache.get(p); break }
      path.push(p)
      const cs = getComputedStyle(p)
      if (positioned(cs) && cs.zIndex !== 'auto' && Number(cs.zIndex) > 0) { found = p; break }
    }
    for (const q of path) layerCache.set(q, found)
    return found
  }
  const layersNow = new Set()
  // Every shown floating layer the bounded scan met (also one with nothing usable in it): what the screen image shows.
  const floatLayers = new Set()
  const newLayer = el => { const l = layerOf(el); if (l) layersNow.add(l); return !!l && seenLayers !== null && !seenLayers.has(l) }
  const modals = []
  for (const m of document.querySelectorAll('[aria-modal="true"], dialog')) {
    let modal = m.getAttribute('aria-modal') === 'true'
    try { modal = modal || m.matches(':modal') } catch { /* an engine without :modal */ }
    if (modal && visible(m)) modals.push(m)
  }
  const overlayRoots = Array.from(document.querySelectorAll(OVERLAY)).filter(overlayRoot)
  // A list of the page's elements looked at in a bounded way: its first MAX_SCAN and its last SCAN_TAIL (a popup is
  // usually appended at the end of the page).
  const bounded = function* (list) {
    const n = list.length
    for (let i = 0; i < n && i < MAX_SCAN; i++) yield list[i]
    for (let i = Math.max(MAX_SCAN, n - SCAN_TAIL); i < n; i++) yield list[i]
  }

  const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=option],[contenteditable=""],[contenteditable=true]'
  const controls = []
  const listed = new Set()
  const takeControl = el => {
    if (listed.has(el) || controls.length >= MAX_POOL) return
    if (el.disabled || !visible(el)) return
    // Never a hidden input, and never a file chooser (the operator must not open a dialog of this computer).
    if (el.tagName.toLowerCase() === 'input' && ['hidden', 'file'].includes((el.getAttribute('type') || '').toLowerCase())) return
    listed.add(el)
    controls.push(el)
  }
  // An open overlay's controls first, so no bound of the page's size ever leaves them out.
  for (const root of overlayRoots) {
    if (root.matches(sel)) takeControl(root)
    for (const el of root.querySelectorAll(sel)) takeControl(el)
  }
  for (const el of bounded(document.querySelectorAll(sel))) takeControl(el)

  // Elements that act as controls without being one (a folder tree's rows, a card with a click handler): role \`item\`.
  // Signs: an onclick attribute, tabindex >= 0, an interactive role the list above does not take, or the top of a
  // cursor:pointer subtree (cursor is inherited: only the outermost element of each subtree is a candidate, so a row and
  // each of its children are never all listed). A pointer subtree holding two or more list / tree items (event
  // delegation on the list) gives its items instead. Never one inside a real control listed above, never the page itself
  // or a container covering most of the screen, never one without its own words; each named by its own text only (a
  // nested item's text is the nested item's). Bounded: the page's first MAX_SCAN and last SCAN_TAIL elements looked at,
  // and every open overlay's.
  const insideControl = el => { for (let p = el.parentElement; p; p = p.parentElement) if (listed.has(p)) return true; return false }
  const pointer = el => getComputedStyle(el).cursor === 'pointer'
  const ITEM = 'li, tr, [role=treeitem], [role=listitem], [role=row], [role=option], [role=menuitem]'
  // Its own words: the text under it, a nested item's, a script's or a field's left out — read in place (never a copy:
  // copying would run a custom element's constructor and start its images loading; independent review).
  const NOT_OWN = ITEM + ', script, style, template, input, select, textarea, option'
  const ownWords = el => {
    let out = ''
    const walk = node => {
      for (const c of node.childNodes) {
        if (out.length > MAX_NAME * 4) return
        if (c.nodeType === 3) out += c.nodeValue
        else if (c.nodeType === 1 && !c.matches(NOT_OWN)) walk(c)
      }
    }
    walk(el)
    return clean(out)
  }
  const MARKED = '[onclick], [tabindex]:not([tabindex^="-"]), [role=treeitem], [role=switch], [role=menuitemcheckbox], [role=menuitemradio]'
  const candidates = []
  const pointerTop = el => {
    const cs = getComputedStyle(el)
    if (positioned(cs) && cs.zIndex !== 'auto' && Number(cs.zIndex) > 0 && visible(el)) floatLayers.add(el)
    if (cs.cursor === 'pointer' && !(el.parentElement && pointer(el.parentElement))) {
      const items = Array.from(el.querySelectorAll(ITEM)).slice(0, MAX_CLICKABLE * 2).filter(visible)
      if (items.length >= 2) candidates.push(...items)
      else candidates.push(el)
    }
  }
  for (const root of overlayRoots) {
    if (root.matches(MARKED)) candidates.push(root)
    for (const el of bounded(root.querySelectorAll(MARKED))) candidates.push(el)
    pointerTop(root)
    for (const el of bounded(root.getElementsByTagName('*'))) pointerTop(el)
  }
  for (const el of bounded(document.querySelectorAll(MARKED))) candidates.push(el)
  for (const el of bounded(document.body ? document.body.getElementsByTagName('*') : [])) pointerTop(el)
  const before = (a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
  // In document order (an ancestor before what is inside it), each once.
  const ordered = Array.from(new Set(candidates)).sort(before)
  const picked = new Set()
  // Inside an element already picked: left out (its click is the picked one's), except an item inside an item (a tree's
  // folder inside its parent folder: each is its own target, named by its own words).
  const insidePicked = el => {
    for (let p = el.parentElement; p; p = p.parentElement) if (picked.has(p) && !(p.matches(ITEM) && el.matches(ITEM))) return true
    return false
  }
  const items = []
  for (const el of ordered) {
    if (items.length >= MAX_POOL) break
    if (listed.has(el) || el === document.body || el === document.documentElement) continue
    // A native control the list above left out on purpose (a file chooser, a hidden or disabled one) stays out.
    if (el.matches('input, select, textarea, button, option, a[href], [disabled]')) continue
    if (!visible(el) || insideControl(el) || insidePicked(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width * r.height > 0.4 * vw * vh) continue
    const name = ownWords(el) || clean(el.getAttribute('aria-label') || el.getAttribute('title') || '')
    if (!name) continue
    picked.add(el)
    items.push({ el, name })
  }

  // The order, then the cap: tier 0 an open overlay's (or a layer new since the previous snapshot), 1 on the screen, 2
  // the rest, 3 behind an open modal; document order within a tier. At most MAX_EL, of them at most MAX_CLICKABLE items.
  const tierOf = el => {
    const fresh = newLayer(el)
    if (overlayOf(el) || fresh) return 0
    if (modals.length > 0 && !modals.some(m => m.contains(el))) return 3
    return boxOf(el) ? 1 : 2
  }
  const pool = controls.map(el => ({ el, item: null, tier: tierOf(el) })).concat(items.map(it => ({ el: it.el, item: it, tier: tierOf(it.el) })))
  pool.sort((a, b) => a.tier - b.tier || before(a.el, b.el))
  const chosen = []
  let clickables = 0
  for (const c of pool) {
    if (chosen.length >= MAX_EL) break
    if (c.item) { if (clickables >= MAX_CLICKABLE) continue; clickables++ }
    chosen.push(c)
  }
  // A mark only where the element can be seen: none behind an open modal, none where an open overlay covers its centre.
  const overlayOpen = pool.some(c => c.tier === 0)
  const shownBox = c => {
    const box = boxOf(c.el)
    if (!box || c.tier === 3) return null
    if (c.tier !== 0 && overlayOpen) {
      const x = Math.min(Math.max(box[0] + box[2] / 2, 0), vw - 1), y = Math.min(Math.max(box[1] + box[3] / 2, 0), vh - 1)
      const top = document.elementFromPoint(x, y)
      if (top && top !== c.el && !c.el.contains(top) && !top.contains(c.el) && (overlayOf(top) || (layerOf(top) && seenLayers !== null && !seenLayers.has(layerOf(top))))) return null
    }
    return box
  }
  const elements = []
  for (const c of chosen) {
    const el = c.el
    const ref = refs.length
    refs.push(el)
    let item
    if (c.item) item = { ref, role: 'item', name: c.item.name, logLabel: controlLabel(el) }
    else {
      const role = roleOf(el)
      item = { ref, role, name: nameOf(el, role), logLabel: logLabelOf(el, role) }
      if (role === 'link') item.href = el.href
      if (role === 'textbox' && !el.isContentEditable) item.value = clean(el.value)
      if (role === 'select') item.options = Array.from(el.options).slice(0, MAX_OPTIONS).map(o => clean(o.text))
      if (role === 'checkbox' || role === 'radio') item.checked = !!el.checked
    }
    const box = shownBox(c)
    if (box) item.box = box
    elements.push(item)
  }
  for (const l of layersNow) floatLayers.add(l)
  window.__acbLayers = new WeakSet(floatLayers)

  // ── The hit-test of a press by position and of typing without a ref (browseAimScript; agent-browser.md "Pressing by
  // position"): the same rules as this list, against the layout this snapshot — and the screen image made right after
  // it — showed. Kept in the isolated world (the page's script cannot see or replace it).
  const shownAt = { sx: window.scrollX, sy: window.scrollY, vw, vh, roots: overlayRoots.slice(), layers: floatLayers,
    boxes: chosen.filter(c => boxOf(c.el)).map(c => [c.el, c.el.getBoundingClientRect()]) }
  const near = (a, b) => Math.abs(a - b) <= 2
  // The page moved since: scrolled, resized, an overlay opened or closed, or an element shown on the screen moved or went.
  const moved = () => {
    if (window.scrollX !== shownAt.sx || window.scrollY !== shownAt.sy || window.innerWidth !== shownAt.vw || window.innerHeight !== shownAt.vh) return true
    for (const [el, r] of shownAt.boxes) {
      if (!el.isConnected) return true
      const n = el.getBoundingClientRect()
      if (!near(n.left, r.left) || !near(n.top, r.top) || !near(n.width, r.width) || !near(n.height, r.height)) return true
    }
    const roots = Array.from(document.querySelectorAll(OVERLAY)).filter(overlayRoot)
    return roots.length !== shownAt.roots.length || roots.some(r => !shownAt.roots.includes(r))
  }
  const FRAME = 'iframe, frame, object, embed'
  const fileField = el => el.matches('input') && (el.getAttribute('type') || '').toLowerCase() === 'file'
  const no = why => ({ ok: false, why })
  const itemSet = new Set(items.map(it => it.el))
  const aimAt = (x, y) => {
    if (!(x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight)) return no('outside')
    if (moved()) return no('moved')
    // The page now, not the snapshot's cached ancestry: an element that became a floating layer since must be seen as one
    // (Codex review).
    layerCache.clear()
    overlayCache.clear()
    const top = document.elementFromPoint(x, y)
    if (!top || top === document.documentElement || top === document.body) return no('nothing')
    // A floating layer the screen image did not show (appeared since): the point may be on something else now.
    const layer = layerOf(top)
    if (layer && !shownAt.layers.has(layer)) return no('moved')
    if (top.closest(FRAME)) return no('frame')
    if (fileField(top) || top.closest('input[type=file i]')) return no('file')
    const label = top.closest('label')
    if (label && label.control && fileField(label.control)) return no('file')
    let target = null
    for (let p = top; p && !target; p = p.parentElement) if (listed.has(p) || itemSet.has(p)) target = p
    if (!target) target = top.closest(sel) || top
    if (fileField(target)) return no('file')
    const role = listed.has(target) || target.matches(sel) ? roleOf(target) : 'item'
    return { ok: true, role, logLabel: role === 'item' ? controlLabel(target) : logLabelOf(target, role) }
  }
  const aimFocus = () => {
    const a = document.activeElement
    if (!a || a === document.body || a === document.documentElement) return no('nothing')
    if (a.matches(FRAME)) return no('frame')
    if (fileField(a)) return no('file')
    const role = roleOf(a)
    if (role === 'password') return no('password')
    if (role !== 'textbox' || a.disabled || a.readOnly) return no('not-editable')
    return { ok: true, role, logLabel: logLabelOf(a, role) }
  }
  window.__acbAim = { at: aimAt, focus: aimFocus }
  const text = document.body ? String(document.body.innerText || '') : ''
  return JSON.stringify({ address: location.href, title: document.title, text: text.slice(0, MAX_TEXT), truncated: text.length >= MAX_TEXT, elements, omitted: pool.length - chosen.length, viewport: [vw, vh] })
})()`

/**
 * The hit-test of a press by position (a point of the viewport, CSS pixels) or of typing without a ref (the focused
 * element), run in the isolated world against the last snapshot (`window.__acbAim`, made by `BROWSER_SNAPSHOT_SCRIPT`);
 * answers `{ ok, role, logLabel }` or `{ ok: false, why }` as JSON. Null for an action that is neither.
 */
export function browseAimScript(action: { do: string; x?: number; y?: number; ref?: number }): string | null {
  let call: string
  if (action.do === 'click' && action.ref === undefined && Number.isFinite(action.x) && Number.isFinite(action.y)) call = `a.at(${JSON.stringify(action.x)}, ${JSON.stringify(action.y)})`
  else if (action.do === 'type' && action.ref === undefined) call = 'a.focus()'
  else return null
  return `(() => {
  const a = window.__acbAim
  if (!a) return JSON.stringify({ ok: false, why: 'nothing' })
  try { return JSON.stringify(${call}) } catch { return JSON.stringify({ ok: false, why: 'nothing' }) }
})()`
}

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
