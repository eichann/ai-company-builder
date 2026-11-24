// What each page of the admin console reads, for 検証A社 (world.ts), in the state the guide
// describes: set up, calm, nothing stopped. A scene that needs another state (a stop in force,
// something needing attention) replaces one answer in its own `api`.
//
// Types come from the console (admin/src/lib/api.ts re-exports the shared contracts), so `tsc`
// keeps these answers in the API's shape.
import type {
  AdminHome,
  AgentBrowserView,
  AgentEventPage,
  AgentEventSettings,
  AgentEventSummary,
  AgentSandboxView,
  BrokerKeySummary,
  BrokerView,
  CoreConnectorsView,
  EffectiveAccess,
  FeaturesView,
  GoogleAdminView,
  InboxSettingsView,
  JobList,
  JobView,
  PluginDetail,
  MemberGroupsView,
  Overview,
  PermissionScope,
  PluginListItem,
  PrivateFolderDetail,
  SecondOpinionView,
  SecurityAlertsView,
  SkillEditors,
  SlackAdminView,
  TaskSettingsView,
} from '@/lib/api'
import type { AgentStopView } from '../../../shared/types/agent-stop'
import type { RecordSettings } from '../../../shared/types/records'
import type { AgentEventRecord, SandboxImpact } from '../../../shared/types/agent-events'
import type { JobDefinition } from '../../../shared/core/jobs'
import type { JobProposalView } from '../../../shared/types/job-proposals'
import type { SecurityAlertView } from '../../../shared/types/security-alerts'
import type { GoogleRelayAdminView } from '../../../shared/types/google'
import type { MinutesFolderSetting } from '../../../shared/types/minutes'
import type { ShelfItemView, ShelfRequestView } from '../../../shared/types/skill-shelf'
import { DEFAULT_AGENT_SANDBOX_SETTINGS, DEFAULT_SANDBOX_ALLOWED_DOMAINS } from '../../../shared/core/agent-sandbox'
import { DEFAULT_BROWSER_OPERATION_SETTINGS } from '../../../shared/core/browser-operation'
import { defaultIntakeSettings } from '../../../shared/core/intake-settings'
import { defaultTaskSettings } from '../../../shared/core/task-settings'
import { API, company, departments, members, ok, people, type Routes } from './world'

const SERVER = 'https://acb.kensho-a.example'
const SET_UP = '2026-11-05T01:00:00.000Z'
const by = people.tanaka

export const agentStops: AgentStopView = {
  active: [], history: [], unsupported: [],
  keys: { enabled: true, active: 1, stopped: 0 },
}

export const overview: Overview = {
  memberCount: members.length,
  departmentCount: departments.length,
  attention: { outdatedClients: [], unknownClients: [], notSyncedRecently: [], recentRejections: [], orphanedScopes: [] },
}

const EVERYONE_RW = { id: 'r_everyone', subjectType: 'everyone' as const, subjectId: null, subjectLabel: '全員', canRead: true, canWrite: true }
const ROOT = { scopeId: 's_company', path: '', rules: [EVERYONE_RW], summary: 'everyone-rw' as const }

export const permissionScopes: PermissionScope[] = [
  { id: 's_company', path: '', kind: 'company', departmentId: null, repoId: null, inherited: false, rules: [EVERYONE_RW], effectiveSummary: 'everyone-rw', inheritedFrom: null },
  { id: 's_sales', path: '営業部', kind: 'department', departmentId: 'd_sales', repoId: null, inherited: true, rules: [], effectiveSummary: 'everyone-rw', inheritedFrom: ROOT },
  { id: 's_soumu', path: '総務部', kind: 'department', departmentId: 'd_soumu', repoId: null, inherited: true, rules: [], effectiveSummary: 'everyone-rw', inheritedFrom: ROOT },
  { id: 's_shared', path: '全社共有', kind: 'department', departmentId: 'd_shared', repoId: null, inherited: true, rules: [], effectiveSummary: 'everyone-rw', inheritedFrom: ROOT },
  {
    id: 's_hr', path: '総務部/人事評価', kind: 'folder', departmentId: 'd_soumu', repoId: 'r_hr', inherited: false, effectiveSummary: 'restricted', inheritedFrom: null,
    rules: [
      { id: 'r_hr_sato', subjectType: 'user', subjectId: people.sato.userId, subjectLabel: people.sato.name, canRead: true, canWrite: true },
      { id: 'r_hr_nakamura', subjectType: 'user', subjectId: people.nakamura.userId, subjectLabel: people.nakamura.name, canRead: true, canWrite: true },
      { id: 'r_hr_ito', subjectType: 'user', subjectId: people.ito.userId, subjectLabel: people.ito.name, canRead: true, canWrite: true },
    ],
  },
]

