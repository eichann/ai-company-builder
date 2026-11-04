/**
 * A Google Doc from the Docs API (`documents.get` with `includeTabsContent`) as plain text
 * (minutes.md "The text"): headings, lists, tables and every tab, in document order. Pure; the
 * text is handed over like the export's, never stored or logged.
 */
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** One element of a paragraph: its run of text, or what a smart chip shows. */
function elementText(e: unknown): string {
  if (!isObj(e)) return ''
  if (isObj(e.textRun)) return str(e.textRun.content)
  if (isObj(e.person) && isObj(e.person.personProperties)) return str(e.person.personProperties.name) || str(e.person.personProperties.email)
  if (isObj(e.richLink) && isObj(e.richLink.richLinkProperties)) return str(e.richLink.richLinkProperties.title)
  if (isObj(e.dateElement) && isObj(e.dateElement.dateElementProperties)) return str(e.dateElement.dateElementProperties.displayText)
  return ''
}

function paragraphText(p: Record<string, unknown>): string {
  const text = list(p.elements).map(elementText).join('')
  return isObj(p.bullet) ? `・${text}` : text
}

/** A table, a row per line and cells apart by a tab (what the plain-text export gives). */
function tableText(t: Record<string, unknown>): string {
  return list(t.tableRows).map(row => list(isObj(row) ? row.tableCells : null)
    .map(cell => contentText(isObj(cell) ? cell.content : null).trim().replace(/\s*\n\s*/g, ' ')).join('\t')).join('\n') + '\n'
}

function contentText(content: unknown): string {
  return list(content).map(el => {
    if (!isObj(el)) return ''
    if (isObj(el.paragraph)) return paragraphText(el.paragraph)
    if (isObj(el.table)) return tableText(el.table)
    return '' // A table of contents repeats the headings; a section break has no text.
  }).join('')
}

function flatTabs(tabs: unknown): Array<{ title: string; text: string }> {
  return list(tabs).flatMap(tab => {
    if (!isObj(tab)) return []
    const body = isObj(tab.documentTab) && isObj(tab.documentTab.body) ? tab.documentTab.body : null
    const title = isObj(tab.tabProperties) ? str(tab.tabProperties.title) : ''
    return [{ title, text: contentText(body?.content) }, ...flatTabs(tab.childTabs)]
  })
}

/** Every tab's text; with more than one, each under its name (Gemini's notes keep the transcript in a tab). */
export function docsBodyText(doc: unknown): string {
  if (!isObj(doc)) return ''
  const tabs = flatTabs(doc.tabs).filter(t => t.text.trim() !== '')
  if (tabs.length === 0) return isObj(doc.body) ? contentText(doc.body.content) : ''
  if (tabs.length === 1) return tabs[0].text
  return tabs.map(t => `【${t.title}】\n${t.text.trimEnd()}\n`).join('\n')
}
