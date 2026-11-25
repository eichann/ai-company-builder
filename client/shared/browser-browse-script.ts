/**
 * The scripts the window runs for the operator's window tools (agent-browser.md "The operator's window tools"), in an
 * **isolated world** of the window's main frame (`executeJavaScriptInIsolatedWorld`): they share the page's DOM but not its
 * JavaScript, so the page's script can neither see the element list kept there nor replace the functions used. Plain
 * strings (never a function's `toString()`, which a bundler may rewrite). Pure: the shell (electron/browser-window.ts)
 * runs them; numbers and texts put into them are checked by the caller and written with `JSON.stringify`.
 *
 * - The snapshot keeps the usable elements in `window.__acbBrowse` (the isolated world's own global) and answers JSON:
 *   the address, the title, the visible text (`innerText`, bounded) and the elements — visible ones only, a password
 *   field's value never read, a text field named by its label / placeholder only (never by what is in it).
 * - The element scripts find an element by its number in that list, and answer null when it is gone (another page).
 */
import { BROWSER_BROWSE_LIMITS as L } from './browser-browse'

/** The isolated world the window's scripts run in (one number, never the page's own world 0). */
export const BROWSER_BROWSE_WORLD = 1207

export const BROWSER_SNAPSHOT_SCRIPT = `(() => {
  const MAX_TEXT = ${L.pageText + 1}, MAX_EL = ${L.elements}, MAX_NAME = ${L.name}, MAX_OPTIONS = ${L.options}
  const refs = []
  window.__acbBrowse = refs
  const clean = s => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().slice(0, MAX_NAME)
  const visible = el => {
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none'
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
    if (el.tagName.toLowerCase() === 'input') return clean(el.value || el.getAttribute('alt') || el.getAttribute('title') || '')
    return clean(el.innerText || el.getAttribute('title') || el.getAttribute('alt') || '')
  }
  const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=option],[contenteditable=""],[contenteditable=true]'
  const elements = []
  for (const el of document.querySelectorAll(sel)) {
    if (elements.length >= MAX_EL) break
    if (el.disabled || !visible(el)) continue
    const role = roleOf(el)
    if (el.tagName.toLowerCase() === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') continue
    const ref = refs.length
    refs.push(el)
    const item = { ref, role, name: nameOf(el, role) }
    if (role === 'link') item.href = el.href
    if (role === 'textbox' && !el.isContentEditable) item.value = clean(el.value)
    if (role === 'select') item.options = Array.from(el.options).slice(0, MAX_OPTIONS).map(o => clean(o.text))
    if (role === 'checkbox' || role === 'radio') item.checked = !!el.checked
    elements.push(item)
  }
  const text = document.body ? String(document.body.innerText || '') : ''
  return JSON.stringify({ address: location.href, title: document.title, text: text.slice(0, MAX_TEXT), truncated: text.length >= MAX_TEXT, elements })
})()`

const element = (ref: number) => `(window.__acbBrowse || [])[${JSON.stringify(ref)}]`

/** Scrolls the element into view and answers its centre in the viewport (CSS pixels) as JSON, or null when it is gone. */
export function browsePointScript(ref: number): string {
  return `(() => {
  const el = ${element(ref)}
  if (!el || !el.isConnected) return null
  el.scrollIntoView({ block: 'center', inline: 'center' })
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
