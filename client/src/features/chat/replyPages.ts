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
