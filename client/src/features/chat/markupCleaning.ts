// The one walk that cuts markup the AI wrote down to what its allowlist keeps (chat-ui-and-history.md "Cleaning the
// AI's markup"). Two allowlists use it: a reply's picture (svgCleaning.ts `sanitizeSvg`, "Diagrams in a reply") and a
// reply's HTML (replyHtmlCleaning.ts `sanitizeReplyHtml`, "Rich replies"). What both hold, kept here once:
//   - the text is parsed in an inert DOMParser document: nothing in it runs or loads while it is cut;
//   - comments and processing instructions go; no event handler (`on*`) survives, whatever the allowlist says;
//   - every other element and attribute is kept only when the allowlist's rules say so;
//   - what in CSS loads or runs something (`cssLoadsOrRuns`).
// The rules decide only what to keep; the walk is the same for both, so a gap fixed here is fixed for both.

export const SVG_NS = 'http://www.w3.org/2000/svg'
export const HTML_NS = 'http://www.w3.org/1999/xhtml'

/** The AI's text as an inert document (scripting off, no browsing context: nothing runs or loads). */
export function parseInert(markup: string): Document {
  return new DOMParser().parseFromString(markup, 'text/html')
}

/** What happens to one element. */
export type ElementFate =
  /** Kept; its attributes and children are cleaned. */
  | 'keep'
  /** Its children (cleaned) take its place: the words stay, the element goes. */
  | 'unwrap'
  /** Removed with everything inside. */
  | 'remove'
  /** Another element takes its place: cleaned like a kept one, or (`clean: false`) already clean as it is. */
  | { replace: Element; clean: boolean }

export interface CleaningRules {
  /** The fate of an element inside the root (the root itself is always kept). */
  element(element: Element): ElementFate
  /**
   * The value a kept element keeps for one attribute (`name` lower case), or null to take it off. Never asked for
   * an `on*` attribute: those always go.
   */
  attribute(element: Element, name: string, value: string): string | null
  /** A kept element's last check once its inside is clean (a <style>'s text); false removes it. */
  finish?(element: Element): boolean
}

/** Cleans `root`'s attributes and everything inside it, in place, by `rules`. */
export function cleanTree(root: Element, rules: CleaningRules): void {
  cleanAttributes(root, rules)
  cleanChildren(root, rules)
}

function cleanChildren(parent: Element, rules: CleaningRules): void {
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === Node.TEXT_NODE) continue
    if (node.nodeType !== Node.ELEMENT_NODE) { node.remove(); continue }
    const element = node as Element
    const fate = rules.element(element)
    if (fate === 'remove') { element.remove(); continue }
    if (fate === 'unwrap') {
      cleanChildren(element, rules)
      element.replaceWith(...element.childNodes)
      continue
    }
    const kept = fate === 'keep' ? element : fate.replace
    if (kept !== element) element.replaceWith(kept)
    if (fate !== 'keep' && !fate.clean) continue
    cleanAttributes(kept, rules)
    cleanChildren(kept, rules)
    if (rules.finish && !rules.finish(kept)) kept.remove()
  }
}

function cleanAttributes(element: Element, rules: CleaningRules): void {
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase()
    const value = name.startsWith('on') ? null : rules.attribute(element, name, attribute.value)
    if (value === null) element.removeAttribute(attribute.name)
    else if (value !== attribute.value) element.setAttribute(attribute.name, value)
  }
}

// --- references and CSS ------------------------------------------------------------------------------------------

/** A reference to something inside the same markup (`#id`), the only kind a picture keeps. */
export const isLocalReference = (value: string) => /^#[\w:.-]*$/.test(value.trim())

/** A url() that is not a reference inside the markup (`url(#id)`). */
export const OUTSIDE_URL = /url\s*\(\s*(?!['"]?#)/i
/** CSS that could load or hide something: imports, fonts, escapes (which can spell any of these), other image functions. */
const UNSAFE_CSS = /@import|@font-face|image-set|image\s*\(|expression\s*\(|javascript:|\\/i

/** CSS text (a rule, a value, a whole sheet) that loads or runs something; read as written, escapes refused. */
export const cssLoadsOrRuns = (css: string) => OUTSIDE_URL.test(css) || UNSAFE_CSS.test(css)
