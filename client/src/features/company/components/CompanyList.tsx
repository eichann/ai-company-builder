import { Buildings, Plus } from '@phosphor-icons/react'
import type { CompanyInfo } from '../../../../shared/ipc-contract'
import { ChoiceButton, ErrorNotice, ScreenHeading } from './SelectorParts'

export function CompanyList({ companies, error, canCreate, onSelect, onCreate }: {
  companies: CompanyInfo[]
  error: string | null
  /** May this account create a company (model.ts offersCompanyCreation)? */
  canCreate: boolean
  onSelect: (company: CompanyInfo) => void
  onCreate: () => void
}) {
  return (
    <div className="space-y-6">
      <ScreenHeading icon={Buildings} title="会社を選択">
        {canCreate ? '作業する会社を選択するか、新しく作成してください' : '作業する会社を選択してください'}
      </ScreenHeading>

      <ErrorNotice error={error} />

      <div className="space-y-3">
        {companies.map(company => (
          <ChoiceButton
            key={company.id}
            onClick={() => onSelect(company)}
            icon={<Buildings size={20} className="text-accent" weight="duotone" />}
            title={company.name}
            detail={company.role === 'owner' ? 'オーナー' : 'メンバー'}
          />
        ))}

        {companies.length === 0 && (
          <div className="text-center py-8 text-text-secondary">
            {canCreate
              ? 'まだ会社がありません。新しく作成してください。'
              : 'まだ会社に参加していません。会社に参加するには、届いた招待リンクを開いてください。招待が届いていない場合は、会社の管理者かサービスの運用担当者にお問い合わせください。'}
          </div>
        )}

        {canCreate && (
          <ChoiceButton
            onClick={onCreate}
            dashed
            arrow={false}
            icon={<Plus size={20} className="text-accent" />}
            title="新しい会社を作成"
            detail="AIエージェントと一緒に働く会社を作りましょう"
          />
        )}
      </div>
    </div>
  )
}
