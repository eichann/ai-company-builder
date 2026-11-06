/**
 * Plugins' shape (shared/core/plugins.ts, milestone 3 P1; two roles, owner
 * decision 2026-11-01).
 *
 * Guards:
 * - a declaration is data only: unknown keys, program / destination / key /
 *   approval keys, a different contract, a destination other than one
 *   https host, and unsafe paths make the package unusable;
 * - a connector is a shared part that knows no business plugin (no types,
 *   record types, who, policies, mapping, `maps_to`); a business plugin talks
 *   to the outside only through the one connector it names, and what runs is
 *   only what it declared (`combineUse`);
 * - operations reaching people outside the company are never `auto`
 *   (declaration, company mapping, and at run time);
 * - type names carry no layer or plugin name (§8-2), and a package's types
 *   are server-only (imported records create no files, §8-3);
 * - `available_to` limits a package to the listed companies (§8-4);
 * - values translate both ways without loss, and a mapping that could not
 *   write back unambiguously is refused; a tags field (stored as JSON text)
 *   is never mapped, so that text never reaches the outside system;
 * - the same mechanism takes a second, differently shaped package (§6-11).
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  acbToExternal, approverFor, checkMappingAgainstProperties, closingMoveFields, combineUse, effectiveFieldPolicy, effectiveOperationPolicy, externalToAcb,
  parsePluginManifest, parsePluginMapping, pluginAvailableTo, typeNameLayerProblem, validatePluginPackage,
  type PluginMapping, type PluginPackage,
} from '../../../shared/core/plugins'

const FIXTURES = join(__dirname, '../fixtures/plugins')

type Files = { manifest: string; types: Record<string, string>; mapping: string | null }
function readPackage(name: string): Files {
  const dir = join(FIXTURES, name)
  const types: Record<string, string> = {}
  if (existsSync(join(dir, 'types'))) for (const f of readdirSync(join(dir, 'types'))) types[f.replace(/\.md$/, '')] = readFileSync(join(dir, 'types', f), 'utf8')
  const mapping = existsSync(join(dir, 'mapping.yaml')) ? readFileSync(join(dir, 'mapping.yaml'), 'utf8') : null
  return { manifest: readFileSync(join(dir, 'plugin.yaml'), 'utf8'), types, mapping }
}

function valid(files: Files): PluginPackage {
  const r = validatePluginPackage(files)
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return r.value
}

/** The errors of validating both packages and combining them (empty when they combine). */
function useErrors(business: Files, connector: Files): string[] {
  const b = validatePluginPackage(business)
  const c = validatePluginPackage(connector)
  if (!b.ok || !c.ok) return [...(b.ok ? [] : b.errors), ...(c.ok ? [] : c.errors)]
  const u = combineUse(b.value, c.value.manifest)
  return u.ok ? [] : u.errors
}

function use(business: Files, connector: Files): PluginPackage {
  const u = combineUse(valid(business), valid(connector).manifest)
  if (!u.ok) throw new Error(u.errors.join('\n'))
  return u.value
}

const SALES = readPackage('sample-sales')
/** The fictional CRM connector and the business plugin using it (with its recommended mapping). */
const CRM = readPackage('sample-crm')
const CRM_SALES = { ...readPackage('sample-crm-sales'), mapping: readPackage('sample-crm-sales').mapping as string }
const DESK = readPackage('sample-desk')
const SUPPORT = readPackage('sample-support')

/** The CRM business plugin's use of the CRM, with its recommended mapping. */
function crm(): PluginPackage & { mapping: PluginMapping } {
  const p = use(CRM_SALES, CRM)
  const m = parsePluginMapping(CRM_SALES.mapping, p)
  if (!m.ok) throw new Error(m.errors.join('\n'))
  return { ...p, mapping: m.value }
}

/** The CRM connector's declaration with one line replaced (the line must exist). */
function crmWith(from: string, to: string): string {
  expect(CRM.manifest).toContain(from)
  return CRM.manifest.replace(from, to)
}

/** The CRM business plugin's declaration with one line replaced (the line must exist). */
function salesWith(from: string, to: string): string {
  expect(CRM_SALES.manifest).toContain(from)
  return CRM_SALES.manifest.replace(from, to)
}

function manifestErrors(text: string): string[] {
  const r = parsePluginManifest(text)
  return r.ok ? [] : r.errors
}

describe('the sample packages', () => {
  it('a CRM and a differently shaped help desk are both used by their business plugins, with their mappings', () => {
    expect(crm().mapping.objects.deal).toBeDefined()
    const desk = use(SUPPORT, DESK)
    expect(desk.manifest.objects.ticket.recordType).toBe('ticket')
    expect(parsePluginMapping(SUPPORT.mapping as string, desk).ok).toBe(true)
    expect(useErrors(SALES, readPackage('sample-hub'))).toEqual([])
  })
})

