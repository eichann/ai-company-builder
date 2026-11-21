// The colours of a primary action (design-system.md "Primary actions (P2a, done)"): the one
// button of a screen, card or dialog that does what the member came to do. Fill, hover, pressed,
// text, focus ring and the disabled fade all come from the `primary` token set, so the four
// primary colours the app had (accent blue, indigo, blue-600, black) are one. Only colours: the
// caller keeps its own size and shape (sizes move in P3). Not for links (`link`), selected rows
// or chips (`selected-*`), counts and new-item dots (`unread`) or AI marks (`ai-*`).
export const PRIMARY_ACTION =
  'bg-primary text-on-primary hover:bg-primary-hover active:bg-primary-active disabled:opacity-disabled ' +
  'focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring focus-visible:ring-offset-focus focus-visible:ring-offset-bg'
