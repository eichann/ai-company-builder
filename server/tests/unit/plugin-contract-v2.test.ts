/**
 * Plugin contract 2 (plan C1, `.claude/rules/plugins.md` "Contract 2"): the
 * declaration shapes of stages 4a / 4b, fixed once.
 *
 * Guards:
 * - contract 1 packages read exactly as before, and none of contract 2's keys
 *   or folders is accepted on them (nor on a connector);
 * - unknown keys, expressions / conditions / branching settings, destinations
 *   outside the package and anything that would run on the server are refused
 *   at every level; `scripts` is refused (4a);
 * - a step names a real, non-final state of its plugin's or a core type, its
 *   default procedure is in `steps/`, which holds nothing else; a frame's
 *   entry is a file under `ui/`; `role:<name>` only for a declared role;
 * - settings are typed values within their bounds; a company Skill replaces a
 *   procedure only where the step allows it and never adds tools;
 * - `moves_money` (contract 2, a business operation that writes) asks first
 *   like reaching outside: never `auto`, whatever the company chooses;
 * - fingerprint v2 changes with any byte, name or file and ignores the
 *   signature slot; the signature slot is shape-checked, and a company's key
 *   signs only that company's own package.
 */
import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import {
  asksFirst, combineUse, companySkillOverrideProblem, effectiveFieldPolicy, effectiveOperationPolicy, parsePluginSignature, pluginFingerprintV2, pluginFingerprintV2Listing, settingValueProblem,
  stepToolsFor, validatePluginPackage, type PluginManifest, type PluginPackage,
} from '../../../shared/core/plugins'

const FIXTURES = join(__dirname, '../fixtures/plugins')
const sha256Hex = (d: Uint8Array | string) => createHash('sha256').update(d).digest('hex')

type Files = { manifest: string; types: Record<string, string>; mapping: string | null; steps: Record<string, string>; ui: string[] }
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(n => statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)])
}
function readPackage(name: string): Files {
  const dir = join(FIXTURES, name)
  const types: Record<string, string> = {}
  if (existsSync(join(dir, 'types'))) for (const f of readdirSync(join(dir, 'types'))) types[f.replace(/\.md$/, '')] = readFileSync(join(dir, 'types', f), 'utf8')
  const steps: Record<string, string> = {}
  if (existsSync(join(dir, 'steps'))) for (const f of readdirSync(join(dir, 'steps'))) steps[`steps/${f}`] = readFileSync(join(dir, 'steps', f), 'utf8')
  const ui = existsSync(join(dir, 'ui')) ? walk(join(dir, 'ui')).map(p => relative(dir, p).split('\\').join('/')).sort() : []
  const mapping = existsSync(join(dir, 'mapping.yaml')) ? readFileSync(join(dir, 'mapping.yaml'), 'utf8') : null
  return { manifest: readFileSync(join(dir, 'plugin.yaml'), 'utf8'), types, mapping, steps, ui }
}

const FLOW = readPackage('sample-flow')
const HUB = readPackage('sample-hub')
const SALES = readPackage('sample-sales')

function valid(files: Partial<Files> & { manifest: string }): PluginPackage {
  const r = validatePluginPackage({ types: {}, ...files })
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return r.value
}
function errors(files: Partial<Files> & { manifest: string }): string {
  const r = validatePluginPackage({ types: {}, ...files })
  return r.ok ? '' : r.errors.join('\n')
}
/** sample-flow with its declaration changed (each replacement must apply). */
function flowWith(...pairs: Array<[string, string]>): Files {
  let manifest = FLOW.manifest
  for (const [from, to] of pairs) {
    if (!manifest.includes(from)) throw new Error(`not in sample-flow: ${from}`)
    manifest = manifest.replace(from, to)
  }
  return { ...FLOW, manifest }
}
const flowErrors = (...pairs: Array<[string, string]>) => errors(flowWith(...pairs))
const STEP_TOOLS_LINE = '    tools: [records, plugin_operations, files_read, files_write]'
const SETTINGS_LINE = 'settings:\n'

