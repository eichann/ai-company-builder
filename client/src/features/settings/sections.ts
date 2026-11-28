// The settings' sections, ordered by what the member wants to do (UX stage 3, item 19, owner 案A):
// AI / つないでいるサービス / 知らせ / ファイルと同期, with the rarely needed ones folded under 詳しい設定.
// Pure data: today's panel and a later frame (段5: a destination with tabs) read the same list.

export type SettingsSectionId =
  | 'mine' | 'jobs' | 'input'
  | 'tools' | 'google' | 'slack' | 'browser' | 'ownkeys'
  | 'absences'
  | 'sync' | 'autosync'
  | 'gitignore' | 'envkeys' | 'aienv'

export type SettingsGroupId = 'ai' | 'services' | 'notices' | 'files' | 'advanced'

/** What a company or member must have for a section to show (nothing = always). */
type Needs = 'sharedFolder' | 'browserSites'

export interface SettingsSectionInfo {
  id: SettingsSectionId
  label: string
  needs?: Needs
}

export interface SettingsGroup {
  id: SettingsGroupId
  label: string
  /** Folded until opened (or until one of its sections is the one shown). */
  folded?: boolean
  items: SettingsSectionInfo[]
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  { id: 'ai', label: 'AI', items: [
    { id: 'mine', label: 'AI に任せること' },
    { id: 'jobs', label: '定期の仕事' },
    { id: 'input', label: '入力（音声・候補）' },
  ] },
  { id: 'services', label: 'つないでいるサービス', items: [
    { id: 'tools', label: 'サービスの一覧' },
    { id: 'google', label: 'Google' },
    { id: 'slack', label: 'Slack' },
    { id: 'browser', label: 'ブラウザ操作', needs: 'browserSites' },
    { id: 'ownkeys', label: 'Claude・Gemini などの鍵' },
  ] },
  { id: 'notices', label: '知らせ', items: [
    { id: 'absences', label: '不在と代わりの人' },
  ] },
  { id: 'files', label: 'ファイルと同期', items: [
    { id: 'sync', label: 'この PC に置くフォルダ', needs: 'sharedFolder' },
    { id: 'autosync', label: '自動同期', needs: 'sharedFolder' },
  ] },
  { id: 'advanced', label: '詳しい設定', folded: true, items: [
    { id: 'gitignore', label: '同期しないファイル', needs: 'sharedFolder' },
    { id: 'envkeys', label: 'API キー・環境変数（この PC）' },
    { id: 'aienv', label: 'AIに渡す環境変数' },
  ] },
]

export interface SettingsContext {
  /** The company keeps a shared company folder (without it nothing is synced or downloaded). */
  sharedFolder: boolean
  /** The member's browser operation policy is on with at least one site. */
  browserSites: boolean
}

/** The groups and sections this company and member see; a group left empty is not shown. */
export function settingsGroupsFor(ctx: SettingsContext): SettingsGroup[] {
  return SETTINGS_GROUPS
    .map(group => ({ ...group, items: group.items.filter(item => !item.needs || ctx[item.needs]) }))
    .filter(group => group.items.length > 0)
}

export function shownSectionIds(ctx: SettingsContext): SettingsSectionId[] {
  return settingsGroupsFor(ctx).flatMap(group => group.items.map(item => item.id))
}

/** The section to open: the one asked for when this member sees it, else 「AI に任せること」. */
export function sectionToOpen(asked: SettingsSectionId | undefined, ctx: SettingsContext): SettingsSectionId {
  return asked && shownSectionIds(ctx).includes(asked) ? asked : 'mine'
}

export function sectionLabel(id: SettingsSectionId): string {
  for (const group of SETTINGS_GROUPS) {
    const item = group.items.find(x => x.id === id)
    if (item) return item.label
  }
  return id
}

export function groupOf(id: SettingsSectionId): SettingsGroupId | null {
  return SETTINGS_GROUPS.find(group => group.items.some(item => item.id === id))?.id ?? null
}

/**
 * Sections whose typed input survives moving to another section (the panel keeps them mounted):
 * the .env keys and 同期しないファイル are asked about only when the settings close.
 */
export const KEPT_DRAFT_SECTIONS: ReadonlySet<SettingsSectionId> = new Set(['envkeys', 'gitignore'])