/** 総務部/人事評価: a private folder 佐藤さん made for 総務部's two people. */
export const hrFolder: PrivateFolderDetail = {
  scopeId: 's_hr', path: '総務部/人事評価', departmentId: 'd_soumu', viewerCount: 5, editorCount: 5,
  createdAt: '2026-11-10T02:00:00.000Z', createdBy: people.sato.userId, createdByName: people.sato.name,
  members: [people.takahashi, people.sato, people.tanaka, people.nakamura, people.ito].map((p) => ({
    userId: p.userId, name: p.name, email: p.email, role: p.role, canWrite: true, via: p.role === 'member' ? 'rule' as const : 'role' as const,
  })),
}
const { members: _hrMembers, ...hrSummary } = hrFolder
void _hrMembers

export const groups: MemberGroupsView = { groups: [] }

export const recordSettings: RecordSettings = { enabled: true, updatedAt: SET_UP }

export const features: FeaturesView = { features: { taskList: true, meetings: true, inbox: true, decisions: true, projects: true }, canEdit: true, updatedAt: null, updatedBy: null, updatedByName: null }

export const taskSettings: TaskSettingsView = { settings: defaultTaskSettings(), canEdit: true, updatedAt: null, updatedBy: null, updatedByName: null }

export const inboxSettings: InboxSettingsView = { settings: defaultIntakeSettings(), canEdit: true, updatedAt: null, updatedBy: null }

export const secondOpinion: SecondOpinionView = { allowed: false, updatedAt: null, updatedByName: null }

export const securityAlerts: SecurityAlertsView = { items: [], settings: { slackDm: false, updatedAt: null } }

export const sandbox: AgentSandboxView = {
  settings: { ...DEFAULT_AGENT_SANDBOX_SETTINGS }, defaultAllowedDomains: [...DEFAULT_SANDBOX_ALLOWED_DOMAINS],
  overrides: [], updatedAt: null, updatedBy: null, history: [],
}

export const browser: AgentBrowserView = { settings: { ...DEFAULT_BROWSER_OPERATION_SETTINGS }, overrides: [], updatedAt: null, updatedBy: null, history: [] }

export const eventSettings: AgentEventSettings = { retentionDays: 180, viewers: 'admins', updatedAt: null, updatedBy: null, history: [] }
export const eventPage: AgentEventPage = { events: [], nextCursor: null }
export const eventSummary: AgentEventSummary = { from: '2026-11-13T15:00:00.000Z', to: '2026-11-20T15:00:00.000Z', tzOffsetMinutes: 540, days: [], members: [] }

export const jobs: JobList = { stopped: false, canManage: true, jobs: [] }

export const hubspotKey: BrokerKeySummary = {
  id: 'k_hubspot', scope: 'company', ownerUserId: null, ownerName: null, service: 'hubspot', displayName: '営業の HubSpot', last4: 'a1b2',
  destinations: { hosts: ['api.hubapi.com'], pathPrefixes: [], models: [] },
  audience: { allDepartments: false, departmentIds: ['d_sales'], everyone: true, addUserIds: [], removeUserIds: [] },
  caps: { requestsPerDay: 5000, tokensPerDay: null, requestsPerMemberPerDay: 500, tokensPerMemberPerDay: null },
  allowPrivateContent: false, status: 'active', createdAt: SET_UP, createdBy: by.userId,
  updatedAt: SET_UP, updatedBy: by.userId, secretUpdatedAt: SET_UP,
  usableBy: [people.takahashi, people.sato, people.tanaka, people.yamada, people.kobayashi, people.nakamura, people.ito].map((p) => ({ userId: p.userId, name: p.name, email: p.email, via: p.role === 'owner' ? 'owner' as const : 'everyone' as const })),
  usageToday: { requests: 128, tokens: 0 },
}

