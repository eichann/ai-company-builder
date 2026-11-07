// ACB foundation: dropping something on a record links it (owner decision 2026-11-03), used by the
// tasks feature (the task card, the list's rows) and the records feature (record card, 案件).
import { useState, type DragEvent } from 'react'
import { useInterval } from './useInterval'
import { isPathWithin, normalizePathSeparators } from '../lib/path'
import type { DropLinkChoice, DroppedThing } from '../../../shared/link-drop'
import { draggedConsultation, draggedFilePaths, draggedRecord, isLinkableDrag } from '../lib/dragTypes'
import { dropLinkOnRecord, setConsultationTopic, topicTitles, undoDropLink, type ConsultationTopics, type LinkDrops } from '../ipc/link-drop'
import { switchTopicQuestion, topicOnDrop } from '../../../shared/consultation-topics'

/** What the last drop left: what happened with ［取り消す］, a question with its choices, or why not. */
export type LinkDropNotice =
  | { kind: 'done'; text: string; undo: (() => Promise<void>) | null }
  | { kind: 'choose'; question: string; choices: DropLinkChoice[]; pick: (link: string) => Promise<void>; cancel: () => void }
  /** A consultation about another record: 「『A』の相談を『B』の相談に切り替えますか？」［切り替える］［このまま］. */
  | { kind: 'switch'; question: string; confirm: () => Promise<void>; keep: () => void }
  | { kind: 'error'; text: string }

export interface LinkDropOptions {
  companyId: string
  /** The member's company folder (a dragged file's path is named inside it). */
  rootPath: string
  /** The record's kind name (やること, 案件): 「…をこのやることについての相談にしました」. */
  targetWord: string
  /** Something was linked or put back (the card / the list reads again). */
  onChanged?: () => void
  /**
   * A company without the shared folder (records.md "File links without the shared folder"): a
   * dropped file of the working folder is linked as the member's own (`local`, seen by them alone).
   */
  localFiles?: boolean
  ports?: { links?: LinkDrops; topics?: ConsultationTopics }
}

/**
 * How long a refusal (「同じものどうしはつなげません。」) stays at the place it was dropped on (owner
 * 2026-11-03, 使い心地のメモ #4); what was done (with ［取り消す］) and a question stay until the next drop.
 */
export const DROP_REFUSAL_MS = 5000

const companyPath = (path: string, rootPath: string): string | null => {
  const p = normalizePathSeparators(path)
  const root = normalizePathSeparators(rootPath).replace(/\/+$/, '')
  return root && isPathWithin(p, root) && p !== root ? p.slice(root.length + 1) : null
}

/**
 * What a drop on a record does: a file or folder from the tree, a record (list row, 探す, a tab)
 * or a consultation. Links go through `tasks:dropLink` (the link the two types allow, or a
 * choice); a consultation becomes one about the record (its topic, this PC's history). One notice
 * per target, so a drop on a list row speaks where the list shows its messages.
 */
export function useLinkDrop({ companyId, rootPath, targetWord, onChanged, localFiles = false, ports = {} }: LinkDropOptions) {
  // The notice belongs to the record dropped on (a list row speaks under that row), named by each
  // caller: an answer arriving after another drop still speaks where its own drop was.
  const [state, setState] = useState<{ notice: LinkDropNotice; target: string; at: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const setNotice = (target: string, notice: LinkDropNotice | null) => setState(notice ? { notice, target, at: Date.now() } : null)
  // A refusal fades after DROP_REFUSAL_MS (checked while one shows; stopped on unmount with the interval).
  useInterval(() => setState(s => (s?.notice.kind === 'error' && Date.now() - s.at >= DROP_REFUSAL_MS ? null : s)), state?.notice.kind === 'error' ? 250 : null)

  const link = async (targetId: string, dropped: DroppedThing, choice?: string): Promise<void> => {
    setBusy(true)
    try {
      const r = await dropLinkOnRecord(companyId, targetId, dropped, choice, ports.links)
      if (!r.success) { setNotice(targetId, { kind: 'error', text: r.error }); return }
      if ('choose' in r) {
        setNotice(targetId, { kind: 'choose', question: r.question, choices: r.choose, pick: l => link(targetId, dropped, l), cancel: () => setNotice(targetId, null) })
        return
      }
      const undo = r.done.undo
      setNotice(targetId, {
        kind: 'done', text: r.done.text,
        undo: undo ? async () => {
          const u = await undoDropLink(companyId, undo.recordId, undo.version, ports.links)
          setNotice(targetId, u.success ? { kind: 'done', text: '取り消しました', undo: null } : { kind: 'error', text: u.error })
          onChanged?.()
        } : null,
      })
      onChanged?.()
    } finally {
      setBusy(false)
    }
  }

  const switchTo = async (targetId: string, sessionId: string, title: string, before: string | undefined): Promise<void> => {
    const set = async (to: string | null) => (await setConsultationTopic(companyId, sessionId, to, ports.topics).catch(() => null)) !== null
    if (!await set(targetId)) { setNotice(targetId, { kind: 'error', text: '相談が見つかりませんでした。消されたかもしれません。' }); return }
    setNotice(targetId, {
      kind: 'done', text: `「${title || '相談'}」をこの${targetWord}についての相談にしました`,
      undo: async () => {
        setNotice(targetId, await set(before ?? null) ? { kind: 'done', text: '取り消しました', undo: null } : { kind: 'error', text: 'できませんでした。' })
        onChanged?.()
      },
    })
    onChanged?.()
  }

  const topic = async (targetId: string, sessionId: string, title: string, before: string | undefined): Promise<void> => {
    const decision = topicOnDrop(before, targetId)
    if (decision === 'same') { setNotice(targetId, { kind: 'done', text: `「${title}」はもうこの${targetWord}についての相談です`, undo: null }); return }
    // About another record already: ask first (owner 2026-11-03, the same question as the chat's drop).
    if (decision === 'ask' && before) {
      const titles = await topicTitles(companyId, [before, targetId], ports.topics)
      setNotice(targetId, {
        kind: 'switch', question: switchTopicQuestion(titles[before] ?? 'いまの主題', titles[targetId] ?? `この${targetWord}`),
        confirm: () => switchTo(targetId, sessionId, title, before), keep: () => setNotice(targetId, null),
      })
      return
    }
    await switchTo(targetId, sessionId, title, before)
  }

  /** Drop handler for `targetId`: true when it took the drop. */
  const drop = (targetId: string, e: Pick<DragEvent, 'dataTransfer'>): boolean => {
    const data = e.dataTransfer
    const record = draggedRecord(data)
    if (record) { void link(targetId, { kind: 'record', id: record.id }); return true }
    const consultation = draggedConsultation(data)
    if (consultation) { void topic(targetId, consultation.sessionId, consultation.title, consultation.topicRecordId); return true }
    // The first dragged path inside the company folder (one link per drop).
    const path = draggedFilePaths(data).map(p => companyPath(p, rootPath)).find((p): p is string => p !== null)
    if (path) { void link(targetId, localFiles ? { kind: 'path', path, local: true } : { kind: 'path', path }); return true }
    return false
  }

  return {
    notice: state?.notice ?? null,
    /** The record the notice is about (the one dropped on). */
    target: state?.target ?? null,
    busy, clear: () => setState(null),
    accepts: (e: Pick<DragEvent, 'dataTransfer'>) => isLinkableDrag(e.dataTransfer),
    drop,
  }
}
