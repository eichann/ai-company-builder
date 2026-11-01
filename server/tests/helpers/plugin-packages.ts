/**
 * The sample plugin packages on a test shelf (`tests/fixtures/plugins`).
 * Owner decision 2026-11-01: `sample-hub` is a HubSpot-shaped connector (a
 * company-wide shared part: key, connection, read scope), and `sample-sales`
 * the business plugin that uses it (`connector: sample-hub >= 0.1.0`): its
 * deal / customer types, the mapping, the import and the typed operations are
 * keyed by `sample-sales`.
 */
import { cpSync } from 'fs'
import { join } from 'path'
import type { Member } from '../../src/services/access'
import type { PluginService } from '../../src/services/plugins'

export const PLUGIN_FIXTURES = join(__dirname, '../fixtures/plugins')

/** The business plugin using the sample HubSpot connector. */
export const SAMPLE_SALES = { id: 'sample-sales', version: '0.1.0' } as const

/** Put the business plugin and the HubSpot-shaped connector on a test shelf. */
export function putSampleHub(shelfDir: string): void {
  cpSync(join(PLUGIN_FIXTURES, 'sample-sales'), join(shelfDir, `sample-sales@${SAMPLE_SALES.version}`), { recursive: true })
  cpSync(join(PLUGIN_FIXTURES, 'sample-hub'), join(shelfDir, 'sample-hub@0.1.0'), { recursive: true })
}

/** Install and turn on the business plugin (its types are stored at once; its connector-backed parts wait for sample-hub). */
export async function enableSampleSales(plugins: PluginService, owner: Member): Promise<void> {
  const installed = await plugins.install(owner, SAMPLE_SALES.id, { version: SAMPLE_SALES.version, keyId: null })
  if (!installed.ok) throw new Error(`installing ${SAMPLE_SALES.id}: ${JSON.stringify(installed)}`)
  const enabled = await plugins.setEnabled(owner, SAMPLE_SALES.id, { enabled: true })
  if (!enabled.ok) throw new Error(`turning on ${SAMPLE_SALES.id}: ${JSON.stringify(enabled)}`)
}
