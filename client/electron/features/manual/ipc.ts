// The user manual in the app (files-and-editor.md "The user manual"):
//   manual:open   (pageId, anchor | null) → a document view showing that page (only its id goes back)
//   manual:export ()                      → the manual written to a new folder the member chose
// Only the main window's own page may ask, decided before anything is fetched or written.
// Showing reuses the HTML viewer's guards whole (doc-frame.md): the page is a file of this computer's
// copy of the server's manual (`site.ts`), served by `acb-doc://` from a grant for that copy alone, in a
// view on the document session — no network, no app, no other file. The renderer never names a path:
// the page is an id, the export's folder comes from the save dialog in main.
import fs from 'node:fs/promises'
import path from 'node:path'
import { isManualPageId, manualPageFile } from '../../../../shared/core/manual'
import { isManualAnchor, MANUAL_WORDS, type ManualExportResult, type ManualOpenResult } from '../../../shared/manual'
import type { IpcInvokeEvent, IpcRegistrar } from '../../ipc/registrar'
import type { DocViews } from '../doc-frames/views'
import type { ManualSite } from './site'

export interface ManualIpcDeps<E> {
  site: Pick<ManualSite, 'current' | 'writeTo'>
  views: Pick<DocViews, 'begin' | 'open'>
  /** The event came from the main window's main frame. */
  fromMainWindow: (event: E) => boolean
  /** The save dialog (the shell's); null when cancelled. */
  chooseFolder: (options: { title: string; defaultPath: string; buttonLabel: string }) => Promise<string | null>
  /** Where the dialog starts (the Downloads folder): never a company folder. */
  defaultFolder: () => string
  /** Inside a company folder by name or by real location (`AllowedRoots.touches`). */
  insideCompanyFolder: (target: string) => boolean
  log?: Pick<Console, 'warn'>
}

const refuse = (message: string) => ({ ok: false as const, message })

/** An empty real folder that may be written into, a missing one (made here), or why not. */
async function prepareFolder(target: string): Promise<string | null> {
  const st = await fs.lstat(target).catch(() => null)
  if (!st) {
    // Its parent must exist: the dialog chose it. Not recursive: nothing else is made.
    await fs.mkdir(target)
    return null
  }
  if (!st.isDirectory() || (await fs.readdir(target)).length > 0) return MANUAL_WORDS.notEmpty
  return null
}

export function registerManualIpc<E extends IpcInvokeEvent>(ipc: IpcRegistrar<E>, deps: ManualIpcDeps<E>): void {
  const log = deps.log ?? console

  ipc.handle('manual:open', async (event, pageId, anchor): Promise<ManualOpenResult> => {
    if (!deps.fromMainWindow(event)) return refuse(MANUAL_WORDS.unavailable)
    if (!isManualPageId(pageId)) return refuse(MANUAL_WORDS.noPage)
    // The page as it is now: if it reloads while the manual is fetched, nothing is registered for it.
    const ticket = deps.views.begin(event.sender.id)
    const copy = await deps.site.current()
    if (copy.kind === 'none') return refuse(MANUAL_WORDS.unreachable)
    if (copy.kind === 'missing') return refuse(MANUAL_WORDS.missing)
    const name = manualPageFile(pageId)
    if (!copy.manifest.files.some(f => f.path === name)) return refuse(MANUAL_WORDS.noPage)
    let realFolder: string
    try {
      realFolder = await fs.realpath(copy.dir)
    } catch {
      return refuse(MANUAL_WORDS.unavailable)
    }
    // The grant is the copy's folder: its pages, its stylesheet and its pictures, nothing else.
    const fragment = isManualAnchor(anchor) ? `#${encodeURIComponent(anchor)}` : ''
    const viewId = await deps.views.open({ root: copy.dir, folder: copy.dir, realFolder, name }, ticket, fragment)
    return viewId === null ? refuse(MANUAL_WORDS.unavailable) : { ok: true, viewId }
  })

  ipc.handle('manual:export', async (event): Promise<ManualExportResult> => {
    if (!deps.fromMainWindow(event)) return refuse(MANUAL_WORDS.unavailable)
    const chosen = await deps.chooseFolder({
      title: MANUAL_WORDS.saveTitle,
      defaultPath: path.join(deps.defaultFolder(), MANUAL_WORDS.defaultFolderName),
      buttonLabel: MANUAL_WORDS.saveButton,
    })
    if (!chosen) return { ok: false, cancelled: true }
    const target = path.resolve(chosen)
    // A company folder is synced to everyone (and a working folder is the company's work): never there.
    if (!path.isAbsolute(chosen) || deps.insideCompanyFolder(target)) return refuse(MANUAL_WORDS.insideCompany)
    const copy = await deps.site.current()
    if (copy.kind === 'none') return refuse(MANUAL_WORDS.unreachable)
    if (copy.kind === 'missing') return refuse(MANUAL_WORDS.missing)
    try {
      const refusal = await prepareFolder(target)
      if (refusal) return refuse(refusal)
      // Checked again once the folder exists: a link put there meanwhile must not lead into a company folder.
      if (deps.insideCompanyFolder(target)) return refuse(MANUAL_WORDS.insideCompany)
      await deps.site.writeTo(copy, target)
      return { ok: true, folder: target }
    } catch (err) {
      log.warn(`[manual] Could not write the manual (${err instanceof Error ? (err as NodeJS.ErrnoException).code ?? err.name : 'error'})`)
      return refuse(MANUAL_WORDS.writeFailed)
    }
  })
}
