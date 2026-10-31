/**
 * Typed tools for the company map (stage 4-6, `.claude/rules/records.md`),
 * generated from the company's type definitions: one tool per type × action
 * (`task__request_review`), plus look-ups (`records_query`, `records_get`,
 * `records_my_turn`, `records_history`, `records_types`) and `records_create`.
 * MCP server `acb_records`: Claude Code in-process, Codex as a loopback
 * endpoint — Codex gets the look-ups only (registry `recordActions`, owner
 * decision 0.3-3), and its token is `read`, so the server refuses an action
 * even if a tool slipped through.
 *
 * Every call goes to the server's AI routes with the turn's record token
 * (records/api.ts): the server decides it is the AI acting and applies the
 * type's `who` (an action without `ai` — completing a task — is refused).
 * The AI changes state only through these tools; the chat write guard stops
 * it from writing state into a record file instead.
 *
 * Connector plugins (milestone 3 P7, `.claude/rules/plugins.md` "The app"):
 * the operations of the plugins that run for the company become tools on the
 * same server (`hubspot__update_deal`, `hubspot__refresh_deal`), from
 * `GET /api/records-ai/plugins` — the same way the type definitions do.
 * Writes only with an `act` token (Claude); Codex gets reads. An update's
 * outcome becomes a card in the reply (`client/shared/plugin-operations.ts`)
 * with 「変更前の値を書き戻す」 for the person.
 */
import { z, type ZodTypeAny } from 'zod'
import type { FieldKind, TypeDefinition } from '../../../shared/core/record-types'
import type { PluginAiOperation, PluginAiTools } from '../../../shared/types/plugins'
import { OLD_CONNECTION_LABEL } from '../../../shared/types/records'
import { aiSummaryOf, cardFromAnswer, cardFromRefusal, type CardContext, type PluginOperationCard } from '../../shared/plugin-operations'
import { startLoopbackMcp } from '../agents/loopback-mcp'
import { RecordsApiError, type RecordTurnAccess } from './api'

export const RECORDS_SERVER = 'acb_records'
export const recordToolId = (name: string) => `mcp__${RECORDS_SERVER}__${name}`

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/
const MAX_OUTPUT = 60_000

export interface RecordToolSpec {
  name: string
  description: string
  schema: z.ZodObject<Record<string, ZodTypeAny>>
  readOnly: boolean
  /** A connector's update: its outcome becomes a card in the reply. */
  card?: { pluginId: string; systemLabel: string; labels: Record<string, string> }
  /** The server call for a validated input. */
  request(input: Record<string, unknown>): { method: 'GET' | 'POST'; path: string; body?: unknown }
}

const id = z.string().regex(/^[a-z][a-z0-9_]{0,39}-[0-9a-z]{6,32}$/)
const scalar = z.union([z.string().max(200), z.number(), z.boolean(), z.null()])

/** The zod type of a value of `kind` (the server checks it again). */
export function kindSchema(kind: FieldKind, options?: string[]): ZodTypeAny {
  switch (kind) {
    case 'text': return z.string().max(500)
    case 'long_text': return z.string().max(5000)
    case 'number': return z.number()
    case 'boolean': return z.boolean()
    case 'date': return z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    case 'datetime': return z.string().max(40)
    case 'choice': return options && options.length > 0 ? z.enum(options as [string, ...string[]]) : z.string()
    case 'person': return z.string().min(1).max(200).describe('メンバーの id / member id')
    case 'record': return id
  }
}

const enc = encodeURIComponent

