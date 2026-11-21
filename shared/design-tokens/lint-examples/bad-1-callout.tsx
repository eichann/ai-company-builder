// Must fail (5 findings): the admin console's hand-written warning callout today (integrations/page.tsx and others).
export function Notice() {
  return <div className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-amber-900">注意</div>
}
