/**
 * The approved combinations of browser connectors, read from `shared/browser-connectors/approved.json`
 * (written by client/scripts/browser-connectors.ts; agent-browser.md "Plans, executions, permits and
 * locks"). Read once at startup, like the plugin shelf: a new file reaches the server with a new
 * build. A file that is missing or cannot be read gives no combination (every plan is refused).
 * The service checks each row (its declaration against its hash, the parser) before using it.
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { ApprovedCombinationRow, BrowserConnectorCatalog } from '../ports/browser-plans'
import type { BrowserOpenedListSource } from '../ports/browser-lines'
import { logError } from '../lib/error-log'

const HERE = dirname(fileURLToPath(import.meta.url))
/** server/src/adapters → server/shared (the repository's shared/, /app/shared in the image). */
export const APPROVED_COMBINATIONS_FILE = join(HERE, '../../shared/browser-connectors/approved.json')

export function fileBrowserConnectorCatalog(file = APPROVED_COMBINATIONS_FILE): BrowserConnectorCatalog {
  let rows: ApprovedCombinationRow[] = []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { combinations?: unknown }
    rows = Array.isArray(parsed.combinations) ? parsed.combinations as ApprovedCombinationRow[] : []
  } catch (error) {
    logError('browser-plans', 'the approved browser connectors could not be read; no plan is accepted', error)
  }
  return { combinations: () => rows }
}

/** server/src/adapters → the repository's shared/browser-connectors/opened.json (generalization PR 4). */
export const OPENED_LIST_FILE = join(HERE, '../../shared/browser-connectors/opened.json')

/**
 * The opened list (maps and lines, agent-browser.md "Plans of opened lines on the server"), read once at startup like the
 * approved combinations. A missing or unreadable file gives nothing (every line plan is refused). The service re-hashes
 * and checks every row before using it.
 */
export function fileBrowserOpenedList(file = OPENED_LIST_FILE): BrowserOpenedListSource {
  let parsed: unknown = null
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch (error) {
    logError('browser-lines', 'the opened list could not be read; no line plan is accepted', error)
  }
  return { file: () => parsed }
}