describe('a declaration is data only', () => {
  it('refuses unknown keys anywhere, naming program, destination, key and approval keys', () => {
    expect(manifestErrors(`${CRM.manifest}\nscript: ./sync.js\n`).join()).toContain('プログラムは書けません')
    expect(manifestErrors(`${CRM_SALES.manifest}\nscript: ./sync.js\n`).join()).toContain('プログラムは書けません')
    expect(manifestErrors(crmWith('    label: 最新を取る\n', '    label: 最新を取る\n    command: curl x\n')).join()).toContain('プログラムを起動する')
    expect(manifestErrors(crmWith('  deal:\n    auto_properties', '  deal:\n    url: https://evil.example\n    auto_properties')).join()).toContain('送り先は base_url だけです')
    expect(manifestErrors(`${CRM.manifest}\napi_key: pat-123\n`).join()).toContain('鍵の値は書けません')
    expect(manifestErrors(salesWith('    note: optional\n', '    note: optional\n    approver: admin\n')).join()).toContain('承認する権限は書けません')
    expect(manifestErrors(crmWith('    get:    { method: GET,   path: "/crm/objects/2026-03/deals/{id}" }', '    get:    { method: GET,   path: "/crm/objects/2026-03/deals/{id}", when: x }')).length).toBeGreaterThan(0)
    expect(manifestErrors(salesWith('  deal: { record_type: deal }', '  deal: { record_type: deal, when: x }')).join()).toContain('条件は書けません')
    expect(manifestErrors(`${CRM.manifest}\nwhatever: 1\n`).join()).toContain('知らない項目「whatever」')
  })

  it('a connector that writes names how to read its outside account (a connection is bound to one account, review §5.7)', () => {
    const without = crmWith('account_info: { method: GET, path: "/account-info/v3/details" }\n', '')
    expect(manifestErrors(without).join()).toContain('account_info')
    expect(manifestErrors(crmWith('account_info: { method: GET,', 'account_info: { method: POST,')).join()).toContain('account_info')
    // A connector that only reads (the help desk) needs none.
    expect(validatePluginPackage(DESK).ok).toBe(true)
  })

  it('refuses a contract this build does not know', () => {
    for (const bad of ['contract: 4', 'contract: 0', 'contract: "2"']) {
      expect(manifestErrors(crmWith('contract: 1', bad)).join()).toContain('contract')
      expect(manifestErrors(salesWith('contract: 1', bad)).join()).toContain('contract')
    }
  })

  it('sends only to one https host: no http, IP, localhost, port, query, or another host for a built-in service', () => {
    for (const bad of ['http://api.sample-crm.example', 'https://127.0.0.1', 'https://localhost', 'https://api.sample-crm.example:8443', 'https://api.sample-crm.example/?x=1', 'https://intranet.internal']) {
      expect(manifestErrors(crmWith('base_url: https://api.sample-crm.example', `base_url: ${bad}`)), bad).not.toEqual([])
    }
    const builtin = crmWith('service: sample-crm', 'service: openai')
    expect(manifestErrors(builtin).join()).toContain('api.openai.com')
  })

  it('refuses paths that could leave the declared place: other placeholders, absolute URLs, .., //, %2f, queries, wrong methods', () => {
    const get = '    get:    { method: GET,   path: "/crm/objects/2026-03/deals/{id}" }'
    for (const bad of ['/crm/{object}/{id}', 'https://other.example/{id}', '/crm/../admin/{id}', '/crm//deals/{id}', '/crm/%2e%2e/{id}', '/crm%2fx/{id}', '/deals/{id}?archived=true', '/deals/{id}#x', '/deals', '/deals/{id}/{id}', '/deals/{id}/{', '/deals/{id}}', 'deals/{id}']) {
      expect(manifestErrors(crmWith(get, `    get:    { method: GET,   path: "${bad}" }`)), bad).not.toEqual([])
    }
    expect(manifestErrors(crmWith(get, '    get:    { method: DELETE, path: "/crm/objects/2026-03/deals/{id}" }')).join()).toContain('method は GET')
  })

  it('inherits the strict YAML: anchors and aliases are refused', () => {
    expect(manifestErrors(crmWith('label: 見本の CRM', 'label: &l 見本の CRM')).length).toBeGreaterThan(0)
  })
})

describe('operations that reach people outside the company are never automatic', () => {
  const externalUpdate = { ...CRM, manifest: crmWith('    reaches: internal\n    undo: restore_previous', '    reaches: external\n    undo: restore_previous') }

  it('the declarations cannot make an external operation or its fields auto', () => {
    // The business plugin's field_policy_defaults has auto fields: refused once update_deal reaches outside people.
    expect(useErrors(CRM_SALES, externalUpdate).join()).toContain('「自動」にできません')
    const createExternal = { ...CRM, manifest: crmWith('    reaches: internal\n    undo: archive\n    content: { body', '    reaches: external\n    undo: archive\n    content: { body') }
    const autoNote = { ...CRM_SALES, manifest: salesWith('  add_note:\n    who: [assignee, dept_manager, admin, ai]\n', '  add_note:\n    who: [assignee, dept_manager, admin, ai]\n    policy: auto\n') }
    expect(useErrors(autoNote, createExternal).join()).toContain('社外の人に届く操作は「自動」にできません')
    // The connector itself has no say over policies (they are the business plugin's).
    expect(manifestErrors(crmWith('    reaches: internal\n    undo: archive\n    content: { body', '    reaches: internal\n    policy: auto\n    undo: archive\n    content: { body')).join()).toContain('業務のプラグインの operations に書きます')
  })

  it('a company mapping cannot set auto on a field an external operation writes', () => {
    const noAutoDefaults = { ...CRM_SALES, manifest: CRM_SALES.manifest.replace(/field_policy_defaults:[\s\S]*$/, '') }
    const pkg = use(noAutoDefaults, externalUpdate)
    const r = parsePluginMapping(`${CRM_SALES.mapping}\n`.replace('  close_date: prior', '  close_date: auto'), pkg)
    expect(r.ok ? [] : r.errors.join()).toContain('「自動」にできません')
  })

  it('at run time an external operation is at least prior, whatever the stored settings say', () => {
    const p = crm()
    const manifest = { ...p.manifest, operations: { ...p.manifest.operations } }
    manifest.operations.update_deal = { ...manifest.operations.update_deal, reaches: 'external' }
    manifest.operations.add_note = { ...manifest.operations.add_note, reaches: 'external', policy: 'auto' }
    expect(effectiveFieldPolicy(p, p.mapping, 'update_deal', 'next_step')).toBe('auto')
    expect(effectiveFieldPolicy({ ...p, manifest }, p.mapping, 'update_deal', 'next_step')).toBe('prior')
    expect(effectiveOperationPolicy(manifest, 'add_note')).toBe('prior')
  })

  it('a field the mapping does not write is off; the company overrides the default', () => {
    const p = crm()
    expect(effectiveFieldPolicy(p, p.mapping, 'update_deal', 'closed')).toBe('off')
    expect(effectiveFieldPolicy(p, p.mapping, 'update_deal', 'close_date')).toBe('prior')
    expect(effectiveFieldPolicy(p, p.mapping, 'update_deal', 'amount')).toBe('prior')
  })
})

