/**
 * 「もう一方の AI に聞く」 per company (services/second-opinion-setting.ts), behind the company
 * handle: every method is limited to the handle's company.
 */
export interface StoredSecondOpinionSetting {
  allowed: boolean
  updatedAt: string
  updatedBy: string | null
}

export interface SecondOpinionSettingRepository {
  /** null = never set (a company created after the setting existed): not allowed. */
  get(): StoredSecondOpinionSetting | null
  save(stored: StoredSecondOpinionSetting): void
}
