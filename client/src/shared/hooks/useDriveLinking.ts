// ACB foundation: 「Google Drive のファイルをつなぐ」 on a record — the task card (tasks) and the 案件・プロジェクト
// card (records) link the same way (records.md "Drive and PC file links", owner decision 2026-11-13).
import { useCallback, useState } from 'react'
import { driveLinkView } from '../../../shared/google'
import { DRIVE_LINK_EMPTY_HINT, NOT_A_DRIVE_LINK } from '../../../shared/drive-links'
import type { TaskDriveLinkOptions } from '../../../shared/tasks'
import { driveFileIdsFromText } from '../../../../shared/core/google-drive'
import { useIpcEvent } from './useIpcEvent'
import { getDriveSetup, linkDriveFiles } from '../ipc/drive-links'

/**
 * Whether ［Google Drive のファイルをつなぐ］ can work now (Google and the chooser set up for the company, Drive
 * offered, allowed yet), read when the card opens (`enabled`: a card that offers the button) and again after each link; until known it is offered. `link`
 * opens the member's list / Google's chooser and links each file at the version the previous one moved to;
 * `fromText` reads a pasted / dropped link (the chooser then opens showing just that file). `hint`: after the
 * chooser opened on such a link ended with nothing chosen, what to check — never after a plain chooser's cancel.
 */
export function useDriveLinking(companyId: string, enabled = true) {
  const [view, setView] = useState(() => driveLinkView(null))
  const [hint, setHint] = useState(false)
  const reload = useCallback(() => {
    void Promise.resolve().then(() => getDriveSetup(companyId)).then(r => setView(driveLinkView(r ?? null)), () => setView(driveLinkView(null)))
  }, [companyId])
  // The one read through useIpcEvent with nothing to listen to: the renderer's effect count is capped.
  const once = useCallback((listener: (payload: undefined) => void) => { listener(undefined) }, [])
  // A card that offers no Drive button (a meeting's, a 来た連絡's) never asks; one that starts offering it (its card
  // read) asks then.
  useIpcEvent(once, reload, enabled)
  /** null error = linked (or the member chose nothing); `done` = what to say, when something was linked. */
  const link = async (recordId: string, version: number, options?: TaskDriveLinkOptions): Promise<{ error: string | null; done: string | null }> => {
    setHint(false)
    const r = await linkDriveFiles(companyId, recordId, version, options)
    reload()
    if (!r.success) return { error: r.error, done: null }
    const done = r.linked.length > 0 ? `${r.linked.map(n => `「${n}」`).join('・')}をつなぎました` : null
    // Only for a pasted / dropped link: a plain chooser's cancel is the member's own choice.
    if (!done && options?.fileIds?.length && !r.error) setHint(true)
    return { error: r.error ?? null, done }
  }
  /** A pasted or dropped text: the options to link with, or why not (null: nothing to say). */
  const fromText = (text: string): { options: TaskDriveLinkOptions } | { error: string | null } => {
    setHint(false)
    if (!view.usable) return { error: view.note }
    const ids = driveFileIdsFromText(text)
    return ids.length > 0 ? { options: { fileIds: ids } } : { error: NOT_A_DRIVE_LINK }
  }
  return { usable: view.usable, note: view.note, hint: hint ? DRIVE_LINK_EMPTY_HINT : null, clearHint: () => setHint(false), link, fromText }
}
