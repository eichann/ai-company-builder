// What the settings' sections have typed and not saved, asked from outside the sections: today's
// panel asks before closing or moving on; a frame with tabs (段5) asks before switching or closing a
// tab. Each section fills its own handle (`refFor(id)`, the `UnsavedChanges` it already takes).
import type { MutableRefObject } from 'react'
import type { UnsavedChanges } from '../../shared/lib/unsavedChanges'
import type { SettingsSectionId } from './sections'

export interface SettingsUnsaved {
  /** The ref a section fills with its handle while it is mounted (React sets it back to null on unmount). */
  refFor: (id: SettingsSectionId) => MutableRefObject<UnsavedChanges | null>
  /** What these sections would drop, in the member's words (never a value), in the order asked. */
  pending: (ids: readonly SettingsSectionId[]) => string[]
  /** Saves these sections one by one: null when all saved; else the first reason ('' = the section says it). */
  save: (ids: readonly SettingsSectionId[]) => Promise<string | null>
}

/** The whole settings asked at once from outside them (closing the destination, signing out). */
export interface SettingsUnsavedAsk {
  pending: () => string[]
  save: () => Promise<string | null>
}

/**
 * `kept`: handles that live outside any one mounted section (the panel's .env / .gitignore drafts),
 * read each time they are asked.
 */
export function createSettingsUnsaved(kept: () => Partial<Record<SettingsSectionId, UnsavedChanges>> = () => ({})): SettingsUnsaved {
  const handles = new Map<SettingsSectionId, UnsavedChanges>()
  const refs = new Map<SettingsSectionId, MutableRefObject<UnsavedChanges | null>>()
  const handleOf = (id: SettingsSectionId): UnsavedChanges | null => kept()[id] ?? handles.get(id) ?? null
  return {
    refFor: id => {
      let ref = refs.get(id)
      if (!ref) {
        ref = {
          get current() { return handles.get(id) ?? null },
          set current(handle: UnsavedChanges | null) { if (handle) handles.set(id, handle); else handles.delete(id) },
        }
        refs.set(id, ref)
      }
      return ref
    },
    pending: ids => ids.map(id => handleOf(id)?.pending() ?? null).filter((x): x is string => !!x),
    save: async ids => {
      for (const id of ids) {
        const handle = handleOf(id)
        if (!handle?.pending()) continue
        const failed = await handle.save()
        if (failed !== null) return failed
      }
      return null
    },
  }
}
