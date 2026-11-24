/**
 * The opened list of browser operation's generalization (agent-browser.md "The first map and the inspection line"; design
 * memo §3-5, §16-5): `shared/browser-connectors/opened.json`, beside approved.json (which it never touches).
 *
 *   cd client && npx tsx scripts/browser-opened.ts           # write the file
 *   cd client && npx tsx scripts/browser-opened.ts --check   # exit 1 when it does not match the files
 *
 * - **maps**: one row per site map version from `client/connector-maps/<site>/index.ts` (`MAPS`), checked with the core's
 *   `browserMapProblem`: the map itself (so the server reads it from this file, never from client/), `mapHash` = `sha256:`
 *   of its canonical JSON, `readersHash` = the site's map folder (every file, as approved.json's checker hash:
 *   `folderHash`). A version whose map or reader code changed is refused (raise the map's version): the version names
 *   the mechanics a line was approved with.
 * - **lines**: one row per line from `client/browser-lines/<site>.ts` (`LINES`) × the map version it opens against, checked
 *   with `browserOpenedLineProblem`; `meaningHash` / `mechanicsHash` (`sha256:` of `browserLineMeaning` /
 *   `browserLineMechanics`). A new row is written **`pending`**; only a reviewed edit makes it `approved` or `retired`, and
 *   the script keeps that status. A line whose hashes changed under the same name, version and map version is refused
 *   (raise the line's version).
 * - Rows the files no longer give are kept (an app already released may carry them).
 * - `format: 1`, `provisional: true` (memo §18: the shape may change until a second site fits it).
 *
 * `client/tests/browser-opened.test.ts` fails when the file is not what this script writes.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { browserMapProblem, type BrowserMap } from '../../shared/core/browser-map'
import {
  browserLineMeaning, browserLineMechanics, browserOpenedLineProblem,
  type BrowserOpenedFile, type BrowserOpenedLine, type BrowserOpenedLineRow, type BrowserOpenedMapRow,
} from '../../shared/core/browser-opened'
import { canonicalJson } from '../../shared/core/fixed-content'
import { folderHash } from './browser-connectors'

const HERE = dirname(fileURLToPath(import.meta.url))
export const MAPS_DIR = resolve(HERE, '../connector-maps')
export const LINES_DIR = resolve(HERE, '../browser-lines')
export const OPENED_FILE = resolve(HERE, '../../shared/browser-connectors/opened.json')

const sha256 = (text: string): string => `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`

/** The map rows the map folders give now. */
export async function currentMaps(mapsDir = MAPS_DIR): Promise<BrowserOpenedMapRow[]> {
  const rows: BrowserOpenedMapRow[] = []
  for (const site of readdirSync(mapsDir).sort()) {
    const dir = join(mapsDir, site)
    if (!statSync(dir).isDirectory()) continue
    const mod = await import(pathToFileURL(join(dir, 'index.ts')).href) as { MAPS?: readonly BrowserMap[] }
    if (!Array.isArray(mod.MAPS) || mod.MAPS.length === 0) throw new Error(`${site}/index.ts must export MAPS`)
    const readersHash = folderHash(dir)
    for (const map of mod.MAPS) {
      const problem = browserMapProblem(map)
      if (problem) throw new Error(`${site}: the map does not pass: ${problem}`)
      if (map.site !== site) throw new Error(`${site}: the map names another site (${map.site})`)
      // A plain copy of the data (what the server will parse), never the module's object.
      const plain = JSON.parse(canonicalJson(map)) as BrowserMap
      rows.push({ site: map.site, version: map.version, mapHash: sha256(canonicalJson(plain)), readersHash, map: plain })
    }
  }
  return rows
}