export const broker: BrokerView = {
  status: { enabled: true, reason: null },
  settings: { memberKeysAllowed: false, internalHosts: [], updatedAt: null, updatedBy: null },
  services: [{ service: 'hubspot', label: 'HubSpot', builtin: true, category: 'tool', rule: 'company-only', ownKeyHosts: [], defaultHosts: ['api.hubapi.com'], companyKeys: 1, userKeys: 0, updatedAt: null, relay: null, readOnly: true, defaultKeyId: null, practice: false }],
  keys: [hubspotKey],
  departments: departments.map(({ id, name, folder }) => ({ id, name, folder })),
  history: [],
}

export const google: GoogleAdminView = {
  vaultEnabled: true, configured: true, clientId: '000000000000-kensho.apps.googleusercontent.com', secretLast4: 'k3n5', domain: 'kensho-a.example',
  enabled: true, redirectUri: `${SERVER}/api/oauth/google/callback`, practice: false, operatorStopped: false,
  updatedAt: SET_UP, updatedBy: by.userId,
  grants: [people.yamada, people.sato, people.kobayashi].map((p) => ({
    userId: p.userId, memberEmail: p.email, memberName: p.name, googleEmail: p.email,
    features: ['minutes', 'mail'], featuresOff: [], scopes: [], status: 'active' as const,
    createdAt: SET_UP, updatedAt: SET_UP, lastUsedAt: '2026-11-20T00:40:00.000Z',
  })),
  history: [],
  picker: { configured: false, appId: null, apiKeyLast4: null, pageUrl: `${SERVER}/api/google-picker` },
  featuresOff: [], companyFeatures: ['minutes', 'mail', 'inbox'],
}

export const slack: SlackAdminView = {
  vaultEnabled: true, configured: true, teamId: 'T0KENSHO', clientId: '0000000000.1111111111', clientSecretLast4: 's1ck', hasBotToken: true,
  enabled: true, operatorStopped: false, practice: false,
  redirectUri: `${SERVER}/api/oauth/slack/callback`, eventsUrl: `${SERVER}/api/slack/events/c_kensho`,
  grants: [people.yamada, people.sato].map((p) => ({
    userId: p.userId, memberEmail: p.email, slackEmail: p.email, features: ['read', 'notices'], featuresOff: [], status: 'active' as const, lastUsedAt: '2026-11-20T00:35:00.000Z',
  })),
  history: [],
}

export const connectors: CoreConnectorsView = {
  connectors: [
    {
      id: 'google', label: 'Google Workspace', summary: 'メンバーが自分で許可すると、予定・メール・Meet の議事録を ACB が読みます。', status: 'on',
      configured: true, enabled: true, operatorStopped: false,
      roles: [
        { role: 'calendar', label: '予定を読む', operations: ['read'], capabilities: [] },
        { role: 'mail', label: 'メールを読む・送る', operations: ['read', 'send'], capabilities: [] },
        { role: 'meetings', label: '会議の記録を読む', operations: ['read'], capabilities: [] },
      ],
      capabilities: [{ id: 'drive', label: 'Drive で選んだものを読む・置く' }],
    },
  ],
  roles: [
    { role: 'calendar', label: '予定を読む', candidates: ['google'], choice: null, servedBy: 'google', choiceNeeded: false },
    { role: 'mail', label: 'メールを読む・送る', candidates: ['google'], choice: null, servedBy: 'google', choiceNeeded: false },
    { role: 'meetings', label: '会議の記録を読む', candidates: ['google'], choice: null, servedBy: 'google', choiceNeeded: false },
    { role: 'chat', label: 'チャットの連絡を受け取る・返す', candidates: [], choice: null, servedBy: null, choiceNeeded: false },
  ],
}

export const plugins: { plugins: PluginListItem[] } = { plugins: [] }

export const sandboxImpact: SandboxImpact = { from: '2026-10-21T15:00:00.000Z', to: '2026-11-20T15:00:00.000Z', byHost: [], bySkill: [], byPlace: [], total: 0, truncated: false }

