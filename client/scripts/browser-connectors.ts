/**
 * The approved combinations of browser connectors (agent-browser.md "Plans, executions, permits and
 * locks"; internal design memo §30.7): `shared/browser-connectors/approved.json`, one row per
 * declaration × checker code × facts version that the server accepts plans for.
 *
 *   cd client && npx tsx scripts/browser-connectors.ts           # write the file
 *   cd client && npx tsx scripts/browser-connectors.ts --check   # exit 1 when it does not match the files
 *
 * - `checkerHash`: the whole site folder `client/connectors/<site>/` (every file, the declaration and
 *   the account reader included), as plugin fingerprint v2 does it: sha256 per file, the listing in
 *   name order, sha256 of the listing (`pluginFingerprintV2`).
 * - `declarationHash`: `sha256:` of the declaration text's UTF-8 bytes. The text itself is in the row:
 *   the server reads the declaration from this file (never from client/), checks it against its hash
 *   and parses it with the core's parser, so the server and the app read the same text.
 * - `factsVersion`: `BROWSER_FACTS_VERSION` (shared/core/browser-plans.ts); every type's declared
 *   facts must be known to that version's schema for its checker, or the script refuses.
 * - A row the files no longer give is kept as it is (an app already released may carry that code);
 *   retiring one is a reviewed edit of its `status` to `retired`. `minAppVersion` starts null (no
 *   gate beyond the hashes) and may be set by hand; both are kept when the script runs again.
 * - One connector version has one declaration: a version whose text changed is refused (raise the
 *   version).
 *
 * `client/tests/browser-connectors-approved.test.ts` fails when the file is not what this script
 * would write, so a changed connector folder cannot be merged without its row.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BROWSER_FACTS_VERSION, browserFactsDeclarationProblem } from '../../shared/core/browser-plans'
import { pluginFingerprintV2 } from '../../shared/core/plugin-fingerprint'
import { parsePluginManifest } from '../../shared/core/plugins'

const HERE = dirname(fileURLToPath(import.meta.url))
export const CONNECTORS_DIR = resolve(HERE, '../connectors')
export const APPROVED_FILE = resolve(HERE, '../../shared/browser-connectors/approved.json')

export interface ApprovedRow {
  connector: string
  version: string
  declarationHash: string
  checkerHash: string
  factsVersion: number
  minAppVersion: string | null
  status: 'approved' | 'retired'
  declaration: string
}

const sha256Hex = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')

/** Every file under `dir` but Finder's `.DS_Store` (never code; a Mac makes it on its own). */
function filesOf(dir: string): string[] {
  return readdirSync(dir).filter(name => name !== '.DS_Store').flatMap(name => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? filesOf(p) : [p]
  })
}

/** The site folder's hash (plugin fingerprint v2 over every file in it). */
export function folderHash(dir: string): string {
  const files = filesOf(dir).map(p => ({ path: relative(dir, p).split('\\').join('/'), bytes: readFileSync(p) }))
  return `sha256:${pluginFingerprintV2(files, sha256Hex)}`
}

export const declarationHash = (text: string): string => `sha256:${sha256Hex(Buffer.from(text, 'utf8'))}`

const rowKey = (r: Pick<ApprovedRow, 'connector' | 'version' | 'declarationHash' | 'checkerHash' | 'factsVersion'>) =>
  [r.connector, r.version, r.declarationHash, r.checkerHash, r.factsVersion].join('\n')

/** The rows the connector folders give now. */
export async function currentRows(connectorsDir = CONNECTORS_DIR): Promise<ApprovedRow[]> {
  const rows: ApprovedRow[] = []
  for (const site of readdirSync(connectorsDir).sort()) {
    const dir = join(connectorsDir, site)
    if (!statSync(dir).isDirectory()) continue
    const mod = await import(pathToFileURL(join(dir, 'declaration.ts')).href) as { DECLARATIONS?: readonly string[] }
    if (!Array.isArray(mod.DECLARATIONS) || mod.DECLARATIONS.length === 0) throw new Error(`${site}/declaration.ts must export DECLARATIONS`)
    const checkerHash = folderHash(dir)
    for (const text of mod.DECLARATIONS) {
      const parsed = parsePluginManifest(text)
      if (!parsed.ok || !parsed.value.browser) throw new Error(`${site}: a declaration does not parse:\n${parsed.ok ? 'no browser part' : parsed.errors.join('\n')}`)
      for (const [name, op] of Object.entries(parsed.value.browser.operations)) {
        const problem = browserFactsDeclarationProblem(op, BROWSER_FACTS_VERSION)
        if (problem) throw new Error(`${site}: ${name}: ${problem}`)
      }
      rows.push({
        connector: parsed.value.id, version: parsed.value.version, declarationHash: declarationHash(text), checkerHash,
        factsVersion: BROWSER_FACTS_VERSION, minAppVersion: null, status: 'approved', declaration: text,
      })
    }
  }
  return rows
}

/** The file's text for these current rows, keeping every existing row (and its status / minAppVersion). */
export function mergeApproved(existingText: string | null, current: readonly ApprovedRow[]): string {
  const existing: ApprovedRow[] = existingText ? (JSON.parse(existingText) as { combinations: ApprovedRow[] }).combinations : []
  const byKey = new Map(existing.map(r => [rowKey(r), r]))
  for (const row of current) {
    const sameVersion = existing.find(r => r.connector === row.connector && r.version === row.version && r.declarationHash !== row.declarationHash)
    if (sameVersion) throw new Error(`${row.connector}@${row.version}: the declaration changed under the same version — raise the version`)
    if (!byKey.has(rowKey(row))) byKey.set(rowKey(row), row)
  }
  const rows = [...byKey.values()].sort((a, b) => (rowKey(a) < rowKey(b) ? -1 : rowKey(a) > rowKey(b) ? 1 : 0))
  return `${JSON.stringify({ format: 1, combinations: rows }, null, 2)}\n`
}

/** The file's text for the connector folders now. */
export async function approvedFileText(existingText: string | null, connectorsDir = CONNECTORS_DIR): Promise<string> {
  return mergeApproved(existingText, await currentRows(connectorsDir))
}

async function main() {
  let existing: string | null = null
  try { existing = readFileSync(APPROVED_FILE, 'utf8') } catch { existing = null }
  const next = await approvedFileText(existing)
  if (process.argv.includes('--check')) {
    if (next !== existing) {
      console.error('shared/browser-connectors/approved.json does not match client/connectors/: run `cd client && npx tsx scripts/browser-connectors.ts`')
      process.exit(1)
    }
    return
  }
  if (next !== existing) writeFileSync(APPROVED_FILE, next)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