describe('types (§8-2, §8-3)', () => {
  it('a type name does not carry its layer or the plugin name', () => {
    for (const bad of ['pack_deal', 'core_deal', 'company_deal', 'deal_custom', 'industry_deal', 'sample_crm_deal', 'crm_deal']) {
      expect(typeNameLayerProblem(bad, 'sample-crm'), bad).not.toBeNull()
    }
    for (const ok of ['deal', 'company', 'sales_deal', 'customer']) expect(typeNameLayerProblem(ok, 'sample-crm'), ok).toBeNull()
    expect(manifestErrors(SALES.manifest.replace('types: [deal, customer]', 'types: [pack_deal]')).join()).toContain('置き場所')
  })

  it("a business package's types are server-only, and every listed type has its file (no more, no less)", () => {
    expect(validatePluginPackage(SALES).ok).toBe(true)
    const fileType = { ...SALES.types, deal: SALES.types.deal.replace('storage: server', 'storage: either') }
    const r = validatePluginPackage({ ...SALES, types: fileType })
    expect(r.ok ? [] : r.errors.join()).toContain('storage は server')
    const extra = validatePluginPackage({ ...SALES, types: { ...SALES.types, other: SALES.types.deal } })
    expect(extra.ok).toBe(false)
    const missing = validatePluginPackage({ ...SALES, types: { deal: SALES.types.deal } })
    expect(missing.ok ? [] : missing.errors.join()).toContain('customer')
  })

  it("who names the type's person fields or the fixed actors only", () => {
    const r = validatePluginPackage({ ...CRM_SALES, manifest: salesWith('    who: [viewer, ai]', '    who: [viewer, ai, boss]') })
    expect(r.ok ? [] : r.errors.join()).toContain('who「boss」')
  })

  it('a plugin says viewer (can read the record), never anyone', () => {
    expect(manifestErrors(salesWith('    who: [viewer, ai]', '    who: [anyone, ai]')).join()).toContain('viewer')
  })
})

