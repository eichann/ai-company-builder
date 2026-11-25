/**
 * What the consultation AI is told it may ask of 「ブラウザ操作」 (agent-browser.md "Who may use a site", "The tools'
 * words"; design memo §3 I10). The tools' own descriptions, schemas and refusal words are shared by every company and
 * hold no site, job or field word; the list of what can be asked is built here at run time from the site data this build
 * carries (the opened lines, their sites' reviewed declarations), handed in by the wiring. A build without a site's data
 * tells the AI of none.
 *
 * Pure (client/shared): no Electron, no site.
 */
import type { BrowserOpenedLine } from '../../shared/core/browser-opened'

/** A site as its reviewed declaration names it. */
export interface BrowserCatalogSite { id: string; label: string }

/** What the AI is told when nothing can be asked (the tool exists only while the switch is on). */
export const BROWSER_CATALOG_NONE = '（いま頼めるものは、このアプリにはありません）'

const quote = (s: string) => JSON.stringify(s)

/** How the AI should fill one value of a line, from the line's own words (never a fixed site word). */
function valueHint(line: BrowserOpenedLine, name: string): string {
  const v = line.read.values[name]
  const read = line.read.reads.find(r => 'value' in r.id && r.id.value === name)
  const heading = read ? line.readLabels[read.name] : undefined
  if (v?.role === 'target') return heading ? `${heading}の番号（ユーザーが教えた番号）` : '番号（ユーザーが教えた番号）'
  if (v?.role === 'write') return 'あなたの案（カードでユーザーが確かめる）'
  return 'ユーザーに確かめる値'
}

/**
 * One line per opened line of the given kind (`read`: an inspection, writes nothing; `write`: a line that writes) whose
 * site the build knows: its site and name to pass, its title, and each value's name with how to fill it.
 */
export function browserLineCatalog(lines: readonly BrowserOpenedLine[], siteOf: (id: string) => BrowserCatalogSite | null, kind: 'read' | 'write'): string {
  const rows: string[] = []
  for (const line of lines) {
    if ((line.writes !== undefined) !== (kind === 'write')) continue
    const site = siteOf(line.read.site)
    if (!site) continue
    const values = Object.keys(line.read.values).map(n => `${quote(n)}: ${valueHint(line, n)}`).join('、')
    rows.push(`- site ${quote(site.id)}（${site.label}）, line ${quote(line.name)}「${line.label}」, values { ${values} }`)
  }
  return rows.length > 0 ? rows.join('\n') : BROWSER_CATALOG_NONE
}

/** An operation of the old path's declaration: its name, title and the fields the hints name. */
export interface BrowserCatalogOperation { name: string; label: string; target: readonly string[]; change: readonly string[] }

/** One line per operation of the old path (`browser_request`): the site and operation to pass and the hint keys. */
export function browserOperationCatalog(sites: ReadonlyArray<BrowserCatalogSite & { operations: readonly BrowserCatalogOperation[] }>): string {
  const rows: string[] = []
  for (const site of sites) {
    for (const op of site.operations) {
      rows.push(`- site ${quote(site.id)}（${site.label}）, operation ${quote(op.name)}「${op.label}」, target_hints { ${op.target.map(quote).join(', ')} }, change_hints { ${op.change.map(quote).join(', ')} }`)
    }
  }
  return rows.length > 0 ? rows.join('\n') : BROWSER_CATALOG_NONE
}
