/**
 * Words and draft helpers for the 「API キー」 page (the key broker's admin).
 * Validation is shared/core/key-broker.ts, the server's own copy.
 */
import {
  normalizeBrokerHost,
  normalizeBrokerModel,
  normalizeBrokerPathPrefix,
  upgradeBrokerAudience,
  type BrokerAudience,
  type BrokerCaps,
  type BrokerKeyRule,
  type BrokerKeyStatus,
  type BrokerServiceCategory,
  type BrokerStatusReason,
} from '../../../shared/core/key-broker'
export { checkBrokerSecret, isValidBrokerServiceName } from '../../../shared/core/key-broker'
import type { BrokerChangeDetail, BrokerKeySnapshot } from '../../../shared/types/key-broker'

export const CATEGORY_LABELS: Record<BrokerServiceCategory, string> = {
  person: '本人として動く',
  tool: '道具として使う',
  system: '会社のシステム',
}

export const CATEGORY_HELP: Record<BrokerServiceCategory, string> = {
  person: 'メール・チャット・カレンダーなど、使う人本人として動くもの',
  tool: 'AI・地図・翻訳・検索など、会社の契約で誰でも使えるもの',
  system: '顧客管理・会計など、会社のシステム',
}

export const RULE_LABELS: Record<BrokerKeyRule, string> = {
  'company-only': '会社の鍵だけ',
  'user-only': '自分の鍵だけ',
  'company-first': '会社の鍵が優先、なければ自分の鍵',
}

export const STATUS_LABELS: Record<BrokerKeyStatus, string> = {
  active: '使用中',
  disabled: '停止中',
}

export const CAP_LABELS: Record<keyof BrokerCaps, string> = {
  requestsPerDay: '1日の回数（全体）',
  tokensPerDay: '1日のトークン数（全体）',
  requestsPerMemberPerDay: '1日の回数（1人あたり）',
  tokensPerMemberPerDay: '1日のトークン数（1人あたり）',
}
export const CAP_KEYS = Object.keys(CAP_LABELS) as Array<keyof BrokerCaps>

/** Why API keys cannot be registered (the server has no usable key-encryption key). */
export const BROKER_OFF_TEXT: Record<BrokerStatusReason, string> = {
  'not-configured': 'サーバーに、API キーを暗号化するための「鍵の鍵」がまだ設定されていません。',
  'kek-unreadable': 'サーバーの「鍵の鍵」のファイルを開けませんでした。',
  'kek-invalid': 'サーバーの「鍵の鍵」のファイルの中身が正しくありません。',
  'kek-insecure': 'サーバーの「鍵の鍵」のファイルが安全な置き方になっていないため、使っていません（他の人が読める、またはデータのフォルダの中にある）。',
}
export const BROKER_OFF_HELP = 'このあいだは API キーを登録・差し替えできません。サーバーの管理者に、セルフホストの手順書の「Key broker」の設定を依頼してください。'

/** Text area lines → entries (blank lines and `#` comments dropped). */
export function linesOf(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
}

const unique = (values: (string | undefined)[]) => [...new Set(values.filter((v): v is string => !!v))]

export const invalidHosts = (text: string) => linesOf(text).filter((l) => !normalizeBrokerHost(l))
export const invalidPathPrefixes = (text: string) => linesOf(text).filter((l) => !normalizeBrokerPathPrefix(l))
export const invalidModels = (text: string) => linesOf(text).filter((l) => !normalizeBrokerModel(l))
export const hostsOf = (text: string) => unique(linesOf(text).map(normalizeBrokerHost))
export const pathPrefixesOf = (text: string) => unique(linesOf(text).map(normalizeBrokerPathPrefix))
export const modelsOf = (text: string) => unique(linesOf(text).map(normalizeBrokerModel))

/** A cap field: '' = none, else a whole number ≥ 1 (undefined = invalid). */
export function capOf(text: string): number | null | undefined {
  const v = text.trim()
  if (!v) return null
  if (!/^\d+$/.test(v)) return undefined
  const n = Number(v)
  return n >= 1 && n <= 1_000_000_000 ? n : undefined
}