describe('a connector is a shared part; a business plugin uses it (owner decision 2026-11-01)', () => {
  it('a connector knows no business plugin; a business plugin names its connector and the oldest version it accepts', () => {
    const c = valid(CRM)
    expect(c.manifest).toMatchObject({ role: 'connector', types: [], uses: null, fieldPolicyDefaults: {} })
    expect(c.types).toEqual({})
    expect(Object.values(c.manifest.objects).every(o => o.recordType === null)).toBe(true)
    expect(Object.values(c.manifest.operations).every(o => o.who.length === 0 && !o.decision)).toBe(true)
    expect(valid(CRM_SALES).manifest).toMatchObject({ role: 'business', service: '', types: ['deal', 'customer'], uses: { connector: { id: 'sample-crm', minVersion: '0.1.0' } } })
  })

  it('a connector refuses what belongs to a business plugin, naming where it goes; and the old shapes', () => {
    expect(manifestErrors(`${CRM.manifest}types: [deal]\n`).join()).toContain('型を持ちません')
    const withFiles = validatePluginPackage({ ...CRM, types: { deal: SALES.types.deal } })
    expect(withFiles.ok ? [] : withFiles.errors.join()).toContain('型（types/）を持ちません')
    const withMapping = validatePluginPackage({ ...CRM, mapping: CRM_SALES.mapping })
    expect(withMapping.ok ? [] : withMapping.errors.join()).toContain('読み替え表（mapping.yaml）は置けません')
    // hubspot@0.2.0's keys: maps_to, record types, who / decision / note / policy / fields, field policy defaults.
    expect(manifestErrors(`${CRM.manifest}maps_to: sample-crm-sales@0.1.0\n`).join()).toContain('maps_to はなくなりました')
    expect(manifestErrors(crmWith('  deal:\n    auto_properties', '  deal:\n    record_type: deal\n    auto_properties')).join()).toContain('record_type は、つなぎ先を使う業務のプラグインの objects')
    for (const key of ['who: [viewer]', 'decision: true', 'note: optional', 'policy: prior', 'fields: mapped']) {
      expect(manifestErrors(crmWith('    label: 最新を取る\n', `    label: 最新を取る\n    ${key}\n`)).join(), key).toMatch(/業務のプラグインの operations に書きます|fields は書きません/)
    }
    expect(manifestErrors(`${CRM.manifest}field_policy_defaults: { next_step: auto }\n`).join()).toContain('業務のプラグインに書きます')
  })

  it('a business plugin talks to the outside only through a connector: no service, destination, scopes or account', () => {
    for (const line of ['base_url: https://api.hubapi.com', 'scopes: []', 'operation_scopes: {}', 'account_info: { method: GET, path: "/x" }', 'maps_to: sample-sales@0.1.0']) {
      const key = line.split(':')[0]
      expect(manifestErrors(`${SALES.manifest}${line}\n`).join(), line).toContain(`「${key}」はつなぎ先のプラグイン`)
    }
    // `service` makes it a connector: then its types are refused.
    expect(manifestErrors(`${SALES.manifest}service: hubspot\n`).join()).toContain('型を持ちません')
    expect(manifestErrors(SALES.manifest.replace('types: [deal, customer]', 'types: []')).join()).toContain('types')
  })

  it('connector: one connector id and a minimum version; objects, operations, policies and a mapping only with it', () => {
    for (const bad of ['sample-hub', 'sample-hub@0.1.0', 'sample-hub >= 0.1', 'Sample-Hub >= 0.1.0', 'sample-hub > 0.1.0', '[sample-hub]']) {
      expect(manifestErrors(SALES.manifest.replace('connector: sample-hub >= 0.1.0', `connector: ${bad}`)).join(), bad).toContain('connector は')
    }
    expect(manifestErrors(SALES.manifest.replace('connector: sample-hub >= 0.1.0', 'connector: sample-sales >= 0.1.0')).join()).toContain('自分自身')
    const alone = SALES.manifest.replace('connector: sample-hub >= 0.1.0\n', '')
    for (const key of ['objects', 'operations', 'field_policy_defaults']) expect(manifestErrors(alone).join(), key).toContain(`「${key}」は、つなぎ先を使う業務のプラグイン`)
    // Inside ACB only: types and nothing else is a complete business plugin.
    const acbOnly = alone.replace(/\nobjects:[\s\S]*$/, '\n')
    expect(manifestErrors(acbOnly)).toEqual([])
    const mappingAlone = validatePluginPackage({ ...SALES, manifest: acbOnly, mapping: CRM_SALES.mapping })
    expect(mappingAlone.ok ? [] : mappingAlone.errors.join()).toContain('読み替え表')
    // An object's record type is one of its own types.
    expect(manifestErrors(salesWith('  deal: { record_type: deal }', '  deal: { record_type: lead }')).join()).toContain('この業務のプラグインの types にある型')
  })

  it('the use is refused with another connector, an older version, or what the connector does not offer', () => {
    expect(useErrors(CRM_SALES, readPackage('sample-hub')).join()).toContain('使うつなぎ先は sample-crm です')
    expect(useErrors({ ...CRM_SALES, manifest: salesWith('connector: sample-crm >= 0.1.0', 'connector: sample-crm >= 0.2.0') }, CRM).join()).toContain('0.2.0 以上が要ります')
    expect(useErrors(CRM_SALES, { ...CRM, manifest: crmWith('version: 0.1.0', 'version: 1.0.0') })).toEqual([])
    expect(useErrors({ ...CRM_SALES, manifest: salesWith('  refresh_deal:\n', '  archive_deal:\n    who: [admin]\n  refresh_deal:\n') }, CRM).join()).toContain('操作「archive_deal」は「見本の CRM」0.1.0 にありません')
    expect(useErrors({ ...CRM_SALES, manifest: salesWith('  deal: { record_type: deal }', '  deal: { record_type: deal }\n  lead: {}') }, CRM).join()).toContain('対象「lead」は')
    // An operation on an object the business plugin did not make one of its types.
    expect(useErrors({ ...CRM_SALES, manifest: salesWith('  deal: { record_type: deal }', '  deal: {}') }, CRM).join()).toContain('record_type')
    // A connector cannot stand in for a business plugin, nor the other way round.
    expect(combineUse(valid(CRM), valid(CRM).manifest).ok).toBe(false)
    expect(combineUse(valid(CRM_SALES), valid(CRM_SALES).manifest).ok).toBe(false)
  })

  it('only what the business plugin declared runs: two business plugins on one connector get their own operations and people', () => {
    const p = crm()
    expect(Object.keys(p.manifest.operations).sort()).toEqual(['add_note', 'create_deal', 'log_meeting', 'refresh_deal', 'update_deal'])
    expect(p.manifest).toMatchObject({ id: 'sample-crm-sales', version: '0.1.0', label: '見本の CRM', service: 'sample-crm', role: 'business' })
    expect(p.manifest.objects.deal.recordType).toBe('deal')
    // A narrower business plugin on the same connector: reads only, and only its viewers.
    const reader = { ...CRM_SALES, manifest: CRM_SALES.manifest.replace('id: sample-crm-sales', 'id: deal-reader').replace(/\noperations:[\s\S]*?\nfield_policy_defaults:/, '\noperations:\n  refresh_deal:\n    who: [viewer]\nfield_policy_defaults:') }
    const narrow = use(reader, CRM)
    expect(Object.keys(narrow.manifest.operations)).toEqual(['refresh_deal'])
    expect(narrow.manifest.operations.refresh_deal.who).toEqual(['viewer'])
    expect(Object.keys(narrow.manifest.objects)).toEqual(['deal'])
    expect(Object.keys(narrow.manifest.operationScopes)).toEqual([])
    // Its mapping cannot write back (no update operation in its use), whatever the other plugin may.
    const m = parsePluginMapping('deal:\n  fields:\n    next_step: { from: next_step, write: true }\n', narrow)
    expect(m.ok ? [] : m.errors.join()).toContain('書き換える操作がない')
  })

  it("a business plugin cannot own a core type's name (one owner per type name)", () => {
    expect(manifestErrors(SALES.manifest.replace('types: [deal, customer]', 'types: [deal, task]')).join()).toContain('型「task」は本体の型です')
    expect(manifestErrors(SALES.manifest.replace('types: [deal, customer]', 'types: [deal, meeting]')).join()).toContain('本体の型')
  })
})