describe('plugin contract 2: the shapes of stages 4a / 4b', () => {
  it('reads roles, settings, steps, ui and upgrade, and combines with its connector keeping role:<name>', () => {
    const p = valid(FLOW)
    const m = p.manifest
    expect(m.contract).toBe(2)
    expect(m.roles).toEqual({ sales_manager: { label: '営業の責任者', description: '金額の承認をする人' } })
    expect(m.steps.prepare_proposal).toEqual({
      label: '提案書を用意する', for: { type: 'deal', state: 'open' }, start: 'person',
      procedure: { default: 'steps/proposal.md', overridable: true },
      tools: ['records', 'plugin_operations', 'files_read', 'files_write'], connectorRoles: ['mail.read'],
    })
    // A step may follow a core type (the meeting's minutes arriving).
    expect(m.steps.read_minutes).toMatchObject({ for: { type: 'meeting', state: 'received' }, start: 'ai_turn', procedure: { overridable: false } })
    expect(m.ui).toEqual({
      bridge: 1, tab: { label: '案件', icon: 'Briefcase', entry: 'ui/index.html' }, peek: { implements: 'request', stateGroup: 'mine' },
      recordSections: [{ type: 'deal', label: '提案の材料', entry: 'ui/deal.html' }],
    })
    expect(m.upgrade).toEqual({ from: '0.1.0', at: [{ type: 'deal', state: 'open' }] })
    expect(Object.keys(m.settings)).toEqual(['approval_amount', 'reply_within', 'tone', 'cc_manager', 'amount_approver', 'mail_service'])
    expect(m.settings.mail_service).toEqual({ kind: 'connector', label: 'メールを送るサービス', connectorRole: 'mail.send', default: null })
    const combined = combineUse(p, valid(HUB).manifest)
    if (!combined.ok) throw new Error(combined.errors.join('\n'))
    expect(combined.value.manifest.operations.update_deal.who).toEqual(['assignee', 'role:sales_manager', 'ai'])
    expect(combined.value.manifest.steps).toEqual(m.steps)
  })

  it('reads contract 1 packages as before; contract 2 keys, folders and role:<name> are refused there and on a connector', () => {
    for (const name of ['sample-hub', 'sample-crm', 'sample-desk', 'sample-sales', 'sample-crm-sales', 'sample-support']) {
      const p = valid(readPackage(name))
      expect(p.manifest.contract, name).toBe(1)
      expect(p.manifest, name).toMatchObject({ roles: {}, settings: {}, steps: {}, ui: null, upgrade: null })
    }
    for (const key of ['roles: {}', 'settings: {}', 'steps: {}', 'ui: { bridge: 1 }', 'upgrade: { from: 0.0.1, at: [] }']) {
      expect(errors({ ...SALES, manifest: `${SALES.manifest}${key}\n` }), key).toMatch(/contract: 2 の包みだけ/)
      // A connector never has a flow, whatever its contract.
      expect(errors({ manifest: `${HUB.manifest.replace('contract: 1', 'contract: 2')}${key}\n` }), key).toMatch(/業務のプラグインだけ/)
    }
    expect(errors({ ...SALES, steps: { 'steps/x.md': '# x' } })).toMatch(/手順書（steps\/）は置けません/)
    expect(errors({ ...SALES, ui: ['ui/index.html'] })).toMatch(/画面（ui\/）は置けません/)
    expect(errors({ manifest: HUB.manifest, ui: ['ui/index.html'] })).toMatch(/つなぎ先のプラグインには画面/)
    expect(errors({ ...SALES, manifest: SALES.manifest.replace('who: [viewer, ai]', 'who: [viewer, role:boss]') })).toMatch(/who は人の欄の名前か/)
    // The same package says contract 2: it is read (the flow keys are optional).
    expect(valid({ ...SALES, manifest: SALES.manifest.replace('contract: 1', 'contract: 2') }).manifest.contract).toBe(2)
  })

  it('refuses unknown keys at every level', () => {
    expect(flowErrors(['contract: 2\n', 'contract: 2\nworkflow: x\n'])).toMatch(/知らない項目「workflow」/)
    expect(flowErrors(['roles:\n  sales_manager: { label: 営業の責任者,', 'roles:\n  sales_manager: { label: 営業の責任者, members: [a],'])).toMatch(/知らない項目「members」/)
    expect(flowErrors([STEP_TOOLS_LINE, `${STEP_TOOLS_LINE}\n    retries: 3`])).toMatch(/知らない項目「retries」/)
    expect(flowErrors(['overridable: true }', 'overridable: true, version: 2 }'])).toMatch(/知らない項目「version」/)
    expect(flowErrors(['  bridge: 1\n', '  bridge: 1\n  theme: dark\n'])).toMatch(/知らない項目「theme」/)
    expect(flowErrors(['icon: Briefcase,', 'icon: Briefcase, badge: count,'])).toMatch(/知らない項目「badge」/)
    expect(flowErrors(['state_group: mine }', 'state_group: mine, limit: 4 }'])).toMatch(/知らない項目「limit」/)
    expect(flowErrors(['entry: ui/deal.html }', 'entry: ui/deal.html, height: 300 }'])).toMatch(/知らない項目「height」/)
    expect(flowErrors(['  from: 0.1.0\n', '  from: 0.1.0\n  auto: true\n'])).toMatch(/知らない項目「auto」/)
    expect(flowErrors(['kind: boolean, default: true }', 'kind: boolean, default: true, scope: dept }'])).toMatch(/知らない項目「scope」/)
  })

  it('refuses expressions, conditions, destinations, scripts and anything that runs on the server', () => {
    // Conditions and expressions, in a step and as the trigger.
    expect(flowErrors([STEP_TOOLS_LINE, `${STEP_TOOLS_LINE}\n    when: "amount > 100"`])).toMatch(/「when」: 条件は書けません/)
    expect(flowErrors([STEP_TOOLS_LINE, `${STEP_TOOLS_LINE}\n    cron: "0 11 * * *"`])).toMatch(/きっかけは記録の状態/)
    expect(flowErrors(['for: { type: deal, state: open }', 'for: { type: deal, state: open, if: "x" }'])).toMatch(/「if」: 条件は書けません/)
    expect(flowErrors(['for: { type: deal, state: open }', 'for: { type: deal, state: "open || won" }'])).toMatch(/state は状態の名前/)
    // Nothing runs on the server: neither a step nor the package.
    expect(flowErrors([STEP_TOOLS_LINE, `${STEP_TOOLS_LINE}\n    runs_on: server`])).toMatch(/サーバーで動かす指定はありません/)
    expect(flowErrors(['contract: 2\n', 'contract: 2\nruns_on: server\n'])).toMatch(/サーバーで動かす指定はありません/)
    expect(flowErrors([STEP_TOOLS_LINE, '    tools: [records, server_exec]'])).toMatch(/「server_exec」という道具はありません/)
    // No scripts in 4a, in a step or at the top.
    expect(flowErrors([STEP_TOOLS_LINE, `${STEP_TOOLS_LINE}\n    scripts: [scripts/rank.js]`])).toMatch(/スクリプトはまだ使えません/)
    expect(flowErrors(['contract: 2\n', 'contract: 2\nscripts: [scripts/rank.js]\n'])).toMatch(/プログラムは書けません/)
    // A frame's entry is a file of the package, never another place.
    for (const bad of ['https://evil.example/index.html', '../index.html', 'ui/../plugin.yaml', '/ui/index.html', 'ui/index.js']) {
      expect(flowErrors(['entry: ui/index.html', `entry: "${bad}"`]), bad).toMatch(/外の場所は書けません/)
    }
    expect(flowErrors(['  bridge: 1\n', '  bridge: 1\n  connect: [https://api.example]\n'])).toMatch(/通信できません/)
    expect(flowErrors(['state_group: mine }', 'state_group: mine, entry: ui/peek.html }'])).toMatch(/のぞき見は本体が描きます/)
    expect(flowErrors(['  bridge: 1\n', '  bridge: 2\n'])).toMatch(/bridge は橋の版/)
    // A procedure is a file of the package; which company Skill replaces it is not the declaration's.
    expect(flowErrors(['procedure: { default: steps/proposal.md,', 'procedure: { default: "https://x.example/p.md",'])).toMatch(/default は包みの中の手順書/)
    expect(flowErrors(['overridable: true }', 'overridable: true, skill: sales-proposal-v1 }'])).toMatch(/会社の設定です/)
    expect(flowErrors(['    start: person\n', '    start: server\n'])).toMatch(/start は ai_turn \/ person/)
  })

  it('settings are parameters: typed, bounded, with a default — never anything that branches the flow', () => {
    for (const [line, why] of [
      ['  tone2: { label: 文面, kind: choice, options: [formal, casual], when: "amount > 1", default: formal }', /流れ（状態・操作・手順）を分ける書き方はありません/],
      ['  path: { label: 道, kind: choice, options: [a, b], default: a, selects: { a: s1, b: s2 } }', /流れ（状態・操作・手順）を分ける/],
      ['  skip: { label: 飛ばす, kind: boolean, default: false, steps: [read_minutes] }', /流れ（状態・操作・手順）を分ける/],
      ['  calc: { label: 計算, kind: expression, default: "a + b" }', /kind は number/],
      ['  n: { label: 数, kind: number, default: 5, min: 10 }', /default: 10 以上です/],
      ['  n: { label: 数, kind: number, default: "5" }', /数で書いてください/],
      ['  n: { label: 数, kind: number, min: 1 }', /default（会社が変えないときの値）/],
      ['  d: { label: 時間, kind: duration, default: 1w }', /30m・2h・3d/],
      ['  d: { label: 時間, kind: duration, default: 20d, max: 14d }', /14d 以下です/],
      ['  c: { label: 選ぶ, kind: choice, options: [a, b], default: c }', /a \/ b のどれか/],
      ['  c: { label: 選ぶ, kind: choice, options: ["{{x}}", b], default: b }', /options は選べる値の名前/],
      ['  r: { label: 人, kind: role, default: someone }', /roles の名前か dept_manager \/ admin/],
      ['  s: { label: サービス, kind: connector, connector_role: mail.send, default: gmail }', /default は書けません/],
    ] as Array<[string, RegExp]>) {
      expect(flowErrors([SETTINGS_LINE, `${SETTINGS_LINE}${line}\n`]), line).toMatch(why)
    }
    const m = valid(FLOW).manifest
    // A company's value is checked the same way (the admin's setting, later).
    expect(settingValueProblem(m.settings.reply_within, '3d', m.roles)).toBeNull()
    expect(settingValueProblem(m.settings.reply_within, '30m', m.roles)).toMatch(/1h 以上/)
    expect(settingValueProblem(m.settings.approval_amount, -1, m.roles)).toMatch(/0 以上/)
    expect(settingValueProblem(m.settings.amount_approver, 'admin', m.roles)).toBeNull()
    expect(settingValueProblem(m.settings.amount_approver, 'viewer', m.roles)).not.toBeNull()
    expect(settingValueProblem(m.settings.tone, 'rude', m.roles)).not.toBeNull()
  })

  it('checks steps, frames, roles and upgrade points against the types and the files', () => {
    expect(flowErrors(['for: { type: deal, state: open }', 'for: { type: lead, state: open }'])).toMatch(/型「lead」は、このプラグインの types にも本体の型にもありません/)
    expect(flowErrors(['for: { type: deal, state: open }', 'for: { type: deal, state: drafting }'])).toMatch(/状態「drafting」は型「deal」の states にありません/)
    expect(flowErrors(['for: { type: deal, state: open }', 'for: { type: deal, state: won }'])).toMatch(/終わりの状態です/)
    expect(errors({ ...FLOW, steps: { 'steps/read-minutes.md': '#' } })).toMatch(/steps\/proposal.md が包みにありません/)
    expect(errors({ ...FLOW, steps: { ...FLOW.steps, 'steps/extra.md': '#' } })).toMatch(/steps\/extra.md はどの手順/)
    expect(errors({ ...FLOW, ui: ['ui/index.html'] })).toMatch(/ui\/deal.html が包みにありません/)
    expect(errors({ ...FLOW, manifest: FLOW.manifest.slice(0, FLOW.manifest.indexOf('ui:\n')) })).toMatch(/宣言に ui を書いてください/)
    expect(flowErrors(['{ type: deal, label: 提案の材料', '{ type: lead, label: 提案の材料'])).toMatch(/record_sections: 型「lead」/)
    expect(flowErrors(['who: [assignee, role:sales_manager, ai]', 'who: [assignee, role:boss, ai]'])).toMatch(/役割「boss」が roles にありません/)
    expect(flowErrors(['  from: 0.1.0\n', '  from: 0.2.0\n'])).toMatch(/この版より古い版/)
    expect(flowErrors(['at: [{ type: deal, state: open }]', 'at: [{ type: deal, state: lost }]'])).toMatch(/終わりの状態/)
    // plugin_operations only with a connector.
    const noConnector = flowWith(['connector: sample-hub >= 0.1.0\n', ''], ['objects:\n  deal: { record_type: deal }\n  company: { record_type: customer }\n', ''],
      ['operations:\n  refresh_deal:\n    who: [viewer, ai]\n  update_deal:\n    who: [assignee, role:sales_manager, ai]\n    note: optional\n    decision: true\n    moves_money: true           # asks first like an operation reaching outside (contract 2)\n', ''])
    expect(errors(noConnector)).toMatch(/plugin_operations は、つなぎ先を使う業務のプラグイン/)
  })

  it('a company Skill replaces a procedure only where the step allows it, and never gets more tools than the step', () => {
    const m = valid(FLOW).manifest
    expect(companySkillOverrideProblem(m, 'prepare_proposal', 'sales-proposal-v1')).toBeNull()
    expect(companySkillOverrideProblem(m, 'read_minutes', 'my-minutes')).toMatch(/置き換えられません/)
    expect(companySkillOverrideProblem(m, 'prepare_proposal', '../evil')).toMatch(/スキルの名前/)
    expect(companySkillOverrideProblem(m, 'nope', 'x')).toMatch(/ありません/)
    const step = m.steps.prepare_proposal
    expect(stepToolsFor(step)).toEqual(step.tools)
    expect(stepToolsFor(step, ['records', 'web_research', 'outbound_draft', 'files_write'])).toEqual(['records', 'files_write'])
  })
})

