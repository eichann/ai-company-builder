// ACB foundation: 「Google Drive のファイルをつなぐ」 on a record — the task card (tasks) and the 案件・プロジェクト
// card (records) link the same way (records.md "Drive and PC file links", owner decision 2026-11-13).
import { useCallback, useRef, useState } from 'react'
import { driveLinkView } from '../../../shared/google'
import { DRIVE_FOLDER_NOT_YET, DRIVE_LINK_EMPTY_HINT, DRIVE_PICK_TIMED_OUT, NOT_A_DRIVE_LINK } from '../../../shared/drive-links'
import type { TaskDriveLinkOptions } from '../../../shared/tasks'
import { driveFileIdsFromText, hasDriveFolderLink } from '../../../../shared/core/google-drive'
import { useIpcEvent } from './useIpcEvent'
import { getDriveSetup, linkDriveFiles, stopDrivePick } from '../ipc/drive-links'

/**
 * Whether ［Google Drive のファイルをつなぐ］ can work now (Google and the chooser set up for the company, Drive
 * offered, allowed yet), read when the card opens (`enabled`: a card that offers the button) and again after each link; until known it is offered. `link`
 * opens the member's list / Google's chooser and links each file at the version the previous one moved to;
 * `fromText` reads a pasted / dropped link (the chooser then opens showing just that file). `hint`: after the
 * chooser opened on such a link ended with nothing chosen, what to check — never after a plain chooser's cancel.
 * `picking`: Google's chooser is open in the member's browser (the card says so, with ［やめる］ = `stop`); a time-out
 * and picked files that could not be used are said, a cancel is not (owner FB 2026-11-14).
 */
export function useDriveLinking(companyId: string, enabled = true) {
  const [view, setView] = useState(() => driveLinkView(null))
  const [hint, setHint] = useState(false)
  const [picking, setPicking] = useState(false)
  /** The member pressed ［やめる］: their own choice, nothing more to say. */
  const stopped = useRef(false)
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
    stopped.current = false
    // Anything but the member's own list may open Google's chooser in the browser.
    const chooser = !options?.chosen
    if (chooser) setPicking(true)
    let r: Awaited<ReturnType<typeof linkDriveFiles>>
    try {
      r = await linkDriveFiles(companyId, recordId, version, options)
    } finally {
      if (chooser) setPicking(false)
    }
    reload()
    if (!r.success) return { error: r.error, done: null }
    const linked = r.linked.length > 0 ? `${r.linked.map(n => `「${n}」`).join('・')}をつなぎました` : null
    // Picked but not usable (how many, why): said with what was linked, or alone.
    const done = linked && r.notUsable ? `${linked}。${r.notUsable}` : linked
    if (r.ended === 'timed-out') return { error: DRIVE_PICK_TIMED_OUT, done: null }
    // Only for a pasted / dropped link: a plain chooser's cancel (or the member's ［やめる］) is the member's own choice.
    if (!linked && options?.fileIds?.length && !r.error && !stopped.current) setHint(true)
    return { error: r.error ?? (linked ? null : r.notUsable ?? null), done }
  }
  /** ［やめる］ while the chooser is open: main stops waiting and closes the ticket; `link` then ends with nothing linked. */
  const stop = () => {
    stopped.current = true
    void Promise.resolve().then(() => stopDrivePick(companyId)).catch(() => undefined)
  }
  /** A pasted or dropped text: the options to link with, or why not (null: nothing to say). */
  const fromText = (text: string): { options: TaskDriveLinkOptions } | { error: string | null } => {
    setHint(false)
    if (!view.usable) return { error: view.note }
    const ids = driveFileIdsFromText(text)
    if (ids.length > 0) return { options: { fileIds: ids } }
    return { error: hasDriveFolderLink(text) ? DRIVE_FOLDER_NOT_YET : NOT_A_DRIVE_LINK }
  }
  return { usable: view.usable, note: view.note, hint: hint ? DRIVE_LINK_EMPTY_HINT : null, clearHint: () => setHint(false), link, fromText, picking, stop }
}