describe('owner rules of 2026-10-31 (review §5.3; decisions)', () => {
  it('the stage may be automatic only with closing stages; a move to or from one always asks first (owner 2026-11-06)', () => {
    const p = crm()
    const STAGE = '    stage: { from: dealstage, write: true, values: { appointmentscheduled: first_meeting, qualifiedtobuy: proposal, closedwon: final } }\n'
    // Without closing_stages nothing tells a closing move apart: auto is refused and clamped to prior.
    const noClosing = parsePluginMapping(`deal:\n  fields:\n${STAGE}policy:\n  stage: auto\n`, p)
    expect(noClosing.ok ? [] : noClosing.errors.join()).toContain('closing_stages')
    const write = parsePluginMapping(`deal:\n  fields:\n${STAGE}policy:\n  stage: prior\n`, p)
    if (!write.ok) throw new Error(write.errors.join())
    const forged = { ...write.value, policy: { stage: 'auto' as const } }
    expect(effectiveFieldPolicy(p, forged, 'update_deal', 'stage')).toBe('prior')
    // The package's default may say auto (a company mapping without closing stages still clamps it).
    expect(manifestErrors(salesWith('  stage: off', '  stage: auto')).join()).not.toContain('stage')
    // With closing stages the field is automatic…
    const closing = parsePluginMapping(`deal:\n  fields:\n${STAGE}policy:\n  stage: auto\nclosing_stages: [final]\n`, p)
    if (!closing.ok) throw new Error(closing.errors.join())
    expect(effectiveFieldPolicy(p, closing.value, 'update_deal', 'stage')).toBe('auto')
    // …but a move to a closing stage, or away from one, is named (and so asks first, at least a department manager).
    expect(closingMoveFields(p, closing.value, 'update_deal', { stage: 'proposal' }, { stage: 'first_meeting' })).toEqual([])
    expect(closingMoveFields(p, closing.value, 'update_deal', { stage: 'final' }, { stage: 'proposal' })).toEqual(['stage'])
    expect(closingMoveFields(p, closing.value, 'update_deal', { stage: 'proposal' }, { stage: 'final' })).toEqual(['stage'])
    expect(approverFor(p.manifest, closing.value, 'update_deal', { stage: 'proposal' }, ['stage'])).toBe('dept_manager')
    // Judged on the outside property: another field written to the stage's property cannot close the deal either.
    const shared = parsePluginMapping('deal:\n  fields:\n    next_step: { from: dealstage, write: true }\n    stage: { from: dealstage, write: false, values: { qualifiedtobuy: proposal, closedwon: final } }\npolicy:\n  stage: auto\n  next_step: auto\nclosing_stages: [final]\n', p)
    if (!shared.ok) throw new Error(shared.errors.join())
    expect(effectiveFieldPolicy(p, shared.value, 'update_deal', 'next_step')).toBe('auto')
    expect(closingMoveFields(p, shared.value, 'update_deal', { next_step: 'closedwon' }, {})).toEqual(['next_step'])
    expect(closingMoveFields(p, shared.value, 'update_deal', { next_step: 'qualifiedtobuy' }, { stage: 'proposal' })).toEqual([])
    // Without closing stages that field is clamped as before.
    const sharedNoClosing = { ...shared.value, closingStages: [] }
    expect(effectiveFieldPolicy(p, sharedNoClosing, 'update_deal', 'next_step')).toBe('prior')
  })

  it('the policy is judged on the outside property: an auto field cannot reach what a stricter field reads', () => {
    const p = crm()
    // `closed` (prior) and `next_step` (auto) read the same outside property: writing next_step is prior.
    const m = parsePluginMapping('deal:\n  fields:\n    next_step: { from: shared_prop, write: true }\n    closed: { from: shared_prop, write: false }\n', p)
    if (!m.ok) throw new Error(m.errors.join())
    expect(effectiveFieldPolicy(p, m.value, 'update_deal', 'next_step')).toBe('prior')
    const alone = parsePluginMapping('deal:\n  fields:\n    next_step: { from: own_prop, write: true }\n    closed: { from: shared_prop, write: false }\n', p)
    if (!alone.ok) throw new Error(alone.errors.join())
    expect(effectiveFieldPolicy(p, alone.value, 'update_deal', 'next_step')).toBe('auto')
  })

  it('decision: only on operations that write; update_deal is one', () => {
    expect(crm().manifest.operations.update_deal.decision).toBe(true)
    expect(crm().manifest.operations.refresh_deal.decision).toBe(false)
    expect(useErrors({ ...CRM_SALES, manifest: salesWith('    who: [viewer, ai]\n', '    who: [viewer, ai]\n    decision: true\n') }, CRM).join()).toContain('decision')
  })
})