const LOOKUPS: RecordToolSpec[] = [
  {
    name: 'records_my_turn', readOnly: true, schema: z.object({}).strict(),
    description: '「あなたの番」：このメンバーが次に動く依頼（タスクなど）の一覧。状態・担当・期限はサーバーの記録が正で、ファイルには書かれていない。\nThe member\'s turn: requests (tasks…) waiting for them. State, assignee and due date live on the server, never in files.',
    request: () => ({ method: 'GET', path: '/my-turn' }),
  },
  {
    name: 'records_query', readOnly: true,
    schema: z.object({
      type: z.string().max(40).optional(), implements: z.string().max(40).optional(),
      state: z.array(z.string().max(40)).max(20).optional(),
      fields: z.record(z.string(), z.union([scalar, z.object({ in: z.array(scalar).max(50) })])).optional(),
      linkedTo: z.object({ id, hops: z.union([z.literal(1), z.literal(2)]).optional() }).optional(),
      text: z.string().max(100).optional(), limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).max(10000).optional(),
      countOnly: z.boolean().optional(),
      includeOldConnection: z.boolean().optional().describe('前のつなぎ先から取り込んだ、いまは使われていない記録も含める（ふつうは付けない） / also records of an earlier connection, no longer used (normally leave out)'),
    }).strict(),
    description: '会社の記録（タスク・顧客など）を決まった形で探す：型、状態、サーバーの欄の値、つながり（2段まで、例「A社につながる全部」）、件名と要約の文字。件数は countOnly。見られるものだけが返る。前のつなぎ先から取り込んだ、いまは使われていない記録はふつう返らない（includeOldConnection で含めると fromOldConnection: true の印つき）。\nFind company records: by type, state, server-field values, links up to 2 hops ("everything linked to customer X"), text in title/summary. Only what the member may read is returned. Records imported through an earlier connection (no longer used) are left out unless includeOldConnection; they then carry fromOldConnection: true.',
    request: input => ({ method: 'POST', path: '/query', body: input }),
  },
  {
    name: 'records_get', readOnly: true, schema: z.object({ id }).strict(),
    description: '記録を1件、つながりと一緒に読む。version は操作のときの expectedVersion に使う。fromOldConnection: true の記録は前のつなぎ先から取り込んだもの（いまは使われていない）：操作も最新化もできない。\nRead one record with its links; pass its `version` as `expectedVersion` when acting on it. A record with fromOldConnection: true came through an earlier connection and is no longer used: nothing can be run on it.',
    request: input => ({ method: 'GET', path: `/item/${enc(String(input.id))}` }),
  },
  {
    name: 'records_history', readOnly: true, schema: z.object({ id }).strict(),
    description: '記録の台帳（誰が・いつ・何を・なぜ変えたか）。\nThe record\'s ledger: who changed what, when, and why.',
    request: input => ({ method: 'GET', path: `/item/${enc(String(input.id))}/history` }),
  },
  {
    name: 'records_types', readOnly: true, schema: z.object({}).strict(),
    description: '記録の型の定義（欄・状態・操作）。\nThe record types: fields, states, actions.',
    request: () => ({ method: 'GET', path: '/types' }),
  },
]