export const minutesFolder: MinutesFolderSetting = { folder: '全社共有', choices: departments.map((d) => d.folder), meetings: 'external', bundleQuestionDays: 7 }

export const googleRelay: GoogleRelayAdminView = {
  available: true, reason: null, services: [{ service: 'sheets', on: false }], capPerMemberPerDay: 500, stopped: false,
  members: [], records: [], sharedDrives: [],
}

const editor = (p: { userId: string; name: string; email: string }) => ({ userId: p.userId, name: p.name, email: p.email })
export const skillEditors: SkillEditors = {
  everyone: false,
  company: [editor(people.sato)],
  departments: [{ departmentId: 'd_sales', editors: [editor(people.kobayashi)] }, { departmentId: 'd_soumu', editors: [] }, { departmentId: 'd_shared', editors: [] }],
}

/** Who can do what at a place that follows the company's rule (everyone reads and edits, as a new company starts). */
export const effectiveAt = (path: string): EffectiveAccess => ({
  path,
  governingScope: { id: 's_company', path: '', inherited: path !== '' },
  readRestrictionEnforced: false,
  members: members.map((m) => {
    const full = m.role !== 'member'
    return {
      userId: m.userId, name: m.name, email: m.email, role: m.role, read: true, write: true,
      reason: full ? 'role' as const : 'rule' as const,
      decidedBy: full ? null : { scopeId: 's_company', path: '', subjectType: 'everyone' as const, subjectLabel: '全員' },
    }
  }),
})

/** Every page's reads, in the calm state above. */
export function pageAnswers(): Routes {
  return {
    [`GET ${API}/agent-stops`]: ok(agentStops),
    [`GET ${API}/overview`]: ok(overview),
    [`GET ${API}/permissions`]: ok({ scopes: permissionScopes, orphanedScopes: [] }),
    [`GET ${API}/groups`]: ok(groups),
    [`GET ${API}/records/settings`]: ok(recordSettings),
    [`GET ${API}/features`]: ok(features),
    [`GET ${API}/task-settings`]: ok(taskSettings),
    [`GET ${API}/inbox-settings`]: ok(inboxSettings),
    [`GET ${API}/second-opinion`]: ok(secondOpinion),
    [`GET ${API}/security-alerts`]: ok(securityAlerts),
    [`GET ${API}/agent-sandbox`]: ok(sandbox),
    [`GET ${API}/agent-browser`]: ok(browser),
    [`GET ${API}/agent-events/settings`]: ok(eventSettings),
    [`GET ${API}/agent-events?from=2026-11-13T15:00:00.000Z&limit=50`]: ok(eventPage),
    [`GET ${API}/agent-events/summary?from=2026-11-13T15:00:00.000Z&tzOffsetMinutes=540`]: ok(eventSummary),
    [`GET ${API}/jobs`]: ok(jobs),
    [`GET ${API}/broker`]: ok(broker),
    [`GET ${API}/google`]: ok(google),
    [`GET ${API}/slack`]: ok(slack),
    [`GET ${API}/connectors`]: ok(connectors),
    [`GET ${API}/plugins`]: ok(plugins),
    [`GET ${API}/agent-events/sandbox`]: ok(sandboxImpact),
    [`GET ${API}/google/minutes-folder`]: ok(minutesFolder),
    [`GET ${API}/google/relay`]: ok(googleRelay),
    [`GET ${API}/job-proposals?state=submitted`]: ok({ proposals: [] }),
    [`GET ${API}/permissions/effective?path=`]: ok(effectiveAt('')),
    [`GET ${API}/skill-editors`]: ok(skillEditors),
    [`GET ${API}/permissions/folders?path=`]: ok({ path: '', folders: departments.map((d) => ({ name: d.folder, path: d.folder, scopeId: `s_${d.id}`, hasRules: false })) }),
    [`GET ${API}/private-folders`]: ok([hrSummary]),
    [`GET ${API}/private-folders/s_hr`]: ok(hrFolder),
  }
}