describe('fingerprint v2 and the signature slot', () => {
  const files = () => [
    { path: 'plugin.yaml', bytes: Buffer.from('id: x\n') },
    { path: 'steps/a.md', bytes: Buffer.from('# a\n') },
    { path: 'ui/index.html', bytes: Buffer.from('<p>x</p>') },
  ]
  const fp = (f: Array<{ path: string; bytes: Uint8Array }>) => pluginFingerprintV2(f, sha256Hex)

  it('is the sha256 of each file\'s sha256 in name order; any byte, name or file changes it; the signature slot does not', () => {
    const base = fp(files())
    expect(base).toBe(sha256Hex(`acb-plugin-fingerprint-v2\n${files().map(f => `${sha256Hex(f.bytes)}  ${f.path}\n`).join('')}`))
    expect(fp(files().reverse())).toBe(base)
    const oneByte = files(); oneByte[2].bytes = Buffer.from('<p>y</p>')
    expect(fp(oneByte)).not.toBe(base)
    const renamed = files(); renamed[1].path = 'steps/b.md'
    expect(fp(renamed)).not.toBe(base)
    expect(fp([...files(), { path: 'ui/x.css', bytes: Buffer.from('') }])).not.toBe(base)
    expect(fp(files().slice(0, 2))).not.toBe(base)
    expect(fp([...files(), { path: 'signature.yaml', bytes: Buffer.from('signer: div') }])).toBe(base)
    expect(() => pluginFingerprintV2Listing([{ path: 'a', sha256: 'a'.repeat(64) }, { path: 'a', sha256: 'b'.repeat(64) }])).toThrow()
    expect(() => pluginFingerprintV2Listing([{ path: 'ui/../x', sha256: 'a'.repeat(64) }])).toThrow()
  })

  it('reads the signature slot for shape only; a company key signs only that company\'s own package', () => {
    const sig = (signer: string) => `signer: "${signer}"\nalgorithm: ed25519\nkey_id: div-2026\nvalue: ${'A'.repeat(86)}==\n`
    const official: Pick<PluginManifest, 'contract' | 'availableTo' | 'kind'> = { contract: 2, availableTo: null, kind: 'official' }
    const own: Pick<PluginManifest, 'contract' | 'availableTo' | 'kind'> = { contract: 2, availableTo: ['co-1'], kind: 'company' }
    expect(parsePluginSignature(sig('div'), official)).toMatchObject({ ok: true, value: { signer: 'div', algorithm: 'ed25519', keyId: 'div-2026' } })
    expect(parsePluginSignature(sig('company:co-1'), own).ok).toBe(true)
    expect(parsePluginSignature(sig('company:co-1'), official).ok).toBe(false)
    expect(parsePluginSignature(sig('company:co-2'), own).ok).toBe(false)
    expect(parsePluginSignature(sig('company:co-1'), { ...own, availableTo: ['co-1', 'co-2'] }).ok).toBe(false)
    expect(parsePluginSignature(sig('someone'), official).ok).toBe(false)
    expect(parsePluginSignature(sig('div'), { ...official, contract: 1 }).ok).toBe(false)
    expect(parsePluginSignature(`${sig('div')}trusted: true\n`, official).ok).toBe(false)
    expect(parsePluginSignature(sig('div').replace('ed25519', 'none'), official).ok).toBe(false)
  })
})

