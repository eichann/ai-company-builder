/**
 * Lステップ's map as the app bundles it (generalization PR 3; wired in PR 5b): the map, how each thing is read and the
 * readers, and — for the read runner (electron/features/browser/read-line-runner.ts) — how each JSON thing a read-only line
 * reads is addressed and the page whose account marker is read. Like a connector folder, only `electron/main.ts` may import
 * it (architecture-boundaries.test.ts). The scripts and tests read it to write and check `opened.json`.
 */
import type { BrowserMap, BrowserThingReader } from '../../../shared/core/browser-map'
import { accountFromMeta } from '../../connectors/lstep/reminder-step'
import { LSTEP_MAP, LSTEP_MAP_ACCOUNT, LSTEP_MAP_READS } from './map'
import { LSTEP_MAP_READERS } from './readers'

export function lstepMap(): { map: BrowserMap; reads: typeof LSTEP_MAP_READS; readers: Readonly<Record<string, BrowserThingReader>> } {
  return { map: LSTEP_MAP, reads: LSTEP_MAP_READS, readers: LSTEP_MAP_READERS }
}

/**
 * What the read runner is handed for this map (its `BrowserThingAddress` and `BrowserAccountMarker`, written here by
 * shape: this folder imports nothing of the app). Only the JSON things the reading code reads today — an object by its
 * id, a list's entry through the same object's folder (1.0.3: the route's `group_id`) —, each built from `LSTEP_MAP_READS`
 * word for word; html things and lists named by a value come with the reading code that reads them (PR 7).
 */
export function lstepReadLines() {
  const row = LSTEP_MAP_READS.landing_row
  return {
    map: LSTEP_MAP,
    readers: LSTEP_MAP_READERS,
    addresses: {
      landing: { kind: 'object' as const, path: LSTEP_MAP_READS.landing.path },
      landing_row: {
        kind: 'list_entry' as const, path: row.path,
        folder: { param: row.folder.param, field: row.folder.field },
        pages: { param: row.pages.param, max: row.pages.max, perPage: row.pages.perPage },
        list: { items: 'data', current: 'current_page', last: 'last_page', total: 'total', keys: row.envelope, lists: { links: row.envelopeLinkKeys } },
      },
      action_set: { kind: 'object' as const, path: LSTEP_MAP_READS.action_set.path },
    },
    account: { path: LSTEP_MAP_ACCOUNT.path, read: accountFromMeta },
  }
}

/** Every map this folder gives (the opened list's script reads `MAPS` of each map folder). */
export const MAPS: readonly BrowserMap[] = [LSTEP_MAP]
