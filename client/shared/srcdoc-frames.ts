// A frame the app filled with `srcdoc` (a rich reply's closed frame, its hidden measuring copy, the diagrams' drawing
// frame) shows that document and nothing else (chat-ui-and-history.md "Rich replies: the reply's closed frame"). The
// renderer's guards keep such a frame from navigating; main refuses it too (electron-adapter.ts
// `keepAppPageInWindow`), so a missed way would still not load a page — which would arrive without the frame's policy.

const SRCDOC = 'about:srcdoc'
const isSrcdoc = (url: string | undefined | null): boolean =>
  typeof url === 'string' && (url === SRCDOC || url.startsWith(`${SRCDOC}#`))

export interface FrameNavigation {
  /** Where the frame being navigated is now. */
  frameUrl: string | undefined | null
  /** Where each frame above it is now, its parent first (up to the window's page). */
  ancestorUrls: ReadonlyArray<string | undefined | null>
  /** Where the frame that started the navigation is, when known. */
  initiatorUrl: string | undefined | null
  targetUrl: string
}

/**
 * May this frame navigation go ahead? A frame showing a srcdoc, a frame inside one (independent review: a nested
 * frame a missed way put there is at `about:blank`) and a navigation a srcdoc frame started (of another frame) may
 * only go to a srcdoc again — what the app does when it gives a frame its next document. Any other frame is not this
 * rule's (the plugin frames and the PDF preview have their own).
 */
export function srcdocFrameNavigationAllowed({ frameUrl, ancestorUrls, initiatorUrl, targetUrl }: FrameNavigation): boolean {
  const concerned = isSrcdoc(frameUrl) || ancestorUrls.some(isSrcdoc) || isSrcdoc(initiatorUrl)
  return !concerned || isSrcdoc(targetUrl)
}
