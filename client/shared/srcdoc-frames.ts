// A frame the app filled with `srcdoc` (a rich reply's closed frame, its hidden measuring copy, the diagrams' drawing
// frame) shows that document and nothing else (chat-ui-and-history.md "Rich replies: the reply's closed frame"). The
// renderer's guards keep such a frame from navigating; main refuses it too (electron-adapter.ts
// `keepAppPageInWindow`), so a missed way would still not load a page — which would arrive without the frame's policy.

const SRCDOC = 'about:srcdoc'
const isSrcdoc = (url: string | undefined | null): boolean =>
  typeof url === 'string' && (url === SRCDOC || url.startsWith(`${SRCDOC}#`))

/**
 * May a frame now at `frameUrl` navigate to `targetUrl`? A frame showing a srcdoc only to a srcdoc again (the app
 * gave it a new one); any other frame is not this rule's (the plugin frames and the PDF preview have their own).
 */
export function srcdocFrameNavigationAllowed(frameUrl: string | undefined | null, targetUrl: string): boolean {
  return !isSrcdoc(frameUrl) || isSrcdoc(targetUrl)
}
