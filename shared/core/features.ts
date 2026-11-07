/**
 * The company's 「使う機能」 (per-company feature switches, owner decisions 2026-11-07,
 * `.claude/rules/records.md` "Features on and off"): one copy of the features, their
 * defaults, what each one owns, and the plain words the admin console and the app show.
 *
 * - Business record types (`task`, `meeting`, `decision`, `interaction`, `reply_request`,
 *   `project`) stay in the core and are always installed. A switch turns a FEATURE on or off,
 *   never a type, and turning one off deletes nothing.
 * - Every feature is on by default, so a company that never chose sees no change.
 * - Records made before a switch-off are 「見るだけ」: still shown, with
 *   `FEATURE_OFF_NOTE` on their card; nothing new of that feature is made, no action is
 *   offered or accepted, and its AI turns, clock jobs and notices stop. Turning it on again
 *   continues from where it stopped (nothing was changed meanwhile).
 *
 * Pure: imports nothing (server/tests/unit/core-purity.test.ts).
 */

export type FeatureId = 'taskList' | 'meetings' | 'inbox' | 'decisions' | 'projects'

/** In the order the admin console lists them. */
export const FEATURE_IDS: readonly FeatureId[] = Object.freeze(['taskList', 'meetings', 'inbox', 'decisions', 'projects'])

export type CompanyFeatures = Record<FeatureId, boolean>

export const DEFAULT_FEATURES: Readonly<CompanyFeatures> = Object.freeze({
  taskList: true, meetings: true, inbox: true, decisions: true, projects: true,
})

/** A fresh, mutable copy of the defaults (everything on). */
export function defaultFeatures(): CompanyFeatures {
  return { ...DEFAULT_FEATURES }
}

export function isFeatureId(value: unknown): value is FeatureId {
  return typeof value === 'string' && (FEATURE_IDS as readonly string[]).includes(value)
}

/**
 * The features from a stored document or a server's answer. Lenient on purpose: anything
 * missing or not a boolean is ON (the default) — an older server that sends no `features`,
 * a stored document from before a feature existed, a damaged row. A switch is off only when
 * it says `false`.
 */
export function featuresFrom(input: unknown): CompanyFeatures {
  const out = defaultFeatures()
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return out
  const o = input as Record<string, unknown>
  for (const id of FEATURE_IDS) if (o[id] === false) out[id] = false
  return out
}

/** `PUT …/features` body: one switch at a time (`{ feature, on }`). */
export function parseFeatureChange(input: unknown): { feature: FeatureId; on: boolean } | { error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { error: 'Body must be { feature, on }' }
  const { feature, on } = input as Record<string, unknown>
  if (!isFeatureId(feature)) return { error: `feature must be one of ${FEATURE_IDS.join(', ')}` }
  if (typeof on !== 'boolean') return { error: 'on must be true or false' }
  return { feature, on }
}

/**
 * The feature a record type belongs to, for 「見るだけ」: while the feature is off its records stay
 * readable but are out of 「あなたの番」/「AI の番」, take no action and nothing new of the type is
 * made. `interaction` (来た連絡) is the inbox's; a sent mail's receipt is still written while the
 * inbox is off (the service writer's receipts, records.md "Features on and off"). `task`,
 * `approval` and `outbound_message` belong to none — every feature uses them.
 */
export const TYPE_FEATURE: Readonly<Record<string, FeatureId>> = Object.freeze({
  meeting: 'meetings',
  decision: 'decisions',
  interaction: 'inbox',
  reply_request: 'inbox',
  project: 'projects',
})

export function featureOfType(type: string): FeatureId | null {
  return Object.prototype.hasOwnProperty.call(TYPE_FEATURE, type) ? TYPE_FEATURE[type] : null
}

/** True when records of `type` are 「見るだけ」 in a company with these features. */
export function typeIsViewOnly(type: string, features: CompanyFeatures): boolean {
  const f = featureOfType(type)
  return f !== null && !features[f]
}

/**
 * The AI tools (the app's record tools, `client/electron/records/tools.ts` and the inbox's)
 * each feature owns: shown only while it is on — never decided by whether the type exists.
 */
export const FEATURE_TOOLS: Readonly<Record<FeatureId, readonly string[]>> = Object.freeze({
  taskList: Object.freeze([]),
  meetings: Object.freeze(['minutes_read', 'minutes_link_bundle']),
  inbox: Object.freeze(['inbox_read', 'inbox_judge', 'inbox_reply_check']),
  decisions: Object.freeze(['decisions_record']),
  projects: Object.freeze([]),
})

/** True when a tool belongs to no feature, or to one that is on. */
export function toolAllowed(name: string, features: CompanyFeatures): boolean {
  for (const id of FEATURE_IDS) if (!features[id] && FEATURE_TOOLS[id].includes(name)) return false
  return true
}

