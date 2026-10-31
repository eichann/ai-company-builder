import { useState } from 'react'
import { ArrowRight, Plus, SpinnerGap } from '@phosphor-icons/react'
import type { CompanyInfo } from '../../../../shared/ipc-contract'
import { createCompany } from '../api'
import { BACK_BUTTON, ErrorNotice, PRIMARY_BUTTON, ScreenHeading } from './SelectorParts'

/** Creating a company; rendered only while shown, so 戻る discards the name and the error. */
export function CreateCompanyForm({ onCreated, onBack }: {
  onCreated: (company: CompanyInfo) => void
  onBack: () => void
}) {
  const [name, setName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function create() {
    if (!name.trim()) return
    setIsCreating(true)
    setError(null)
    try {
      const result = await createCompany(name.trim())
      if (result.success && result.data) {
        onCreated(result.data)
        return
      }
      setError(result.error || 'Failed to create company')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    }
    setIsCreating(false)
  }

  return (
    <div className="space-y-6">
      <ScreenHeading icon={Plus} title="新しい会社を作成">
        会社名を入力してください
      </ScreenHeading>

      <ErrorNotice error={error} />

      <div>
        <label className="block text-sm text-text-secondary mb-2">
          会社名
        </label>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="例: 株式会社サンプル"
          className="w-full bg-sidebar-bg border border-border rounded-lg px-4 py-3 text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
          autoFocus
        />
      </div>

      <div className="flex gap-3">
        <button onClick={onBack} className={BACK_BUTTON}>
          戻る
        </button>
        <button onClick={create} disabled={!name.trim() || isCreating} className={PRIMARY_BUTTON}>
          {isCreating ? (
            <SpinnerGap size={20} className="animate-spin" />
          ) : (
            <>
              作成
              <ArrowRight size={18} />
            </>
          )}
        </button>
      </div>
    </div>
  )
}
