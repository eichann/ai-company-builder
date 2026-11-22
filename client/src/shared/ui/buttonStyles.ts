// The colours of a primary action (design-system.md "Primary actions (P2a, done)"): the one
// button of a screen, card or dialog that does what the member came to do. Fill, hover, pressed,
// text, focus ring and the disabled fade all come from the `primary` token set, so the four
// primary colours the app had (accent blue, indigo, blue-600, black) are one. Only colours: the
// caller takes its size from `BUTTON_SIZE`. Not for links (`link`), selected rows
// or chips (`selected-*`), counts and new-item dots (`unread`) or AI marks (`ai-*`).
export const PRIMARY_ACTION =
  'bg-primary text-on-primary enabled:hover:bg-primary-hover enabled:active:bg-primary-active disabled:opacity-disabled disabled:cursor-not-allowed ' +
  'focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring focus-visible:ring-offset-focus focus-visible:ring-offset-bg'

// The two button sizes (design-system.md "Sizes, type and corners (P3, done)"): height, side padding
// and type from the tokens — `md` the app's control height (32px), `sm` the compact one (28px). A
// caller adds its shape (`rounded-control`) and colours (`PRIMARY_ACTION`, the Button variants).
export const BUTTON_SIZE = {
  md: 'h-control px-control-x text-body',
  sm: 'h-control-sm px-control-sm-x text-small',
} as const
