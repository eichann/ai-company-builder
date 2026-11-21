// Must fail (10 findings): Tailwind 4 spellings the admin console can use — the `(--x)` shorthand with a
// variable that is not a token, the newer palettes, and scale steps outside the approved ones.
export function Card() {
  return (
    <div className="bg-(--brand-tint) w-(--sidebar-w) bg-olive-500 text-taupe-700 rounded-4xl rounded-t-xs shadow-2xs drop-shadow-md inset-shadow-sm text-shadow-lg">
      {/* Passes: a token or a Radix run-time measure in the shorthand, a colon inside a variant's brackets. */}
      <div className="w-(--size-menu) bg-(--color-danger-bg) max-h-(--radix-select-content-available-height) has-[:focus]:bg-surface-sunken drop-shadow-none" />
    </div>
  )
}
