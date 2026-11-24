// One item's value as the member edits it (C1): 確度 from the business's stages, 金額 a number, 計上月 months with amounts,
// 受注予定日 a day, 商談の記録 a text. The value stays the file's shape (`SetUpdateValue`), so what is applied is what the AI's file allows.
import { Plus, X } from '@phosphor-icons/react'
import type { SetUpdateValue } from '../../../../shared/after-meeting'
import { editorOf, type DraftItem } from '../model'

const FIELD = 'rounded-control border border-border-control bg-bg px-2 py-1 text-body text-text focus:border-focus-border focus:outline-none disabled:opacity-disabled'

export function ValueEditor({ item, stages, disabled, onChange }: { item: DraftItem; stages: string[] | null; disabled: boolean; onChange: (v: SetUpdateValue) => void }) {
  const kind = editorOf(item)
  const label = `${item.取引} の ${item.項目}`
  if (kind === 'stage' && stages) {
    const value = typeof item.値 === 'string' ? item.値 : String(item.値)
    return (
      <select aria-label={label} className={FIELD} disabled={disabled} value={value} onChange={e => onChange(e.target.value)}>
        {!stages.includes(value) && <option value={value}>{value || '（選んでください）'}</option>}
        {stages.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
    )
  }
  if (kind === 'date') {
    return <input aria-label={label} type="date" className={FIELD} disabled={disabled} value={typeof item.値 === 'string' ? item.値 : ''} onChange={e => onChange(e.target.value)} />
  }
  if (kind === 'number') {
    return (
      <input aria-label={label} type="number" inputMode="numeric" className={`${FIELD} w-40`} disabled={disabled}
        value={typeof item.値 === 'number' ? item.値 : ''} onChange={e => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))} />
    )
  }
  if (kind === 'months') {
    const rows = Array.isArray(item.値) ? item.値 : [{ 月: '', 金額: Number(item.値) || 0 }]
    const set = (i: number, row: { 月: string; 金額: number }) => onChange(rows.map((r, j) => (j === i ? row : r)))
    return (
      <div className="space-y-1" role="group" aria-label={label}>
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input aria-label={`${label}（${i + 1}つ目の月）`} type="month" className={FIELD} disabled={disabled} value={r.月} onChange={e => set(i, { ...r, 月: e.target.value })} />
            <input aria-label={`${label}（${i + 1}つ目の金額）`} type="number" inputMode="numeric" className={`${FIELD} w-36`} disabled={disabled} value={Number.isFinite(r.金額) ? r.金額 : ''}
              onChange={e => set(i, { ...r, 金額: e.target.value === '' ? Number.NaN : Number(e.target.value) })} />
            {rows.length > 1 && (
              <button type="button" aria-label={`${i + 1}つ目の月を外す`} disabled={disabled} onClick={() => onChange(rows.filter((_, j) => j !== i))}
                className="rounded-small p-1 text-text-muted hover:bg-surface-sunken hover:text-text"><X size={12} /></button>
            )}
          </div>
        ))}
        {rows.length < 24 && (
          <button type="button" disabled={disabled} onClick={() => onChange([...rows, { 月: '', 金額: 0 }])}
            className="inline-flex items-center gap-1 text-small text-link hover:text-link-hover"><Plus size={12} />月を足す</button>
        )}
      </div>
    )
  }
  if (kind === 'long') {
    return <textarea aria-label={label} rows={4} className={`${FIELD} w-full`} disabled={disabled} value={String(item.値)} onChange={e => onChange(e.target.value)} />
  }
  return <input aria-label={label} type="text" className={`${FIELD} w-full`} disabled={disabled} value={String(item.値)} onChange={e => onChange(e.target.value)} />
}
