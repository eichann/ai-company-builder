// 「自分の鍵」 without React: which key the AI will use for a service, in the
// member's words. It follows the server's choice (shared/core/key-broker.ts
// `chooseBrokerKeySource`) so the page never promises a key the server would
// not use; the server decides again on every call.
import { chooseBrokerKeySource } from '../../../../shared/core/key-broker'
import { ENV_KEY_SERVICES, OWN_KEY_BLOCKED_TEXT, type MyBrokerKeys, type MyBrokerService } from '../../../shared/broker-keys'

export type OwnKeyTone = 'ok' | 'warn' | 'none'

export interface OwnKeyRow {
  /** 「会社の鍵」, 「自分の鍵」, 「未設定」 … */
  status: string
  tone: OwnKeyTone
  /** One sentence under the status: for which work, or what to do. */
  detail: string
  /** The member may register (or replace) a key here now. */
  canRegister: boolean
}

function workOf(keys: MyBrokerService['companyKeys']): { everywhere: boolean; text: string } {
  if (keys.some(k => k.allDepartments)) return { everywhere: true, text: 'すべての部署の相談' }
  const names = [...new Set(keys.flatMap(k => k.departments))]
  return { everywhere: false, text: `${names.join('・') || '指定された部署'}での相談` }
}

export function ownKeyRow(s: MyBrokerService): OwnKeyRow {
  const canRegister = s.ownKey.allowed
  const ownActive = s.key?.status === 'active' && s.ownKey.allowed
  const company = s.companyKeys.length > 0
  const used = chooseBrokerKeySource(s.rule, { company, user: ownActive })
  if (used === 'company') {
    const work = workOf(s.companyKeys)
    if (work.everywhere) return { status: '会社の鍵', tone: 'ok', detail: `${work.text}で、会社の鍵を使います。`, canRegister }
    const fallback = s.rule === 'company-first' && ownActive ? 'それ以外では自分の鍵を使います。' : 'それ以外の相談では使えません。'
    return { status: '会社の鍵', tone: 'ok', detail: `${work.text}で、会社の鍵を使います。${fallback}`, canRegister }
  }
  if (used === 'user') return { status: `自分の鍵（末尾 ${s.key!.last4}）`, tone: 'ok', detail: 'この鍵はあなただけが使えます。', canRegister }
  if (s.key && s.key.status === 'disabled') {
    return { status: '自分の鍵（停止中）', tone: 'warn', detail: '管理者がこの鍵を止めています。管理者に相談してください。', canRegister }
  }
  if (s.key && !s.ownKey.allowed) {
    return { status: '自分の鍵（使われません）', tone: 'warn', detail: OWN_KEY_BLOCKED_TEXT[s.ownKey.reason], canRegister }
  }
  const detail = canRegister
    ? '自分の鍵を登録すると、AI がこのサービスを使えるようになります。'
    : s.ownKey.allowed ? '' : `${OWN_KEY_BLOCKED_TEXT[s.ownKey.reason]}使いたいときは管理者に頼んでください。`
  return { status: '未設定', tone: 'none', detail, canRegister }
}

/** A key on this computer's .env that could become one's own key on the server. */
export interface EnvKeyToMove {
  /** The .env name (`OPENAI_API_KEY`). */
  name: string
  service: string
  label: string
  last4: string | null
  /** The server would take it as an own key now. */
  canMove: boolean
  /** Why not (or what moving replaces), in the member's words; '' for nothing to add. */
  note: string
}

/**
 * Built-in services' keys found in the company .env, and whether each can be
 * moved to the server as the member's own key — offered only where the server
 * would accept one (it decides again when the key is sent).
 */
export function envKeysToMove(env: Record<string, { set: boolean; last4?: string }>, data: MyBrokerKeys | null): EnvKeyToMove[] {
  return Object.entries(ENV_KEY_SERVICES).flatMap(([name, service]): EnvKeyToMove[] => {
    if (!env[name]?.set) return []
    const s = data?.services.find(x => x.service === service)
    const base = { name, service, label: s?.label ?? service, last4: env[name].last4 ?? null }
    if (!data) return [{ ...base, canMove: false, note: 'サーバーに接続できないため、いまは移せません。' }]
    if (!data.enabled) return [{ ...base, canMove: false, note: 'サーバーで鍵を預かる機能が、まだ使えるようになっていません。' }]
    if (!s || !s.ownKey.allowed) {
      const why = s && !s.ownKey.allowed ? OWN_KEY_BLOCKED_TEXT[s.ownKey.reason] : 'このサービスの自分の鍵は、まだ登録できません。'
      return [{ ...base, canMove: false, note: `${why}移したいときは管理者に頼んでください。` }]
    }
    const replaces = s.key ? `サーバーにある自分の鍵（末尾 ${s.key.last4}）は、この鍵に置き換わります。` : ''
    return [{ ...base, canMove: true, note: replaces }]
  })
}