describe('an operation that moves money (moves_money)', () => {
  const combineErrors = (files: Files) => { const c = combineUse(valid(files), valid(HUB).manifest); return c.ok ? '' : c.errors.join('\n') }
  const combined = (files: Files) => {
    const c = combineUse(valid(files), valid(HUB).manifest)
    if (!c.ok) throw new Error(c.errors.join('\n'))
    return c.value.manifest
  }
  const MONEY = '    moves_money: true           # asks first like an operation reaching outside (contract 2)\n'
  const NOTE_OP = 'operations:\n'
  const mapping = { objects: { deal: { fields: { next_step: { from: 'hs_next_step', write: true } } } }, policy: { next_step: 'auto' } } as never

  it('asks first like reaching outside: a write is never auto, whatever the company chose', () => {
    const m = combined(FLOW)
    expect(m.operations.update_deal.movesMoney).toBe(true)
    expect(m.operations.refresh_deal.movesMoney).toBe(false)
    expect(asksFirst(m.operations.update_deal)).toBe(true)
    expect(effectiveFieldPolicy(m, mapping, 'update_deal', 'next_step')).toBe('prior')
    // Without it the same mapping writes at once (the clamp is the declaration's).
    const plain = combined(flowWith([MONEY, '']))
    expect(asksFirst(plain.operations.update_deal)).toBe(false)
    expect(effectiveFieldPolicy(plain, mapping, 'update_deal', 'next_step')).toBe('auto')
    // A create that moves money: `prior` by default, `auto` refused (declared, or chosen by the company).
    const withNote = (extra: string) => flowWith([NOTE_OP, `${NOTE_OP}  add_note:\n    who: [assignee, ai]\n    moves_money: true\n${extra}`])
    const n = combined(withNote(''))
    expect(n.operations.add_note.policy).toBe('prior')
    expect(effectiveOperationPolicy(n, 'add_note', { policy: { add_note: 'auto' } })).toBe('prior')
    expect(combineErrors(withNote('    policy: auto\n'))).toMatch(/お金が動く操作は「自動」にできません/)
    // A field it writes cannot default to auto either (as with an operation reaching outside).
    const autoDefault = (files: Files) => combineErrors({ ...files, manifest: files.manifest.replace('roles:\n', 'field_policy_defaults:\n  next_step: auto\nroles:\n') })
    expect(autoDefault(FLOW)).toMatch(/欄「next_step」: 社外の人に届くか、お金が動く書き換えの操作があるため/)
    expect(autoDefault(flowWith([MONEY, '']))).toBe('')
  })

  it('only on a contract-2 business operation that writes; a boolean', () => {
    expect(flowErrors([MONEY, '    moves_money: maybe\n'])).toMatch(/moves_money は true か false です/)
    expect(errors({ ...SALES, manifest: SALES.manifest.replace('    note: optional\n    decision: true\n', `    note: optional\n    decision: true\n${MONEY}`) })).toMatch(/moves_money は contract: 2 の包みだけ/)
    expect(errors({ manifest: HUB.manifest.replace('    reaches: internal\n    undo: restore_previous\n', '    reaches: internal\n    undo: restore_previous\n    moves_money: true\n') })).toMatch(/「moves_money」は、つなぎ先を使う業務のプラグインの operations に書きます/)
    expect(combineErrors(flowWith(['    who: [viewer, ai]\n', '    who: [viewer, ai]\n    moves_money: true\n']))).toMatch(/読む操作はお金を動かしません/)
  })
})
