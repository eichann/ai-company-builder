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
 */
import { z, type ZodTypeAny } from 'zod'
import type { FieldKind, TypeDefinition } from '../../../shared/core/record-types'
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
    }).strict(),
    description: '会社の記録（タスク・顧客など）を決まった形で探す：型、状態、サーバーの欄の値、つながり（2段まで、例「A社につながる全部」）、件名と要約の文字。件数は countOnly。見られるものだけが返る。\nFind company records: by type, state, server-field values, links up to 2 hops ("everything linked to customer X"), text in title/summary. Only what the member may read is returned.',
    request: input => ({ method: 'POST', path: '/query', body: input }),
  },
  {
    name: 'records_get', readOnly: true, schema: z.object({ id }).strict(),
    description: '記録を1件、つながりと一緒に読む。version は操作のときの expectedVersion に使う。\nRead one record with its links; pass its `version` as `expectedVersion` when acting on it.',
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

export const RECORDS_INSTRUCTIONS = `\n\n【会社の記録】${'`'}mcp__${RECORDS_SERVER}__*${'`'} は会社の記録（タスクなど）の道具です。状態・担当・期限はサーバーが持ち、記録のファイルには書きません（ファイルの先頭は id・type・links だけ）。状態を変えるときは必ずこの道具の操作を使い、ファイルを書き換えないでください。人や顧客の名前ではなく id を使ってください。`

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
export async function createRecordTools(access: RecordTurnAccess, signal?: AbortSignal): Promise<RecordTools | null> {
  let types: TypeDefinition[]
  try {
    const answer = await access.call('GET', '/types', undefined, signal) as { types?: Array<{ definition: TypeDefinition }> }
    types = (answer.types ?? []).map(t => t.definition)
  } catch {
    await access.close()
    return null
  }
  const specs = [...LOOKUPS, ...(access.scope === 'act' ? actionToolSpecs(types) : [])]
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
      try {
        const out = JSON.stringify(await access.call(req.method, req.path, req.body, signal))
        return out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}…（長いため切り詰めました / truncated）` : out
      } catch (error) {
        if (error instanceof RecordsApiError) return JSON.stringify({ error: error.message, code: error.code })
        throw error
      }
    },
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