// ── A company without the shared folder (7節's 「会社の Skill」) ──────────────
const noFolder = { ...company, folderKind: 'none' as const, repoPath: null }
/** 検証A社 as a company without the shared folder (each member works in a folder of their own PC). */
export const withoutFolder: Routes = {
  'GET /api/companies': ok([noFolder]),
  [`GET ${API}`]: ok(noFolder),
}

const shelfPerson = (p: { userId: string; name: string }) => ({ id: p.userId, name: p.name })
export const shelfItems: ShelfItemView[] = [
  {
    id: 'sh_weekly', kind: 'skill', name: 'weekly-report', department: { id: 'd_sales', name: '営業部', folder: '営業部' },
    version: 'a3f9c2e1d4b5a6c7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1', fileCount: 3, totalBytes: 8200,
    changedAt: '2026-11-18T05:00:00.000Z', changedBy: shelfPerson(people.kobayashi), canChange: true,
  },
  {
    id: 'sh_minutes', kind: 'skill', name: 'meeting-minutes', department: null,
    version: 'b4e0d3f2c5a6b7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2', fileCount: 2, totalBytes: 5100,
    changedAt: '2026-11-12T02:00:00.000Z', changedBy: shelfPerson(people.sato), canChange: true,
  },
]
export const shelfRequest: ShelfRequestView = {
  id: 'rq_estimate', name: 'estimate-draft', version: 'c5f1e4a3b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3',
  department: { id: 'd_sales', name: '営業部', folder: '営業部' }, requestedBy: shelfPerson(people.yamada), requestedAt: '2026-11-20T00:20:00.000Z',
  state: 'pending', fileCount: 2, totalBytes: 4300, autorun: false, decidedBy: null, decidedAt: null, reason: null,
  publishedVersion: null, mine: false, canDecide: true, currentVersion: null,
}

// ── 8節 仕事の進め方: 検証A社's first month ────────────────────────────────────
/** Only 「会議と議事録」 and 「プロジェクト」 on. */
export const firstMonthFeatures: FeaturesView = {
  ...features, features: { taskList: false, meetings: true, inbox: false, decisions: false, projects: true },
  updatedAt: '2026-11-06T01:00:00.000Z', updatedBy: by.userId, updatedByName: by.name,
}
/** 案件 as the name of what bundles tasks, and 10 automatic runs a person a day. */
export const firstMonthTasks: TaskSettingsView = (() => {
  const settings = defaultTaskSettings()
  settings.bundleName = '案件'
  settings.autoRun = { ...settings.autoRun, dailyLimit: 10 }
  return { ...taskSettings, settings, updatedAt: '2026-11-06T01:00:00.000Z', updatedBy: by.userId, updatedByName: by.name }
})()
/** info@ goes to 総務部. */
export const sharedInbox: InboxSettingsView = (() => {
  const settings = defaultIntakeSettings()
  settings.sharedAddresses = [{ address: 'info@kensho-a.example', folder: '総務部' }]
  return { ...inboxSettings, settings, updatedAt: '2026-11-06T01:00:00.000Z', updatedBy: by.userId }
})()

