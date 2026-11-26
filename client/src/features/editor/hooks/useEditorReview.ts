// The editor reaches the document review (features/doc-review) only here, in
// MarkdownPreviewPane and through MarkdownDiffView (boundary test: editor -> doc-review).
import { useEffect } from 'react'
import { useMarkdownReview } from '../../doc-review/hooks/useMarkdownReview'
import { useTextSelection } from '../../doc-review/hooks/useTextSelection'
import { markReviewSeen } from '../../doc-review/model'
import { useAuthStore } from '../../../stores/authStore'
import { isHtmlFile, isMarkdownFile } from '../fileKinds'
import { htmlQuoteFinder } from '../htmlReview'

/**
 * The review of the active document (Markdown, or HTML in its view), the text selection that starts a
 * comment in a Markdown preview, and its 「seen」 mark. An HTML document's quotes are its page's words.
 */
export function useEditorReview(activeFilePath: string | null, content: string) {
  const authUser = useAuthStore(state => state.user)
  const html = !!activeFilePath && isHtmlFile(activeFilePath)
  const review = useMarkdownReview(activeFilePath, authUser?.name || 'Anonymous', authUser?.email || '', authUser?.id, html ? htmlQuoteFinder : undefined)
  const textSelection = useTextSelection(
    review.isReviewing,
    content,
    review.addComment,
  )

  // Mark reviews as seen when user opens a file with reviews
  useEffect(() => {
    if (!activeFilePath || !(isMarkdownFile(activeFilePath) || isHtmlFile(activeFilePath))) return
    if (review.reviews.length === 0 && !review.loading) return
    if (review.loading) return
    // Reconstruct review file names from review IDs
    const docName = activeFilePath.split('/').pop() || ''
    const reviewFileNames = review.reviews.map(r => `${docName}.review.${r.id}.json`)
    if (reviewFileNames.length > 0) {
      markReviewSeen(activeFilePath, reviewFileNames)
    }
  }, [activeFilePath, review.reviews, review.loading])

  return { review, textSelection }
}

export type EditorReview = ReturnType<typeof useEditorReview>
