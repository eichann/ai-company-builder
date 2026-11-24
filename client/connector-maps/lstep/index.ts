/**
 * Lステップ's map as the app will bundle it (generalization PR 3): the map, how each thing is read and the readers. Like a
 * connector folder, only `electron/main.ts` may import it (architecture-boundaries.test.ts); nothing does yet — the reading
 * path and the card come in later PRs. The scripts and tests read it to write and check `opened.json`.
 */
import type { BrowserMap, BrowserThingReader } from '../../../shared/core/browser-map'
import { LSTEP_MAP, LSTEP_MAP_READS } from './map'
import { LSTEP_MAP_READERS } from './readers'

export function lstepMap(): { map: BrowserMap; reads: typeof LSTEP_MAP_READS; readers: Readonly<Record<string, BrowserThingReader>> } {
  return { map: LSTEP_MAP, reads: LSTEP_MAP_READS, readers: LSTEP_MAP_READERS }
}

/** Every map this folder gives (the opened list's script reads `MAPS` of each map folder). */
export const MAPS: readonly BrowserMap[] = [LSTEP_MAP]