/** The state-changing tools for these types (one per action, and creating server-only records). */
export function actionToolSpecs(types: TypeDefinition[]): RecordToolSpec[] {
  const specs: RecordToolSpec[] = []
  const creatable = types.filter(t => t.storage !== 'file').map(t => t.name)
  if (creatable.length > 0) {
    specs.push({
      name: 'records_create', readOnly: false,
      schema: z.object({
        type: z.enum(creatable as [string, ...string[]]), title: z.string().min(1).max(200), summary: z.string().max(300).optional(),
        fields: z.record(z.string(), scalar).optional(), links: z.record(z.string(), z.union([z.string(), z.array(z.string()).max(50)])).optional(),
      }).strict(),
      description: `サーバーだけに置く記録（${creatable.join(', ')}）を作る。依頼した人は自分になる。人や顧客の名前ではなく id を使う。\nCreate a server-only record (${creatable.join(', ')}). Name people and customers by id.`,
      request: input => ({ method: 'POST', path: '/item', body: input }),
    })
  }
  for (const t of types) {
    for (const [name, a] of Object.entries(t.actions)) {
      const tool = `${t.name}__${name}`
      if (!TOOL_NAME_RE.test(tool)) continue
      const shape: Record<string, ZodTypeAny> = {
        id,
        expectedVersion: z.number().int().min(0).describe('records_get で見た version / the version you read'),
        note: a.note === 'required' ? z.string().min(1).max(2000) : z.string().max(2000).optional(),
      }
      for (const [arg, kind] of Object.entries(a.args)) shape[arg] = kindSchema(kind, t.fields[arg]?.options)
      const from = a.from ? a.from.join(' / ') : 'どの状態からでも'
      const aiNote = a.who.includes('ai') ? '' : ' この操作は AI からはできない（本人が画面で行う）。This action is not open to the AI: ask the member to do it.'
      specs.push({
        name: tool, readOnly: false, schema: z.object(shape).strict(),
        description: `「${t.label}」の「${a.label}」（${from} → ${a.to ?? '状態はそのまま'}）。${a.note === 'required' ? 'note（ひとことの理由）が必須。' : ''}${aiNote}\n` +
          `${t.name}.${name}: from ${a.from ? a.from.join('/') : 'any state'} to ${a.to ?? 'the same state'}.${a.note === 'required' ? ' `note` is required.' : ''}`,
        request: input => {
          const args = Object.fromEntries(Object.keys(a.args).map(k => [k, input[k]]))
          return { method: 'POST', path: `/item/${enc(String(input.id))}/actions/${enc(name)}`, body: { expectedVersion: input.expectedVersion, ...(input.note !== undefined ? { note: input.note } : {}), args } }
        },
      })
    }
  }
  return specs
}

/** Tool names are `<plugin>__<operation>`; the plugin id is the declaration's (`^[a-z][a-z0-9_-]*`). */
export function pluginToolName(pluginId: string, operation: string): string { return `${pluginId}__${operation}` }

/**
 * The tools for the running plugins' operations (P7). `writes`: whether this
 * agent may write (registry `recordActions`; Codex never). The server
 * filters the same way for a read token and decides every call anyway.
 */
export function pluginToolSpecs(tools: PluginAiTools, writes: boolean): RecordToolSpec[] {
  const specs: RecordToolSpec[] = []
  for (const p of tools.plugins) {
    for (const op of p.operations) {
      const name = pluginToolName(p.id, op.name)
      if (!TOOL_NAME_RE.test(name)) continue
      const path = (id: unknown) => `/plugins/${enc(p.id)}/records/${enc(String(id))}/operations/${enc(op.name)}`
      if (op.kind === 'read') {
        specs.push({
          name, readOnly: true, schema: z.object({ id }).strict(),
          description: `${p.label} から、この案件の最新の値を取り込む（読むだけ。${p.label} は変えない）。そのあと records_get で読む。\n` +
            `Bring the record's latest values in from ${p.label} (read only), then read it with records_get.`,
          request: input => ({ method: 'POST', path: path(input.id), body: {} }),
        })
        continue
      }
      if (!writes) continue
      specs.push(updateSpec(p.id, p.label, op, name, path))
    }
  }
  return specs
}