describe('available_to (§8-4)', () => {
  it('absent = every company; present = only the listed ones', () => {
    expect(pluginAvailableTo(crm().manifest, 'any-company')).toBe(true)
    const desk = valid(DESK)
    expect(pluginAvailableTo(desk.manifest, 'company-desk-only')).toBe(true)
    expect(pluginAvailableTo(desk.manifest, 'another-company')).toBe(false)
  })

  it('a company package must say which companies; the list is ids, unique, not empty', () => {
    for (const text of [DESK.manifest, SUPPORT.manifest]) {
      expect(manifestErrors(text.replace('available_to: [company-desk-only]\n', '')).join()).toContain('available_to')
      expect(manifestErrors(text.replace('[company-desk-only]', '[]'))).not.toEqual([])
      expect(manifestErrors(text.replace('[company-desk-only]', '[a, a]'))).not.toEqual([])
      expect(manifestErrors(text.replace('[company-desk-only]', '["../x"]'))).not.toEqual([])
    }
  })
})

describe('translating values', () => {
  const p = crm()
  const hubspotLike = { dealname: '研修導入', dealstage: 'qualifiedtobuy', kakudo: 'medium', next_step: '資料送付', closedate: '2026-12-15T00:00:00Z', amount: '1200000', is_closed_won: 'false', owner_id: '75123001' }

  it('a tags field cannot be mapped either way (its stored JSON text would be written outside as is)', () => {
    const withTags = { ...p, types: { ...p.types, deal: { ...p.types.deal, fields: { ...p.types.deal.fields, labels: { label: 'タグ', kind: 'tags' as const, source: 'server' as const } } } } }
    for (const write of [true, false]) {
      const m = parsePluginMapping(`deal:\n  fields:\n    labels: { from: hs_tag, write: ${write} }\n`, withTags)
      expect(m.ok ? [] : m.errors.join()).toContain('タグの欄')
    }
  })

  it('outside → ACB through the mapping', () => {
    const r = externalToAcb(p, p.mapping, 'deal', hubspotLike)
    expect(r.problems).toEqual([])
    expect(r.values).toEqual({ title: '研修導入', stage: 'proposal', confidence: 'b', next_step: '資料送付', close_date: '2026-12-15', amount: 1200000, closed: false, assignee: 'member-a' })
  })

  it('ACB → outside → ACB gives back what was written, for every writable field', () => {
    const change = { confidence: 'a', next_step: '11/7 デモ', close_date: '2027-01-31', amount: 1500000, assignee: 'member-b' }
    const out = acbToExternal(p, p.mapping, 'deal', change)
    if (!out.ok) throw new Error(out.errors.join())
    expect(out.properties).toEqual({ kakudo: 'high', next_step: '11/7 デモ', closedate: '2027-01-31', amount: '1500000', owner_id: '75123002' })
    expect(externalToAcb(p, p.mapping, 'deal', out.properties).values).toEqual(change)
  })

  it('the same ACB arguments become each company\'s own outside values (one plugin, two mappings)', () => {
    const other = parsePluginMapping('deal:\n  fields:\n    confidence: { from: forecast_probability, write: true, values: { "0.8": a, "0.5": b, "0.2": c } }\n', p)
    if (!other.ok) throw new Error(other.errors.join())
    const out = acbToExternal(p, other.value, 'deal', { confidence: 'a' })
    expect(out).toEqual({ ok: true, properties: { forecast_probability: '0.8' } })
    expect(externalToAcb(p, other.value, 'deal', { forecast_probability: '0.8' }).values).toEqual({ confidence: 'a' })
  })

  it('refuses to write a field the mapping does not write back, or a value it cannot translate, and writes nothing', () => {
    expect(acbToExternal(p, p.mapping, 'deal', { next_step: 'x', closed: true }).ok).toBe(false)
    expect(acbToExternal(p, p.mapping, 'deal', { next_step: 'x', title: 'renamed' }).ok).toBe(false)
    expect(acbToExternal(p, p.mapping, 'deal', { confidence: 'z' }).ok).toBe(false)
    expect(acbToExternal(p, p.mapping, 'deal', { assignee: 'member-unknown' }).ok).toBe(false)
    expect(acbToExternal(p, p.mapping, 'deal', { amount: '100' }).ok).toBe(false)
  })

  it('an outside value the mapping does not know is left out and reported without the value', () => {
    const r = externalToAcb(p, p.mapping, 'deal', { kakudo: 'secret-tier-xyz', owner_id: '999' })
    expect(r.values).toEqual({})
    expect(r.problems).toHaveLength(2)
    expect(r.problems.join()).not.toContain('secret-tier-xyz')
  })
})

