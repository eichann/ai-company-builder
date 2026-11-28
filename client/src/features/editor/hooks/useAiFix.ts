import { useCallback, useRef, useState, type MutableRefObject } from 'react'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { INLINE_FIX_LIMITS, INLINE_FIX_REFUSAL_TEXT, restoreBrackets } from '../../../../shared/inline-fix'
import type { InPlacePassage, InPlaceSurface } from '../inPlaceEditing'
import type { AiFixPart } from '../selectionSlot'
import type { AiFixPhase } from '../components/AiFixCard'

/** A request to the AI and where it is: shown under its passage until adopted or put away. */
export interface AiFix {
  id: number
  /** What the card names as asked. */
  ask: string
  passage: InPlacePassage
  /** The card's place in the document's flow (a widget the surface holds). */
  host: HTMLElement
  phase: AiFixPhase
  /** It reflects a review comment (adopting it then says the comment stays unresolved). */
  fromComment: boolean
}

const REFUSED = {
  changed: 'AI に頼んでいる間に文書が変わったため、この直し案は使えません。もう一度頼んでください。',
  unwritable: 'この直し案は、ファイルにそのまま書き戻せない書き方のため使えません。',
  tooLong: '選んだ所が長すぎるため、AI に頼めませんでした。もう少し短い所を選んでください。',
  noPassage: '選んだ所を AI に渡せませんでした。文字を選び直してから、もう一度頼んでください。',
  noQuote: 'コメントの言葉が文書に見つからないため、AI に頼めませんでした。',
}

/**
 * 「AI に直してもらう」 on a document edited in place (files-and-editor.md "Asking the AI to fix a
 * passage"): the one request at a time, its answer checked against the document as it is now, and
 * adopting it through the surface (the write-back). The answer of a request put away is dropped.
 */
export function useAiFix(part: AiFixPart | undefined, fileName: string, surfaceRef: MutableRefObject<InPlaceSurface | null>) {
  const [fix, setFix] = useState<AiFix | null>(null)
  // One line above the document (a refusal before anything was asked, a comment's fix adopted).
  const [notice, setNotice] = useState<{ text: string; fromComment: boolean } | null>(null)
  const fixRef = useLatestRef(fix)
  const seq = useRef(0)

  const putAway = useCallback(() => {
    const shown = fixRef.current
    if (shown) surfaceRef.current?.showBelow(shown.passage, null)
    fixRef.current = null
    setFix(null)
  }, [fixRef, surfaceRef])

  const ask = useCallback((passage: InPlacePassage | null, asked: string, comment?: { quote: string; body: string }) => {
    const surface = surfaceRef.current
    if (!part || !surface) return
    setNotice(null)
    if (!passage) { setNotice({ text: comment ? REFUSED.noQuote : REFUSED.noPassage, fromComment: false }); return }
    if (passage.markdown.length > INLINE_FIX_LIMITS.passage) { setNotice({ text: REFUSED.tooLong, fromComment: false }); return }
    putAway()
    const id = ++seq.current
    const host = document.createElement('div')
    surface.showBelow(passage, host)
    const next: AiFix = { id, ask: comment ? 'コメントを反映' : asked, passage, host, phase: { kind: 'waiting' }, fromComment: !!comment }
    fixRef.current = next
    setFix(next)
    // Only the passage and a little around it go (the whole file never does).
    void part.ask({
      ask: comment ? 'レビューのコメントを反映する' : asked,
      file: fileName.slice(0, INLINE_FIX_LIMITS.file),
      passage: passage.markdown,
      before: passage.before,
      after: passage.after,
      ...(comment ? { comment: { quote: comment.quote.slice(0, INLINE_FIX_LIMITS.commentQuote), body: comment.body.slice(0, INLINE_FIX_LIMITS.commentBody) } } : {}),
    })
      .catch(() => ({ ok: false as const, message: INLINE_FIX_REFUSAL_TEXT.failed }))
      .then(answer => {
        if (fixRef.current?.id !== id) return
        let phase: AiFixPhase
        if (!answer.ok) phase = { kind: 'refused', message: answer.message }
        else {
          const markdown = restoreBrackets(passage.markdown, answer.markdown)
          const preview = surfaceRef.current?.previewFix(passage, markdown) ?? { ok: false as const, reason: 'changed' as const }
          phase = preview.ok ? { kind: 'proposal', markdown, removed: preview.removed, added: preview.added } : { kind: 'refused', message: REFUSED[preview.reason] }
        }
        const updated = { ...next, phase }
        fixRef.current = updated
        setFix(updated)
      })
  }, [part, fileName, surfaceRef, fixRef, putAway])

  const adopt = useCallback(() => {
    const shown = fixRef.current
    if (!shown || shown.phase.kind !== 'proposal') return
    const result = surfaceRef.current?.adoptFix(shown.passage, shown.phase.markdown) ?? { ok: false as const, reason: 'changed' as const }
    if (!result.ok) {
      const updated = { ...shown, phase: { kind: 'refused' as const, message: REFUSED[result.reason] } }
      fixRef.current = updated
      setFix(updated)
      return
    }
    putAway()
    // The comment is never resolved for the member (owner decision): they check and press it.
    if (shown.fromComment) setNotice({ text: 'AI の直しを採用しました。コメントは解決にしていません。確かめて、よければレビューで［解決］を押してください。', fromComment: true })
    surfaceRef.current?.focus()
  }, [fixRef, surfaceRef, putAway])

  /** Whether a request is still open (its answer would be lost if the document were opened afresh). */
  const open = useCallback(() => fixRef.current !== null && fixRef.current.phase.kind !== 'refused', [fixRef])

  return { fix, notice, ask, adopt, putAway, open, closeNotice: () => setNotice(null) }
}
