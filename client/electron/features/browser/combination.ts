// How the app knows its own connector combination (agent-browser.md "The card, the IPC and the request
// tool"; the runner's and the registration's `combination`): `shared/browser-connectors/carried.json`,
// written by client/scripts/browser-connectors.ts from this tree's connector folders and held to them by
// browser-connectors-approved.test.ts, names the declaration and checker-folder hashes and the facts
// version THIS build carries. A row is used only when its declaration hash is also the hash of the
// declaration text the app bundles for that id and version (a file and a bundle that disagree = none).
import { createHash } from 'node:crypto'
import { parseBrowserDeclaration } from '../../../shared/browser-checkers'

export interface CarriedCombination { declarationHash: string; checkerHash: string; factsVersion: number }

const HASH_RE = /^sha256:[0-9a-f]{64}$/
const sha256 = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`

export function createCarriedCombinations(file: unknown, declarations: readonly string[]): (id: string, version: string) => CarriedCombination | null {
  const rows = file && typeof file === 'object' && (file as { format?: unknown }).format === 1 && Array.isArray((file as { combinations?: unknown }).combinations)
    ? (file as { combinations: unknown[] }).combinations : []
  const bundled = new Map<string, string>()
  for (const text of declarations) {
    const parsed = parseBrowserDeclaration(text)
    if (parsed) bundled.set(`${parsed.id}@${parsed.version}`, sha256(text))
  }
  return (id, version) => {
    const own = bundled.get(`${id}@${version}`)
    if (!own) return null
    const found = rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object'
      && (r as Record<string, unknown>).connector === id && (r as Record<string, unknown>).version === version)
    // One row per id and version in a build; two would leave the checker hash in doubt.
    if (found.length !== 1) return null
    const r = found[0]
    if (r.declarationHash !== own || typeof r.checkerHash !== 'string' || !HASH_RE.test(r.checkerHash)
      || typeof r.factsVersion !== 'number' || !Number.isSafeInteger(r.factsVersion) || r.factsVersion < 1) return null
    return { declarationHash: own, checkerHash: r.checkerHash, factsVersion: r.factsVersion }
  }
}

/**
 * The bundled declarations whose login helpers the window may use (agent-browser.md "Login helpers"):
 * only one this build carries (`createCarriedCombinations`) that the approved list — the file the server
 * reads to accept plans, `shared/browser-connectors/approved.json` as this build has it — marks
 * `approved` for exactly that declaration text and checker hash. Anything else (pending, retired, another
 * text, two rows) lends no helper: the login page then looks as before.
 */
export function approvedBundledDeclarations(approvedFile: unknown, carriedFile: unknown, declarations: readonly string[]): string[] {
  const carriedOf = createCarriedCombinations(carriedFile, declarations)
  const rows = approvedFile && typeof approvedFile === 'object' && (approvedFile as { format?: unknown }).format === 1 && Array.isArray((approvedFile as { combinations?: unknown }).combinations)
    ? (approvedFile as { combinations: unknown[] }).combinations.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object') : []
  return declarations.filter(text => {
    const parsed = parseBrowserDeclaration(text)
    const carried = parsed ? carriedOf(parsed.id, parsed.version) : null
    if (!parsed || !carried) return false
    const same = rows.filter(r => r.connector === parsed.id && r.version === parsed.version
      && r.declarationHash === carried.declarationHash && r.checkerHash === carried.checkerHash)
    return same.length === 1 && same[0].status === 'approved' && same[0].declaration === text
  })
}