function updateSpec(pluginId: string, system: string, op: PluginAiOperation, name: string, path: (id: unknown) => string): RecordToolSpec {
  const fieldShape: Record<string, ZodTypeAny> = {}
  for (const f of op.fields) {
    const desc = `${f.label}${f.policy === 'prior' ? '（承認が要る欄：いまは書けず、断られる / needs approval: refused for now）' : ''}`
    fieldShape[f.name] = kindSchema(f.kind as FieldKind, f.options).optional().describe(desc)
  }
  const auto = op.fields.filter(f => f.policy === 'auto').map(f => f.label)
  const prior = op.fields.filter(f => f.policy === 'prior').map(f => f.label)
  const reason = op.decision
    ? z.string().trim().min(1).max(2000).describe('相談のどの発言からそう判断したか：理由と根拠（発言の要約か引用） / the reason, drafted from the consultation, citing the message it rests on')
    : z.string().max(2000).optional()
  return {
    name, readOnly: false,
    card: { pluginId, systemLabel: system, labels: Object.fromEntries(op.fields.map(f => [f.name, f.label])) },
    schema: z.object({
      id,
      expectedVersion: z.number().int().min(0).describe('records_get で見た version / the version you read'),
      fields: z.object(fieldShape).strict().describe('変える欄だけ（1つ以上） / only the fields to change (at least one)'),
      note: reason,
    }).strict(),
    description: `「${op.label}」：${system} の案件の欄を書き換える（ACB の言葉で渡す。${system} の項目名への読み替えは ACB が行う）。` +
      `すぐ書ける欄：${auto.join('、') || 'なし'}。${prior.length ? `承認が要る欄（いまは断られる）：${prior.join('、')}。` : ''}` +
      `承認が要る欄が1つでも入ると、全部を断られる。` +
      (op.decision ? '理由（note）は必須：相談の中のメンバーの発言から下書きし、根拠になった発言を示す。' : '') +
      `結果は相談の中にカードとして出る。結果が「更新した（applied）」でないときは、成功したと言わない。届いたか分からない（unknown）ときは送り直さず、メンバーに確かめてもらう。\n` +
      `${name}: write fields of this deal to ${system} (ACB values; the mapping translates). Auto: ${op.fields.filter(f => f.policy === 'auto').map(f => f.name).join(', ') || 'none'}.` +
      `${prior.length ? ` Needs approval (refused now): ${op.fields.filter(f => f.policy === 'prior').map(f => f.name).join(', ')}.` : ''}` +
      (op.decision ? ' `note` is required: draft the reason from the consultation and cite the message it rests on.' : '') +
      ' Never claim success unless the outcome is `applied`; when it is `unknown`, do not resend — ask the member to check.',
    request: input => ({
      method: 'POST', path: path(input.id),
      body: { expectedVersion: input.expectedVersion, fields: Object.fromEntries(Object.entries(input.fields as Record<string, unknown>).filter(([, v]) => v !== undefined)), ...(input.note !== undefined ? { note: input.note } : {}) },
    }),
  }
}

export const RECORDS_INSTRUCTIONS = `\n\n【会社の記録】${'`'}mcp__${RECORDS_SERVER}__*${'`'} は会社の記録（タスクなど）の道具です。状態・担当・期限はサーバーが持ち、記録のファイルには書きません（ファイルの先頭は id・type・links だけ）。状態を変えるときは必ずこの道具の操作を使い、ファイルを書き換えないでください。記録に書くときは、人や顧客を名前ではなく id で指してください。` +
  `メンバーへの返事では、記録を件名と見分けのつく情報（担当・金額・取り込んだ日・更新した日など）で呼び、内部の id（deal-… などの記録の id、HubSpot などの外の番号、操作の id）は、聞かれない限り見せないでください。道具を呼ぶときは、これまでどおり id を使います。` +
  `fromOldConnection: true の記録は「${OLD_CONNECTION_LABEL}」です。使わず、話に出すときはそう添えてください。`

export interface RecordTools {
  specs: RecordToolSpec[]
  execute(name: string, input: unknown): Promise<string>
  close(): Promise<void>
  instructions: string
}

/**
 * The record tools for one turn, or null when the company map is off (or
 * unreachable). `actions`: whether this agent may change state (registry
 * `recordActions`); the token's scope follows it.
 */
export interface RecordToolsOptions {
  /** For the cards: the company and the consultation. */
  companyId?: string
  conversationId?: string | null
  /** A connector's update finished (any outcome): its card for the reply. */
  onOperationCard?: (card: PluginOperationCard) => void
  /** Card ids (default: random). */
  newId?: () => string
  now?: () => Date
}

