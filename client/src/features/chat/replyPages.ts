import { createContext } from 'react'
import type { ReplyPageSaveResult } from '../../../shared/reply-pages'

/**
 * What a rich reply's ［大きく見る］［ページとして残す］ may do in this conversation (ChatConversation.tsx): keep the page
 * in the member's 今日のフォルダ (main decides where: `replyPage:save`). Null where there is no today folder (a
 * consultation's own window, no department here): those two buttons are not shown.
 */
export interface ReplyPages {
  /** Pages already kept are remembered per conversation (the same reply opens the same file). */
  scope: () => string
  save: (html: string) => Promise<ReplyPageSaveResult>
  /** A page kept earlier is still where it was (the member may have moved or deleted it). */
  stillThere: (filePath: string) => Promise<boolean>
}

export const ReplyPagesContext = createContext<ReplyPages | null>(null)

export interface KeptPage { path: string; name: string }
export type KeepOutcome = { kind: 'kept'; page: KeptPage } | { kind: 'failed'; error: string } | { kind: 'skipped' }

/** Pages already kept, per conversation and reply text: the same reply opens the same file (≤ 100 kept). */
const keptPages = new Map<string, KeptPage>()
function remember(key: string, page: KeptPage) {
  keptPages.set(key, page)
  if (keptPages.size > 100) keptPages.delete(keptPages.keys().next().value as string)
}
/** Replies being kept now: a press meanwhile, from any button or view of the reply, keeps nothing more. */
const keeping = new Set<string>()

/**
 * The one way a reply becomes a page, for every button (the reply's ［大きく見る］［ページとして残す］ and the long reply's
 * line): never while the reply is still being written (`skipped`), one keep at a time per reply (a press meanwhile is
 * `skipped`), and the same file again while it is still there (moved or deleted by the member: kept again).
 */
export async function keepReplyPage(pages: ReplyPages, text: string, writing: boolean, page: () => string): Promise<KeepOutcome> {
  if (writing) return { kind: 'skipped' }
  const key = `${pages.scope()}|${text}`
  if (keeping.has(key)) return { kind: 'skipped' }
  keeping.add(key)
  try {
    const known = keptPages.get(key)
    if (known && await pages.stillThere(known.path)) return { kind: 'kept', page: known }
    const saved = await pages.save(page())
    if (!saved.success) return { kind: 'failed', error: saved.error }
    const kept = { path: saved.path, name: saved.name }
    remember(key, kept)
    return { kind: 'kept', page: kept }
  } catch {
    return { kind: 'failed', error: 'ページを保存できませんでした。もう一度試してください。' }
  } finally {
    keeping.delete(key)
  }
}