describe('mapping checks', () => {
  const p = crm()
  const errorsOf = (text: string) => { const r = parsePluginMapping(text, p); return r.ok ? [] : r.errors }

  it('refuses mappings that name what the type does not have, or that could not write back unambiguously', () => {
    expect(errorsOf('deal:\n  fields:\n    budget: { from: amount }\n').join()).toContain('サーバーの欄ではありません')
    expect(errorsOf('deal:\n  fields:\n    confidence: { from: kakudo, write: true, values: { high: s } }\n').join()).toContain('右側は')
    expect(errorsOf('deal:\n  fields:\n    confidence: { from: kakudo, write: true, values: { high: a, top: a } }\n').join()).toContain('書き戻せません')
    expect(errorsOf('deal:\n  fields:\n    next_step: { from: x, write: true }\n    amount: { from: x, write: true }\n').join()).toContain('同じ外の項目')
    expect(errorsOf('deal:\n  fields:\n    assignee: { from: owner_id, people: owners }\npeople:\n  owners: { "1": member-a, "2": member-a }\n').join()).toContain('同じメンバー')
    expect(errorsOf('deal:\n  fields:\n    assignee: { from: owner_id, people: owners }\npeople:\n  owners: { "1": 田中 太郎 }\n')).not.toEqual([])
    expect(errorsOf('ticket:\n  fields: {}\n').join()).toContain('対象ではありません')
    expect(errorsOf('deal:\n  visible_to_folder: ../営業\n')).not.toEqual([])
  })

  it('write: true needs an update operation for the object', () => {
    const r = parsePluginMapping('ticket:\n  fields:\n    opened: { from: created_at, write: true }\n', use(SUPPORT, DESK))
    expect(r.ok ? [] : r.errors.join()).toContain('書き換える操作がない')
  })

  it("against the outside system's properties: unknown or read-only properties are errors, auto-set ones a warning", () => {
    const props = [
      { name: 'dealname', readOnly: false, options: null }, { name: 'dealstage', readOnly: false, options: ['appointmentscheduled', 'qualifiedtobuy', 'presentationscheduled', 'decisionmakerboughtin'] },
      { name: 'kakudo', readOnly: false, options: ['high', 'medium'] }, { name: 'next_step', readOnly: false, options: null },
      { name: 'closedate', readOnly: false, options: null }, { name: 'amount', readOnly: true, options: null },
      { name: 'owner_id', readOnly: false, options: null },
    ]
    const r = checkMappingAgainstProperties(p.manifest, p.mapping, 'deal', props)
    expect(r.errors.join('\n')).toMatch(/is_closed_won.*ありません/)
    expect(r.errors.join('\n')).toMatch(/amount.*書き換えられない/)
    expect(r.errors.join('\n')).toMatch(/「low」は、つなぎ先の選択肢にありません/)
    expect(r.errors).toHaveLength(3)
    const auto = parsePluginMapping('deal:\n  fields:\n    next_step: { from: stage_probability, write: true }\n', p)
    if (!auto.ok) throw new Error(auto.errors.join())
    expect(checkMappingAgainstProperties(p.manifest, auto.value, 'deal', [{ name: 'stage_probability', readOnly: false, options: null }]).warnings).toHaveLength(1)
  })
})

describe('create operations (milestone 4: log_meeting, create_deal; design 節目4 §3-6)', () => {
  it('every create names the unique outside property its operation id goes to, so a lost answer is looked up, never re-sent', () => {
    expect(crm().manifest.operations.log_meeting).toMatchObject({ correlationProperty: 'acb_operation_id', associationType: 212, createsRecord: false })
    expect(manifestErrors(crmWith('    association_type: 212\n    correlation_property: acb_operation_id\n', '    association_type: 212\n')).join()).toContain('correlation_property')
  })

  it('an attached create fills fixed content slots only, with an association type', () => {
    expect(crm().manifest.operations.log_meeting.content).toEqual({ title: 'hs_meeting_title', body: 'hs_meeting_body', at: 'hs_timestamp' })
    expect(manifestErrors(crmWith('content: { title: hs_meeting_title,', 'content: { amount: amount, title: hs_meeting_title,')).join()).toContain('content の「amount」')
    expect(manifestErrors(crmWith('    association_type: 212\n', '')).join()).toContain('association_type')
  })

  it('creating a record (create_deal) is never automatic: declaration, company mapping and run time', () => {
    const p = crm()
    expect(p.manifest.operations.create_deal.createsRecord).toBe(true)
    expect(effectiveOperationPolicy(p.manifest, 'create_deal', p.mapping)).toBe('prior')
    expect(useErrors({ ...CRM_SALES, manifest: salesWith('  create_deal:\n    who: [viewer, ai]\n', '  create_deal:\n    who: [viewer, ai]\n    policy: auto\n') }, CRM).join()).toContain('自動」にできません')
    const m = parsePluginMapping(`${CRM_SALES.mapping}  create_deal: auto\n`, p)
    expect(m.ok ? [] : m.errors.join()).toContain('自動」にできません')
    expect(effectiveOperationPolicy(p.manifest, 'create_deal', { policy: { create_deal: 'auto' } })).toBe('prior')
  })

  it('the company chooses whether a meeting log is automatic (design §9 q17)', () => {
    const p = crm()
    expect(effectiveOperationPolicy(p.manifest, 'log_meeting', p.mapping)).toBe('auto')
    const m = parsePluginMapping(`${CRM_SALES.mapping}  log_meeting: prior\n`, p)
    if (!m.ok) throw new Error(m.errors.join())
    expect(effectiveOperationPolicy(p.manifest, 'log_meeting', m.value)).toBe('prior')
  })
})

