/**
 * The sample plugin packages on a test shelf (`tests/fixtures/plugins`).
 * A connector maps to one business plugin version (owner decision
 * 2026-11-01): `sample-hub` and `sample-crm` map to `sample-sales@0.1.0`,
 * which owns the deal / customer types and must be installed and on first.
 */
import { cpSync } from 'fs'
import { join } from 'path'
import type { Member } from '../../src/services/access'
import type { PluginService } from '../../src/services/plugins'

export const PLUGIN_FIXTURES = join(__dirname, '../fixtures/plugins')

/** The business plugin of the sample connectors. */
export const SAMPLE_SALES = { id: 'sample-sales', version: '0.1.0' } as const

/** Put the business plugin and the HubSpot-shaped connector on a test shelf. */
export function putSampleHub(shelfDir: string): void {
  cpSync(join(PLUGIN_FIXTURES, 'sample-sales'), join(shelfDir, `sample-sales@${SAMPLE_SALES.version}`), { recursive: true })
  cpSync(join(PLUGIN_FIXTURES, 'sample-hub'), join(shelfDir, 'sample-hub@0.1.0'), { recursive: true })
}

/** Install and turn on the business plugin (a connector's install needs it first). */
export async function enableSampleSales(plugins: PluginService, owner: Member): Promise<void> {
  const installed = await plugins.install(owner, SAMPLE_SALES.id, { version: SAMPLE_SALES.version, keyId: null })
  if (!installed.ok) throw new Error(`installing ${SAMPLE_SALES.id}: ${JSON.stringify(installed)}`)
  const enabled = await plugins.setEnabled(owner, SAMPLE_SALES.id, { enabled: true })
  if (!enabled.ok) throw new Error(`turning on ${SAMPLE_SALES.id}: ${JSON.stringify(enabled)}`)
}
