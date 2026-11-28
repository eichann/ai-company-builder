// A rich reply kept as a page (chat-ui-and-history.md "Rich replies: ［大きく見る］［ページとして残す］［コードとして見る］").
//   replyPage:save — the chat hands over what the page holds and which consultation it is from; main alone decides
//   where it goes: the member's 今日のフォルダ's `ページ/` (`replyPageFolderOf`: only a today folder of the app's shape,
//   so never the company folder's top level and never anywhere a request names), named after the consultation's
//   title, created with `wx` (「名前 (2).html」 when taken: nothing is replaced). Checked like any write of the app
//   (files-and-editor.md): the allowed roots by name and real location (before and after the folder is made), a folder
//   not downloaded here, a reserved name. What it holds is the AI's HTML as written: the HTML viewer opens it in its
//   own isolated view (doc-frame.md), never the app's page.
import fs from 'fs'
import path from 'path'
import type { PathGuard } from '../ports'
import type { IpcRegistrar } from '../../ipc/registrar'
import { notDownloadedRefusal } from '../../file-guards'
import { replyPageFolderOf } from '../../../shared/reply-style'
import {
  REPLY_PAGE_MAX_CHARS, REPLY_PAGE_MAX_TRIES, replyPageBaseName, replyPageFileName,
  type ReplyPageConsultation, type ReplyPageSaveResult,
} from '../../../shared/reply-pages'

export interface ReplyPagesDeps {
  paths: PathGuard
  /** A folder name the member may not use (a private folder they cannot read); null to allow. */
  writeRefusal: (absPath: string) => Promise<string | null>
  /** The consultation's title as stored on this computer, or null. */
  consultationTitle: (companyId: string, sessionId: string) => string | null
}

const NO_PLACE = 'ページを置く今日のフォルダが見つかりません。設定で今日のフォルダの部署を確かめてください。'
const NOT_SAVED = 'ページを保存できませんでした。もう一度試してください。'
const PLAIN_ID = /^[\w-]{1,128}$/

const consultationOf = (value: unknown): ReplyPageConsultation | null => {
  if (!value || typeof value !== 'object') return null
  const { companyId, sessionId } = value as Record<string, unknown>
  return typeof companyId === 'string' && typeof sessionId === 'string' && PLAIN_ID.test(companyId) && PLAIN_ID.test(sessionId)
    ? { companyId, sessionId } : null
}

export function registerReplyPagesIpc(ipc: IpcRegistrar, deps: ReplyPagesDeps): void {
  const { paths } = deps
  ipc.handle('replyPage:save', async (_, rootPath: string, todayFolder: string, consultation: ReplyPageConsultation, html: string): Promise<ReplyPageSaveResult> => {
    try {
      if (typeof html !== 'string' || !html.trim() || html.length > REPLY_PAGE_MAX_CHARS) return { success: false, error: NOT_SAVED }
      const root = paths.validate(rootPath)
      const folder = replyPageFolderOf(root, todayFolder)
      if (!folder) return { success: false, error: NO_PLACE }
      // The department holding the today folder must be here (a department not downloaded, or none at all, is refused).
      const department = path.join(root, todayFolder.split('/')[0])
      if (!fs.existsSync(department) || !fs.statSync(department).isDirectory()) return { success: false, error: NO_PLACE }
      const refused = notDownloadedRefusal(folder) ?? await deps.writeRefusal(folder)
      if (refused) return { success: false, error: refused }
      // By real location before anything is made (a link on the way out is refused), and again once it is there.
      paths.validate(folder)
      await fs.promises.mkdir(folder, { recursive: true })
      const madeFolder = paths.validate(folder)
      const who = consultationOf(consultation)
      const base = replyPageBaseName(who ? deps.consultationTitle(who.companyId, who.sessionId) : null)
      for (let n = 1; n <= REPLY_PAGE_MAX_TRIES; n++) {
        const name = replyPageFileName(base, n)
        const file = paths.validate(path.join(madeFolder, name))
        try {
          await fs.promises.writeFile(file, html, { encoding: 'utf-8', flag: 'wx' })
          return { success: true, path: file, name }
        } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
        }
      }
      return { success: false, error: NOT_SAVED }
    } catch (error) {
      console.warn('[reply-pages] A reply page was not saved:', error instanceof Error ? error.message : error)
      return { success: false, error: NOT_SAVED }
    }
  })
}