export async function createRecordTools(access: RecordTurnAccess, signal?: AbortSignal, options: RecordToolsOptions = {}): Promise<RecordTools | null> {
  let types: TypeDefinition[]
  try {
    const answer = await access.call('GET', '/types', undefined, signal) as { types?: Array<{ definition: TypeDefinition }> }
    types = (answer.types ?? []).map(t => t.definition)
  } catch {
    await access.close()
    return null
  }
  // The running plugins' operations; none when the server has none (or is older).
  let plugins: PluginAiTools = { plugins: [] }
  try {
    const answer = await access.call('GET', '/plugins', undefined, signal) as PluginAiTools | undefined
    if (answer && Array.isArray(answer.plugins)) plugins = answer
  } catch { /* no plugin tools this turn */ }
  const specs = [...LOOKUPS, ...(access.scope === 'act' ? actionToolSpecs(types) : []), ...pluginToolSpecs(plugins, access.scope === 'act')]
  const newId = options.newId ?? (() => crypto.randomUUID())
  const now = options.now ?? (() => new Date())
  const byName = new Map(specs.map(s => [s.name, s]))
  return {
    specs,
    instructions: RECORDS_INSTRUCTIONS,
    close: () => access.close(),
    async execute(name, input) {
      const spec = byName.get(name)
      if (!spec) return JSON.stringify({ error: 'この道具はありません。' })
      const parsed = spec.schema.safeParse(input ?? {})
      if (!parsed.success) return JSON.stringify({ error: '入力が正しくありません。', issues: parsed.error.issues.slice(0, 5).map(i => `${i.path.join('.')}: ${i.message}`) })
      const req = spec.request(parsed.data)
      if (spec.card) return runUpdate(spec.card, parsed.data, req)
      try {
        const out = JSON.stringify(await access.call(req.method, req.path, req.body, signal))
        return out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}…（長いため切り詰めました / truncated）` : out
      } catch (error) {
        if (error instanceof RecordsApiError) return JSON.stringify({ error: error.message, code: error.code })
        throw error
      }
    },
  }

  /** A connector's update: the server's answer becomes a card, and the AI is told only what is known. */
  async function runUpdate(card: NonNullable<RecordToolSpec['card']>, input: Record<string, unknown>, req: ReturnType<RecordToolSpec['request']>): Promise<string> {
    const body = req.body as { fields: Record<string, CardContext['asked'][string]>; note?: string }
    const ctx: CardContext = {
      id: newId(), companyId: options.companyId ?? '', conversationId: options.conversationId ?? null, pluginId: card.pluginId, systemLabel: card.systemLabel,
      recordId: String(input.id), labels: card.labels, asked: body.fields, reason: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null,
      byAi: true, at: now().toISOString(),
    }
    let result: PluginOperationCard
    try {
      result = cardFromAnswer(ctx, await access.call(req.method, req.path, req.body, signal) as Parameters<typeof cardFromAnswer>[1])
    } catch (error) {
      // Not a refusal the server gave (the turn stopped mid-request…): whether it arrived is not known.
      result = error instanceof RecordsApiError ? cardFromRefusal(ctx, error.code, error.message, error.details) : cardFromRefusal(ctx, 'OFFLINE', undefined)
      if (!(error instanceof RecordsApiError)) {
        if (options.companyId) options.onOperationCard?.(result)
        throw error
      }
    }
    if (options.companyId) options.onOperationCard?.(result)
    return JSON.stringify(aiSummaryOf(result))
  }
}

/** Codex: the same tools behind a request-scoped loopback MCP endpoint. */
export function startRecordsMcp(tools: RecordTools) {
  return startLoopbackMcp(RECORDS_SERVER, tools.specs.map(s => ({
    name: s.name, description: s.description, inputSchema: s.schema.shape,
    execute: (args: unknown) => tools.execute(s.name, args),
    annotations: { readOnlyHint: s.readOnly, destructiveHint: false, openWorldHint: false },
  })))
}