/**
 * The notices (`shared/types/notifications.ts` kinds) each feature owns: none is written while
 * it is off. `wait_over` of a 返事のお願い stops with the clock's move (the type is view only).
 */
export const FEATURE_NOTICE_KINDS: Readonly<Record<FeatureId, readonly string[]>> = Object.freeze({
  taskList: Object.freeze([]),
  meetings: Object.freeze(['minutes_arrived']),
  inbox: Object.freeze(['reply_arrived', 'intake_unsure', 'from_message', 'replied_done', 'mail_left_inbox', 'mail_archived']),
  decisions: Object.freeze([]),
  projects: Object.freeze([]),
})

/** The feature a notice kind belongs to, or null (the core's). */
export function featureOfNoticeKind(kind: string): FeatureId | null {
  for (const id of FEATURE_IDS) if (FEATURE_NOTICE_KINDS[id].includes(kind)) return id
  return null
}

/**
 * The notice kinds a member may switch in 「知らせの設定」: a kind whose feature is off is not
 * listed (none of it is written; the member's stored choice is left as it was).
 */
export function noticeKindsShown<K extends string>(kinds: readonly K[], features: CompanyFeatures): K[] {
  return kinds.filter(kind => {
    const f = featureOfNoticeKind(kind)
    return f === null || features[f]
  })
}

/**
 * Whether a notice is turned off with its feature: a kind the feature owns, or any notice about a
 * record of a 「見るだけ」 type (`recordType` null = a notice about no record).
 */
export function noticeTurnedOff(features: CompanyFeatures, kind: string, recordType: string | null): boolean {
  const f = featureOfNoticeKind(kind)
  return (f !== null && !features[f]) || (recordType !== null && typeIsViewOnly(recordType, features))
}

/** The card's line on a record of a feature that is off (owner decision 2026-11-07). */
export const FEATURE_OFF_NOTE = 'この機能は今オフです'
/** Under it: what that means for the member. */
export const FEATURE_OFF_DETAIL = 'これまでの記録として見ることはできますが、ここからは何も変えられません。会社の管理者がオンにすると、続きから使えます。'

/** The refusal of a create or an action of a feature that is off (`code`, API error body). */
export const FEATURE_OFF = Object.freeze({
  code: 'FEATURE_OFF',
  error: 'この機能は今オフです。会社の管理者が「使う機能」でオンにすると使えます。',
})

/** The words of each switch (admin console 「使う機能」; plain Japanese for non-engineers). */
export const FEATURE_WORDS: Readonly<Record<FeatureId, { name: string; what: string; whenOff: string }>> = Object.freeze({
  taskList: Object.freeze({
    name: 'やることの一覧',
    what: '自分の番・AI の番・頼んだものを一つの一覧で見る画面です。',
    whenOff: '「やること」のタブが出なくなります。やること自体はなくならず、タイトルバーの「あなたの番」から開けます。',
  }),
  meetings: Object.freeze({
    name: '会議と議事録',
    what: 'カレンダーの会議を見つけ、議事録を AI に読ませます。「今日の予定」もこの機能です。',
    whenOff: '会議を新しく見つけなくなり、議事録を AI に読ませるボタンと「今日の予定」が出なくなります。',
  }),
  inbox: Object.freeze({
    name: '受信の振り分け・返事のお願い',
    what: '届いたメールや Slack を AI が振り分け、返事が要るものを知らせます。',
    whenOff: 'メールや Slack を読みに行かなくなり、「返事を待つ」も出なくなります。メールを送ることはできます。',
  }),
  decisions: Object.freeze({
    name: '決めたこと',
    what: '会議や承認で決まったことを残します。',
    whenOff: '議事録を読んだときや承認のあとに、決めたことを残さなくなります。',
  }),
  projects: Object.freeze({
    name: 'プロジェクト',
    what: 'やることや会議をプロジェクトごとにまとめます。',
    whenOff: '新しいプロジェクトを作れなくなり、「どのプロジェクトの会議ですか？」と聞かなくなります。業務プラグインの案件はそのまま使えます。',
  }),
})

/**
 * The admin console's line on a settings card of a feature that is off (owner decision
 * 2026-11-08): the card keeps its title and shows only this; the stored answers stay as they are.
 */
export const FEATURE_OFF_SETTINGS_LINE = 'この機能は今オフです（使う機能で切り替えられます）'

/** What the confirmation says before a switch-off (admin console). */
export const FEATURE_OFF_CONFIRM = 'これまでの記録は消えず、見るだけで残ります。もう一度オンにすると、続きから使えます。'
