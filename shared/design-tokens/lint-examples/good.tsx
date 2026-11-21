// Must pass (0 findings): variants such as data-[state=open]:, aria-[selected=true]:, group-data-[…]: and [&>svg]: are not judged.
export function Row({ selected }: { selected: boolean }) {
  return (
    <div
      aria-selected={selected}
      className="flex h-control items-center gap-2 rounded-small px-2 text-body text-text hover:bg-surface-sunken aria-[selected=true]:bg-selected-bg data-[state=open]:bg-surface-sunken group-data-[disabled=true]:opacity-disabled [&>svg]:size-4"
    >
      <span className="text-small text-text-muted">3日前</span>
      <span className="rounded-full bg-primary px-1 text-caption text-on-primary">2</span>
      <div className="rounded-control border border-warning-border bg-warning-bg p-3 text-warning-text shadow-pop z-menu">注意</div>
    </div>
  )
}
