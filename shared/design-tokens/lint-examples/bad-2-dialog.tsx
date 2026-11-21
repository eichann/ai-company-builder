// Must fail (13 findings): a dialog written the way the app writes them today (scrim, title, type steps, danger colour all ad hoc).
export function Dialog() {
  return (
    <div className="fixed inset-0 z-[60] bg-black/50">
      <div className="rounded-2xl bg-white shadow-xl dark:bg-zinc-800">
        <h2 className="text-[15px] font-semibold">削除しますか</h2>
        <p className="text-[12.5px] text-gray-500 dark:text-zinc-400">元に戻せません</p>
        <button className="bg-red-500 text-white disabled:opacity-40">削除</button>
      </div>
    </div>
  )
}