// ── 11節 業務プラグイン: HubSpot (a connector) and 法人営業 (a business using it) ──
const AT = '2026-11-12T01:00:00.000Z'
const hubspotPkg = {
  id: 'hubspot', label: 'HubSpot', version: '0.3.0', kind: 'official' as const, role: 'connector' as const, description: null, service: 'hubspot', host: 'api.hubapi.com',
  scopes: [], operationScopes: {}, types: [], operations: [], fingerprint: 'f', stopped: false, connector: null,
}
const salesPkg = {
  ...hubspotPkg, id: 'corporate-sales', label: '法人営業', version: '0.2.0', role: 'business' as const, service: '', host: '', types: ['deal', 'customer'],
  connector: { id: 'hubspot', minVersion: '0.3.0', label: 'HubSpot', records: true },
}
/** HubSpot set up with its key but not turned on yet; 法人営業 in use (its exchange with HubSpot waits). */
export const hubspotItem: PluginListItem = {
  id: 'hubspot', versions: [hubspotPkg],
  install: { version: '0.3.0', enabled: false, keyId: 'k_hubspot', mappingVersion: 0, connectionId: 'c_hubspot', accountId: null, managedSince: null, updatedAt: AT, updatedBy: by.userId, problem: 'off' },
}
export const salesItem: PluginListItem = {
  id: 'corporate-sales', versions: [salesPkg],
  install: { version: '0.2.0', enabled: true, keyId: null, mappingVersion: 1, connectionId: 'c_sales', accountId: null, managedSince: null, updatedAt: AT, updatedBy: by.userId, problem: 'connector-stopped' },
}
const MAPPING = `# 検証A社の読み替え表
deal:
  visible_to_folder: 営業部
  import:
    pipelines: [default]
    updated_within_days: 180
    max: 500
  fields:
    title:      { from: dealname, write: false }
    stage:      { from: dealstage, write: false, values: { appointmentscheduled: first_meeting, qualifiedtobuy: proposal } }
    next_step:  { from: hs_next_step, write: true }
    amount:     { from: amount, write: true }
  links:
    customer:   { from_association: companies }
people:
  owners:
    "75123001": ${people.yamada.userId}
policy:
  amount: prior
`
export const salesDetail: PluginDetail = {
  plugin: { ...salesItem, install: { ...salesItem.install!, problem: null } },
  mapping: { version: 1, text: MAPPING, createdAt: AT, createdBy: by.userId },
  mappingVersions: [{ version: 1, createdAt: AT, createdBy: by.userId }],
  policies: [
    { operation: 'update_deal', object: 'deal', field: 'next_step', policy: 'prior' },
    { operation: 'update_deal', object: 'deal', field: 'amount', policy: 'prior' },
  ],
  labels: { deal: { label: '案件', fields: { title: '件名', stage: '段階', next_step: '次のアクション', amount: '金額' } } },
  mappingErrors: [], autoAcknowledgements: [],
  history: [{ action: 'install', at: AT, by: by.userId, change: {} }],
  readScope: { departmentIds: ['d_sales'], userIds: [] },
}

// ── 12節 定期の仕事 ──────────────────────────────────────────────────────────
const JOB_AT = '2026-11-16T01:00:00.000Z'
const weekly = {
  schema: 1, name: '週報を作る', actingUser: people.yamada.userId,
  trigger: { every: 'week', weekday: 'mon', at: '08:30', businessDaysBefore: 0 },
  check: { kind: 'new_files', path: '営業部/訪問メモ' },
  run: { kind: 'procedure', procedure: { source: 'company_skill', skill: 'weekly-report', fingerprint: 'tree:0123456789abcdef0123456789abcdef01234567' } },
  placement: 'a',
  missed: { policy: 'latest_only', expiresAfterMinutes: 720 },
  grant: {
    tools: ['records', 'files_read', 'files_write'], creates: ['task'], routes: [],
    reads: { paths: ['営業部/訪問メモ'], calls: [] }, writes: { area: 'deliverable', place: '営業部', folder: '週報' },
    outbound: 'none', limits: { minutes: 15, runsPerDay: 1 },
  },
} as unknown as JobDefinition
const morning = {
  schema: 1, name: '朝の数字の確認', actingUser: people.takahashi.userId,
  trigger: { every: 'day', businessDaysOnly: true, at: '09:00' },
  check: { kind: 'none' },
  run: { kind: 'operation', operation: 'create_task', title: '昨日の受注と入金を確かめる', dueBusinessDays: 0 },
  placement: 'e',
  missed: { policy: 'latest_only', expiresAfterMinutes: 720 },
  grant: { tools: [], creates: ['task'], routes: [], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 10, runsPerDay: 1 } },
} as unknown as JobDefinition
const invoice = {
  ...morning, name: '月末の請求の確認', actingUser: people.sato.userId,
  trigger: { every: 'month', day: 'last', ifHoliday: 'before', at: '10:00' },
  run: { kind: 'operation', operation: 'create_task', title: '今月の請求書がそろっているか確かめる', dueBusinessDays: 1 },
} as unknown as JobDefinition

