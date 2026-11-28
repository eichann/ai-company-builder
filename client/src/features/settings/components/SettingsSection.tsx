// One settings section by its id, with no frame of its own: today's panel draws it beside its left list,
// a later frame (段5) can draw it in a tab. What a section has typed is asked through `unsaved`.
import { useEffect, useState, type ReactNode } from 'react'
import { VoiceShortcutSettings } from '../../voice/components/VoiceShortcutSettings'
import { VoicePromptSettings } from '../../voice/components/VoicePromptSettings'
import { AbsenceSection } from '../../absences/components/AbsenceSection'
import { JobsSection } from '../../jobs/components/JobsSection'
import { Callout, Card, SectionHeader, SubHeading } from '../../../shared/ui/primitives'
import type { BrowserSiteView } from '../../../../shared/browser-operation'
import type { DepartmentConfig } from '../../../types'
import { getGitBinaryStatus } from '../api'
import type { SettingsSectionId } from '../sections'
import type { SettingsUnsaved } from '../unsaved'
import type { EnvDraft } from '../hooks/useEnvDraft'
import type { GitignoreDraft } from '../hooks/useGitignoreDraft'
import { PromptSuggestionSettings } from './PromptSuggestionSettings'
import { AgentEnvSettings } from './AgentEnvSettings'
import { DownloadFoldersSection } from './DownloadFoldersSection'
import { AutoSyncSettings } from './AutoSyncSettings'
import { OwnKeysSection } from './OwnKeysSection'
import { GoogleSection } from './GoogleSection'
import { SlackSection } from './SlackSection'
import { ConnectToolsScreen } from './ConnectToolsScreen'
import { MySwitchesSection } from './MySwitchesSection'
import { JobRepeatAskSetting } from './JobRepeatAskSetting'
import { BrowserSection } from './BrowserSection'
import { EnvKeysSection } from './EnvKeysSection'
import { GitignoreSection } from './GitignoreSection'

export interface SettingsSectionProps {
  id: SettingsSectionId
  company: { id: string; rootPath: string }
  departments: DepartmentConfig[]
  unsaved: SettingsUnsaved
  /** The drafts that survive moving between sections (held by the frame). */
  env: EnvDraft
  gitignore: GitignoreDraft
  browserSites: BrowserSiteView[]
  /** Another section, when this one points there (「Google で許可」, 「Claude・Gemini などの鍵」を開く). */
  go: (id: SettingsSectionId) => void
  /** 「Claude・Gemini などの鍵」: the service to show first (from the chat's "no key" card). */
  focusService?: string
  /** 「AI に任せること」's rows the screen composes (今日のフォルダ, 前の日のタブ). */
  mineRows?: ReactNode
}

const PAGE = 'space-y-5 px-8 pb-8 pt-7'

export function SettingsSection(props: SettingsSectionProps) {
  const { id, company, unsaved, go } = props
  const ref = unsaved.refFor(id)
  switch (id) {
    case 'mine':
      return (
        <>
          <MySwitchesSection key={company.id} companyId={company.id} onOpenGoogle={() => go('google')} />
          <div className="-mt-3 space-y-3 px-8 pb-8">{props.mineRows}<JobRepeatAskSetting key={company.id} companyId={company.id} /></div>
        </>
      )
    case 'jobs':
      return <JobsSection key={company.id} companyId={company.id} />
    case 'input':
      return (
        <div className={PAGE}>
          <SectionHeader title="入力（音声・候補）" description="相談画面で使う音声入力と、入力欄に出す候補の設定です。" />
          <SubHeading>音声入力</SubHeading>
          <Card className="p-5"><VoiceShortcutSettings /></Card>
          <Card className="p-5"><VoicePromptSettings unsavedRef={ref} /></Card>
          <SubHeading>入力候補</SubHeading>
          <Card className="p-5"><PromptSuggestionSettings /></Card>
        </div>
      )
    case 'tools':
      return <ConnectToolsScreen key={company.id} companyId={company.id} onOpenService={go} />
    case 'google':
      return <GoogleSection key={company.id} companyId={company.id} />
    case 'slack':
      return <SlackSection key={company.id} companyId={company.id} />
    case 'browser':
      return <BrowserSection key={company.id} companyId={company.id} sites={props.browserSites} />
    case 'ownkeys':
      return <OwnKeysSection unsavedRef={ref} companyId={company.id} focusService={props.focusService} />
    case 'absences':
      return <AbsenceSection key={company.id} companyId={company.id} />
    case 'sync':
      return (
        <>
          <GitBinaryNotice />
          <DownloadFoldersSection unsavedRef={ref} rootPath={company.rootPath} companyId={company.id} departments={props.departments} />
        </>
      )
    case 'autosync':
      return (
        <div className={PAGE}>
          <SectionHeader title="自動同期" description="アプリを開いている間、決まったタイミングでサーバーと同期します。" />
          <AutoSyncSettings />
        </div>
      )
    case 'gitignore':
      return <GitignoreSection gitignore={props.gitignore} rootPath={company.rootPath} />
    case 'envkeys':
      return <EnvKeysSection env={props.env} companyId={company.id} rootPath={company.rootPath} onOpenOwnKeys={() => go('ownkeys')} />
    case 'aienv':
      return (
        <div className={PAGE}>
          <SectionHeader title="AIに渡す環境変数" description="このPCの環境変数のうち、AIと、AIが実行するコマンドから見えるものの設定です。" />
          <Card className="p-5"><AgentEnvSettings unsavedRef={ref} /></Card>
        </div>
      )
  }
}

/** Over 「この PC に置くフォルダ」 when the bundled git cannot run and the system's is used. */
function GitBinaryNotice() {
  const [status, setStatus] = useState<{ bundled: boolean; binary: string } | null>(null)
  useEffect(() => {
    let live = true
    getGitBinaryStatus().then(s => { if (live) setStatus(s) }).catch(() => {})
    return () => { live = false }
  }, [])
  if (!status || status.bundled) return null
  return (
    <div className="px-8 pt-7">
      <Callout tone="warning" title={`同梱のGitが使用できないため、システムのGitで動作しています（${status.binary}）`}>
        古いGitでは大きなファイルの同期に失敗することがあるため、保護設定（http.postBuffer）を自動適用しています。
      </Callout>
    </div>
  )
}