/** The line rows the line files give now, against the current maps. */
export async function currentLines(maps: readonly BrowserOpenedMapRow[], linesDir = LINES_DIR): Promise<BrowserOpenedLineRow[]> {
  const rows: BrowserOpenedLineRow[] = []
  if (!existsSync(linesDir)) return rows
  for (const file of readdirSync(linesDir).filter(f => f.endsWith('.ts')).sort()) {
    const site = file.slice(0, -3)
    const mod = await import(pathToFileURL(join(linesDir, file)).href) as { LINES?: readonly BrowserOpenedLine[] }
    if (!Array.isArray(mod.LINES)) throw new Error(`${file} must export LINES`)
    const siteMaps = maps.filter(m => m.site === site)
    if (siteMaps.length === 0) throw new Error(`${file}: no map for ${site}`)
    for (const line of mod.LINES) {
      const plainLine = JSON.parse(canonicalJson(line)) as BrowserOpenedLine
      for (const m of siteMaps) {
        const problem = browserOpenedLineProblem(plainLine, m.map)
        if (problem) throw new Error(`${file}: ${line.name}: ${problem}`)
        rows.push({
          name: plainLine.name, version: plainLine.version, site, mapVersion: m.version, status: 'pending',
          meaningHash: sha256(browserLineMeaning(plainLine, m.map)),
          mechanicsHash: sha256(browserLineMechanics(plainLine, m.map, { mapHash: m.mapHash, readersHash: m.readersHash })),
          line: plainLine,
        })
      }
    }
  }
  return rows
}

const mapKey = (m: BrowserOpenedMapRow) => `${m.site}\n${m.version}`
const lineId = (l: BrowserOpenedLineRow) => `${l.site}\n${l.name}\n${l.version}\n${l.mapVersion}`
const lineKey = (l: BrowserOpenedLineRow) => `${lineId(l)}\n${l.meaningHash}\n${l.mechanicsHash}`
const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)

/** The file's text for these current rows, keeping every existing row (and each line's status). */
export function mergeOpened(existingText: string | null, maps: readonly BrowserOpenedMapRow[], lines: readonly BrowserOpenedLineRow[]): string {
  const existing: BrowserOpenedFile = existingText ? JSON.parse(existingText) as BrowserOpenedFile : { format: 1, provisional: true, maps: [], lines: [] }
  const mapRows = new Map(existing.maps.map(m => [mapKey(m), m]))
  for (const m of maps) {
    const old = mapRows.get(mapKey(m))
    if (old && (old.mapHash !== m.mapHash || old.readersHash !== m.readersHash)) throw new Error(`${m.site} map ${m.version}: the map or its readers changed under the same version — raise the map's version`)
    if (!old) mapRows.set(mapKey(m), m)
  }
  const lineRows = new Map(existing.lines.map(l => [lineKey(l), l]))
  for (const l of lines) {
    if (lineRows.has(lineKey(l))) continue
    if (existing.lines.some(o => lineId(o) === lineId(l))) throw new Error(`${l.site} line ${l.name} ${l.version} on map ${l.mapVersion}: the line changed under the same version — raise the line's version`)
    lineRows.set(lineKey(l), l)
  }
  const file: BrowserOpenedFile = {
    format: 1, provisional: true,
    maps: [...mapRows.values()].sort(byKey(mapKey)),
    lines: [...lineRows.values()].sort(byKey(lineKey)),
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

export async function openedFileText(existingText: string | null): Promise<string> {
  const maps = await currentMaps()
  return mergeOpened(existingText, maps, await currentLines(maps))
}

async function main() {
  let existing: string | null = null
  try { existing = readFileSync(OPENED_FILE, 'utf8') } catch { existing = null }
  const next = await openedFileText(existing)
  if (process.argv.includes('--check')) {
    if (next !== existing) {
      console.error('shared/browser-connectors/opened.json does not match client/connector-maps/ and client/browser-lines/: run `cd client && npx tsx scripts/browser-opened.ts`')
      process.exit(1)
    }
    return
  }
  if (next !== existing) writeFileSync(OPENED_FILE, next)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