export interface Names {
  member: (userId: string) => string
  department: (departmentId: string) => string
}

/** Dial ①: 「全社」 or 「営業部・開発部」. */
export function describeWork(a: BrokerAudience, names: Names): string {
  return a.allDepartments ? '全社' : a.departmentIds.map(names.department).join('・') || '（部署の指定なし）'
}

/** Dial ②: 「全員 − 鈴木」, 「田中、佐藤」. */
export function describePeople(a: BrokerAudience, names: Names): string {
  if (a.everyone) return a.removeUserIds.length ? `全員 − ${a.removeUserIds.map(names.member).join('、')}` : '全員'
  return a.addUserIds.map(names.member).join('、') || 'だれもいない'
}

/** Both dials in one line (the history; entries from before the dials are converted by the caller). */
export function describeAudience(a: BrokerAudience, names: Names): string {
  return `${describeWork(a, names)}の仕事で、${describePeople(a, names)}`
}

export function describeCaps(c: BrokerCaps): string {
  const parts = CAP_KEYS.filter((k) => c[k] !== null).map((k) => `${CAP_LABELS[k]} ${c[k]!.toLocaleString('ja-JP')}`)
  return parts.length ? parts.join('、') : '上限なし'
}

const keyName = (k: { displayName: string; service: string }) => `「${k.displayName}」（${k.service}）`

function fieldLines(name: string, before: Partial<BrokerKeySnapshot>, after: Partial<BrokerKeySnapshot>, names: Names): string[] {
  const lines: string[] = []
  if ('displayName' in after) lines.push(`${name}: 名前 ${before.displayName} → ${after.displayName}`)
  if ('status' in after && after.status && before.status) lines.push(`${name}: ${STATUS_LABELS[before.status]} → ${STATUS_LABELS[after.status]}`)
  if ('destinations' in after && after.destinations) lines.push(`${name}: 送り先 → ${after.destinations.hosts.join('、')}`)
  if ('audience' in after && after.audience) lines.push(`${name}: 使える人 → ${describeAudience(upgradeBrokerAudience(after.audience), names)}`)
  if ('caps' in after && after.caps) lines.push(`${name}: 上限 → ${describeCaps(after.caps)}`)
  if ('allowPrivateContent' in after) lines.push(`${name}: 非公開の内容を送ってよい ${before.allowPrivateContent ? 'はい' : 'いいえ'} → ${after.allowPrivateContent ? 'はい' : 'いいえ'}`)
  return lines
}

/** The history's lines for one change (never a key's value: only its last 4). */
export function brokerChangeLines(c: BrokerChangeDetail, names: Names): string[] {
  switch (c.action) {
    case 'create':
      return [`${keyName(c.key)} を登録（…${c.key.last4}）`]
    case 'replace':
      return [`${keyName(c)} のキーを差し替え（…${c.last4Before} → …${c.last4After}）`]
    case 'update':
      return fieldLines(keyName(c), c.before, c.after, names)
    case 'delete':
      return [`${keyName(c.key)} を削除（…${c.key.last4}）`]
    case 'service': {
      const b = c.before
      const lines: string[] = []
      if (!b || b.rule !== c.after.rule) lines.push(`${c.service}: 決め方 → ${RULE_LABELS[c.after.rule]}`)
      if (!b || b.category !== c.after.category) lines.push(`${c.service}: 種類 → ${CATEGORY_LABELS[c.after.category]}`)
      if (!b || b.ownKeyHosts.join() !== c.after.ownKeyHosts.join()) {
        lines.push(`${c.service}: 自分の鍵の送り先 → ${c.after.ownKeyHosts.join('、') || 'なし'}`)
      }
      return lines
    }
    case 'settings': {
      const lines: string[] = []
      if (c.before.memberKeysAllowed !== c.after.memberKeysAllowed) {
        lines.push(`メンバーが自分の鍵を登録: ${c.before.memberKeysAllowed ? '許可' : '不可'} → ${c.after.memberKeysAllowed ? '許可' : '不可'}`)
      }
      if (c.after.internalHosts) lines.push(`社内の宛先の例外 → ${c.after.internalHosts.join('、') || 'なし'}`)
      return lines
    }
  }
}