const jobBase = { state: 'active' as const, pausedReason: null, createdBy: by.userId, createdAt: JOB_AT, updatedAt: JOB_AT, latestVersion: 1 }
export const weeklyJob: JobView = {
  ...jobBase, id: 'job.1111111111111111111111111111aaaa', name: weekly.name, actingUserId: people.yamada.userId,
  approvedVersion: 1, accepted: true, waiting: null, trigger: weekly.trigger, placement: 'a', nextSlot: '2026-11-23T08:30',
  lastOccurrence: { dueSlot: '2026-11-16T08:30', state: 'done', outcomeCode: null },
  approved: { responsibleUserId: people.yamada.userId, name: weekly.name }, latestConsentAccepted: true,
  you: { named: false, controls: false, mustAccept: false },
}
export const morningJob: JobView = {
  ...jobBase, id: 'job.2222222222222222222222222222bbbb', name: morning.name, actingUserId: people.takahashi.userId,
  approvedVersion: 1, accepted: false, waiting: 'NOT_ACCEPTED', trigger: morning.trigger, placement: 'e', nextSlot: '2026-11-24T09:00',
  lastOccurrence: null, approved: { responsibleUserId: people.takahashi.userId, name: morning.name }, latestConsentAccepted: false,
  you: { named: true, controls: true, mustAccept: true },
}
export const invoiceJob: JobView = {
  ...jobBase, state: 'draft', id: 'job.3333333333333333333333333333cccc', name: invoice.name, actingUserId: people.sato.userId,
  approvedVersion: null, accepted: false, waiting: 'NOT_APPROVED', trigger: invoice.trigger, placement: 'e', nextSlot: null,
  lastOccurrence: null, approved: null, latestConsentAccepted: false, you: { named: false, controls: false, mustAccept: false },
}
const versionOf = (d: JobDefinition, n: string) => ({
  version: 1, fingerprint: `sha256:${n.repeat(64)}`, consentFingerprint: `sha256:${n.repeat(63)}f`, definition: d,
  createdBy: by.userId, createdAt: JOB_AT, approvedBy: people.sato.userId, approvedAt: JOB_AT, acceptedBy: null, acceptedAt: null,
})
export const morningDetail: JobView = { ...morningJob, versions: [versionOf(morning, 'b')] }
export const jobList: JobList = { stopped: false, canManage: true, jobs: [weeklyJob, morningJob, invoiceJob] }

/** 山田さん's proposal of a job, waiting in 「届いた案」. */
const proposalDef = { ...weekly, schema: 4, origin: 'member_proposal', name: '提案書の下書きを毎週そろえる' } as unknown as JobDefinition
export const proposalJob: JobView = {
  ...jobBase, state: 'draft', id: 'job.4444444444444444444444444444dddd', name: '提案書の下書きを毎週そろえる', actingUserId: people.yamada.userId,
  approvedVersion: null, accepted: false, waiting: 'NOT_APPROVED', trigger: weekly.trigger, placement: 'a', nextSlot: null,
  lastOccurrence: null, approved: null, latestConsentAccepted: false, you: { named: false, controls: false, mustAccept: false },
  versions: [{ ...versionOf(proposalDef, 'd'), approvedBy: null, approvedAt: null }],
}
export const proposal: JobProposalView = {
  id: 'jp_1', jobId: proposalJob.id, proposerId: people.yamada.userId, candidateId: 'jc_1', submittedVersion: 1,
  submittedFingerprint: `sha256:${'d'.repeat(64)}`, state: 'submitted', returnReason: null, decidedBy: null, decidedAt: null, createdAt: '2026-11-19T08:00:00.000Z',
}

// ── 13節 ブラウザ操作 (an example site; 検証A社 itself keeps it off) ─────────────
export const browserOn: AgentBrowserView = {
  ...browser,
  settings: { mode: 'on', sites: [{ host: 'app.haishin-tool.example', level: 'read', assetHosts: [] }] },
  updatedAt: JOB_AT, updatedBy: by.userId,
}