describe('similar records before a create of a record (plugins.md "Similar records", owner decision 2026-11-02)', () => {
  const HUB = readPackage('sample-hub')
  const SIMILAR_LINE = '    similar: { by: [counterpart, name], search: search_deals, status: stage }\n'
  const SEARCH = '    kind: search\n    object: deal\n    counterpart: { object: company, property: associations.company }\n'
  const hubWith = (from: string, to: string) => { expect(HUB.manifest).toContain(from); return { ...HUB, manifest: HUB.manifest.replace(from, to) } }
  const salesUse = (from: string, to: string) => { expect(SALES.manifest).toContain(from); return { ...SALES, manifest: SALES.manifest.replace(from, to) } }

  it('a connector search is read only and no operation; the business plugin\'s similar resolves it, with the 相手 object', () => {
    const hub = valid(HUB).manifest
    expect(hub.searches).toEqual({ search_deals: { label: '似ている取引を探す', object: 'deal', counterpart: { object: 'company', property: 'associations.company' } } })
    expect(hub.operations.search_deals).toBeUndefined()
    const p = use(SALES, HUB)
    expect(p.manifest.operations.create_deal.similar).toEqual({
      by: ['counterpart', 'name'], status: 'stage',
      search: { operation: 'search_deals', label: '似ている取引を探す', object: 'deal', counterpart: { object: 'company', property: 'associations.company' } },
    })
    expect(p.manifest.operations.search_deals).toBeUndefined()
    // Without `similar` nothing changes (by name through the object's search, as before).
    expect(use({ ...SALES, manifest: SALES.manifest.replace(SIMILAR_LINE, '') }, HUB).manifest.operations.create_deal.similar).toBeUndefined()
  })

  it('a connector search needs the object\'s search call, says how it matches a 相手, and takes no write keys', () => {
    expect(useErrors(SALES, hubWith(SEARCH, '    kind: search\n    object: contact\n')).join()).toContain('探す操作の対象には search が要ります')
    expect(useErrors(SALES, hubWith(SEARCH, SEARCH.replace('associations.company', 'associations company'))).join()).toContain('counterpart の property は外の項目名')
    expect(useErrors(SALES, hubWith(SEARCH, SEARCH.replace('object: company,', 'object: ticket,'))).join()).toContain('counterpart の object は objects にある名前')
    expect(useErrors(SALES, hubWith(SEARCH, `${SEARCH}    undo: archive\n`)).join()).toContain('undo')
    expect(useErrors(SALES, hubWith(SEARCH, `${SEARCH}    who: [viewer]\n`)).join()).toContain('業務のプラグインの operations に書きます')
  })

  it('similar: only on a create of a record, by counterpart / name, a choice field as status, a search of the same object', () => {
    const errs = (f: Files, h: Files = HUB) => useErrors(f, h).join('\n')
    expect(errs(salesUse('  refresh_deal:\n    who: [viewer, ai]\n', '  refresh_deal:\n    who: [viewer, ai]\n    similar: { by: [name] }\n'))).toContain('記録を新しく作る操作だけ')
    expect(errs(salesUse(SIMILAR_LINE, '    similar: { by: [] }\n'))).toContain('similar の by は')
    expect(errs(salesUse(SIMILAR_LINE, '    similar: { by: [name, name] }\n'))).toContain('similar の by は')
    expect(errs(salesUse(SIMILAR_LINE, '    similar: { by: [domain] }\n'))).toContain('similar の by は')
    expect(errs(salesUse(SIMILAR_LINE, '    similar: { by: [name], when: always }\n'))).toContain('when')
    expect(errs(salesUse(SIMILAR_LINE, '    similar: { by: [name], status: next_step }\n'))).toContain('選ぶ欄（choice）ではありません')
    expect(errs(salesUse(SIMILAR_LINE, '    similar: { by: [name], search: find_deals }\n'))).toContain('探す操作（kind: search）にありません')
    expect(errs(SALES, hubWith(SEARCH, '    kind: search\n    object: meeting\n'))).toContain('対象「deal」を探すものではありません')
    // By 相手 only, with a search that cannot match one: refused (it would never ask anything).
    expect(errs(salesUse(SIMILAR_LINE, '    similar: { by: [counterpart], search: search_deals }\n'), hubWith(SEARCH, '    kind: search\n    object: deal\n'))).toContain('by のどれでも探せません')
    // The 相手 object must be one of the business plugin's types (its records hold the outside id).
    expect(errs(salesUse('  company: { record_type: customer }\n', ''))).toContain('相手で探すには、対象「company」を objects で')
    // A search is not an operation the business plugin uses directly.
    expect(errs(salesUse('  refresh_deal:\n', '  search_deals:\n    who: [viewer]\n  refresh_deal:\n'))).toContain('探す操作です')
  })
})

describe('who approves (design 節目4 §3-4, §9 q2/q3)', () => {
  it('defaults: the member for the stage and creating a deal, the department manager for the amount; the strictest field wins', () => {
    const p = crm()
    const m = p.mapping
    expect(approverFor(p.manifest, m, 'update_deal', { confidence: 'a' })).toBe('self')
    expect(approverFor(p.manifest, m, 'update_deal', { amount: 1500000 })).toBe('dept_manager')
    expect(approverFor(p.manifest, m, 'update_deal', { confidence: 'a', amount: 1500000 })).toBe('dept_manager')
    expect(approverFor(p.manifest, m, 'create_deal', {})).toBe('self')
  })

  it('moving the stage to a closing stage needs at least a department manager, whatever the mapping says', () => {
    const p = crm()
    const m = parsePluginMapping('deal:\n  fields:\n    stage: { from: dealstage, write: true, values: { qualifiedtobuy: proposal, closedwon: final } }\napproval_by:\n  stage: self\nclosing_stages: [final]\n', p)
    if (!m.ok) throw new Error(m.errors.join())
    expect(approverFor(p.manifest, m.value, 'update_deal', { stage: 'proposal' })).toBe('self')
    expect(approverFor(p.manifest, m.value, 'update_deal', { stage: 'final' })).toBe('dept_manager')
  })

  it('approval_by names only written fields or create operations, with a known rule', () => {
    const p = crm()
    const bad = parsePluginMapping(`${CRM_SALES.mapping}approval_by:\n  title: self\n  amount: boss\n`, p)
    expect(bad.ok ? [] : bad.errors.join()).toMatch(/title.*書き戻す欄か作る操作|amount.*self \/ dept_manager \/ admin/s)
  })
})
