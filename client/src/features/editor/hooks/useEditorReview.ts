// The editor reaches the document review (features/doc-review) only here, in
// MarkdownPreviewPane and through MarkdownDiffView (boundary test: editor -> doc-review).
import { useEffect } from 'react'
import { useMarkdownReview } from '../../doc-review/hooks/useMarkdownReview'
import { useTextSelection } from '../../doc-review/hooks/useTextSelection'
import { markReviewSeen } from '../../doc-review/model'
import { useAuthStore } from '../../../stores/authStore'
import { isMarkdownFile } from '../fileKinds'

/** The review of the active Markdown file, the text selection that starts a comment, and its 「seen」 mark. */
export function useEditorReview(activeFilePath: string | null, content: string) {
  const authUser = useAuthStore(state => state.user)
  const review = useMarkdownReview(activeFilePath, authUser?.name || 'Anonymous', authUser?.email || '', authUser?.id)
  const textSelection = useTextSelection(
    review.isReviewing,
    content,
    review.addComment,
  )

  // Mark reviews as seen when user opens a file with reviews
  useEffect(() => {
    if (!activeFilePath || !isMarkdownFile(activeFilePath)) return
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