// ── 14節 見守る・止める ────────────────────────────────────────────────────────
const alert: SecurityAlertView = {
  id: 'al_1', kind: 'bulk_download', title: '中村 愛さんが、いつもより多くのファイルを受け取りました',
  detail: '1時間に 1,240 件（ふだんは多くて 80 件）', action: '本人に、何をしていたか確かめてください。心当たりがなければ［AI を止める］で止め、運用担当者に知らせてください。',
  userId: people.nakamura.userId, name: people.nakamura.name, createdAt: '2026-11-19T06:00:00.000Z',
}
export const busyHome = (base: AdminHome): AdminHome => ({
  ...base,
  attention: {
    ...base.attention,
    outdatedClients: [{
      userId: people.kobayashi.userId, name: people.kobayashi.name, email: people.kobayashi.email, role: 'member',
      clientVersion: '0.0.1+0f0f0f0.20261001000000', lastSeenAt: '2026-11-18T06:00:00.000Z', lastFetchAt: '2026-11-18T05:55:00.000Z', lastPushAt: '2026-11-17T08:00:00.000Z',
    }],
    recentRejections: [{ id: 'pr_1', userId: people.yamada.userId, name: people.yamada.name, marker: 'SECRET_DETECTED', paths: ['営業部/顧客リスト.env'], createdAt: '2026-11-20T00:10:00.000Z' }],
    meetingDuplicates: 1,
    securityAlerts: [alert],
  },
})
export const alerts: SecurityAlertsView = {
  items: [alert, {
    id: 'al_2', kind: 'sign_in_failures', title: '山田 太郎さんのアカウントで、ログインの失敗が続きました',
    detail: '10分間に 8 回', action: '本人がパスワードを忘れていないか確かめてください。',
    userId: people.yamada.userId, name: people.yamada.name, createdAt: '2026-11-18T23:40:00.000Z',
  }],
  settings: { slackDm: false, updatedAt: null },
}

/** 山田さん's command runs stopped while 田中さん looks into something. */
export const oneStop: AgentStopView = {
  ...agentStops,
  active: [{
    id: 'st_1', userId: people.yamada.userId, userName: people.yamada.name, userEmail: people.yamada.email, tool: 'command',
    reason: '動きを確かめるまで', stoppedAt: '2026-11-20T01:05:00.000Z', stoppedBy: by.userId, stoppedByName: by.name,
    releasedAt: null, releasedBy: null, releasedByName: null,
  }],
}

type Person = { userId: string; name: string; email: string }
const ev = (i: number, p: Person, minutes: number, tool: string, category: AgentEventRecord['category'], target: AgentEventRecord['target'], decision: AgentEventRecord['decision'], guardReason: AgentEventRecord['guardReason'] = null): AgentEventRecord => {
  const at = new Date(Date.parse('2026-11-20T01:30:00.000Z') - minutes * 60_000).toISOString()
  const refused = decision === 'member-denied' || decision === 'guard-denied' || decision === 'policy-denied' || decision === 'stopped'
  return {
    id: `ev_${i}`, callId: `call_${i}`, userId: p.userId, name: p.name, email: p.email, at, atAdjusted: false, receivedAt: at, durationMs: 120,
    conversationId: `conv_${p.userId}`, turnId: null, department: p === people.sato ? '総務部' : '営業部', agent: 'claude-code', model: null, subagentType: null, tool, category, target,
    decision, guardReason, outcome: refused ? null : 'ok', sandbox: null, skill: i < 3 ? 'weekly-report' : null,
    clientVersion: '0.0.1+a1b2c3d.20261119031200',
  }
}
export const events: AgentEventPage = {
  events: [
    ev(1, people.yamada, 2, 'Read', 'read', { kind: 'file', path: '営業部/訪問メモ/訪問メモ_1120.md' }, 'auto-allowed'),
    ev(2, people.yamada, 3, 'Write', 'write', { kind: 'file', path: '営業部/週報/週報_1120.md' }, 'member-allowed'),
    ev(3, people.yamada, 5, 'Bash', 'command', { kind: 'command', programs: ['rm'] }, 'guard-denied', 'dangerous-command'),
    ev(4, people.kobayashi, 12, 'WebFetch', 'web', { kind: 'web', host: 'www.example.com' }, 'member-allowed'),
    ev(5, people.sato, 20, 'Read', 'read', { kind: 'file', path: '総務部/規程/就業規則.md' }, 'auto-allowed'),
    ev(6, people.sato, 26, 'Edit', 'write', { kind: 'file', path: '総務部/規程/就業規則.md' }, 'member-denied'),
  ],
  nextCursor: null,
}
