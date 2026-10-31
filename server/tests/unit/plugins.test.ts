/**
 * Connector plugins' shape (shared/core/plugins.ts, milestone 3 P1).
 *
 * Guards:
 * - a declaration is data only: unknown keys, program / destination / key /
 *   approval keys, a different contract, a destination other than one
 *   https host, and unsafe paths make the package unusable;
 * - operations reaching people outside the company are never `auto`
 *   (declaration, company mapping, and at run time);
 * - type names carry no layer or plugin name (§8-2), and a package's types
 *   are server-only (imported records create no files, §8-3);
 * - `available_to` limits a package to the listed companies (§8-4);
 * - values translate both ways without loss, and a mapping that could not
 *   write back unambiguously is refused;
 * - the same mechanism takes a second, differently shaped package (§6-11).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  acbToExternal, approverFor, checkMappingAgainstProperties, effectiveFieldPolicy, effectiveOperationPolicy, externalToAcb,
  parsePluginManifest, parsePluginMapping, pluginAvailableTo, typeNameLayerProblem, validatePluginPackage,
  type PluginPackage,
} from '../../../shared/core/plugins'

const FIXTURES = join(__dirname, '../fixtures/plugins')

function readPackage(name: string): { manifest: string; types: Record<string, string>; mapping: string } {
  const dir = join(FIXTURES, name)
  const types: Record<string, string> = {}
  for (const f of readdirSync(join(dir, 'types'))) types[f.replace(/\.md$/, '')] = readFileSync(join(dir, 'types', f), 'utf8')
  return { manifest: readFileSync(join(dir, 'plugin.yaml'), 'utf8'), types, mapping: readFileSync(join(dir, 'mapping.yaml'), 'utf8') }
}

const CRM = readPackage('sample-crm')

function crm(): PluginPackage {
  const r = validatePluginPackage(CRM)
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return r.value
}

/** The CRM declaration with one line replaced (the line must exist). */
function crmWith(from: string, to: string): string {
  expect(CRM.manifest).toContain(from)
  return CRM.manifest.replace(from, to)
}

function manifestErrors(text: string): string[] {
  const r = parsePluginManifest(text)
  return r.ok ? [] : r.errors
}

describe('the sample packages', () => {
  it('a CRM package and a differently shaped help-desk package are both accepted with their mappings', () => {
    expect(crm().mapping).not.toBeNull()
    const desk = validatePluginPackage(readPackage('sample-desk'))
    if (!desk.ok) throw new Error(desk.errors.join('\n'))
    expect(desk.value.manifest.objects.ticket.recordType).toBe('ticket')
  })
})

describe('a declaration is data only', () => {
  it('refuses unknown keys anywhere, naming program, destination, key and approval keys', () => {
    expect(manifestErrors(`${CRM.manifest}\nscript: ./sync.js\n`).join()).toContain('プログラムは書けません')
    expect(manifestErrors(crmWith('    label: 最新を取る\n', '    label: 最新を取る\n    command: curl x\n')).join()).toContain('プログラムを起動する')
    expect(manifestErrors(crmWith('  deal:\n    record_type: deal\n', '  deal:\n    record_type: deal\n    url: https://evil.example\n')).join()).toContain('送り先は base_url だけです')
    expect(manifestErrors(`${CRM.manifest}\napi_key: pat-123\n`).join()).toContain('鍵の値は書けません')
    expect(manifestErrors(crmWith('    note: optional\n', '    note: optional\n    approver: admin\n')).join()).toContain('承認する権限は書けません')
    expect(manifestErrors(crmWith('    get:    { method: GET,   path: "/crm/objects/2026-03/deals/{id}" }', '    get:    { method: GET,   path: "/crm/objects/2026-03/deals/{id}", when: x }')).length).toBeGreaterThan(0)
    expect(manifestErrors(`${CRM.manifest}\nwhatever: 1\n`).join()).toContain('知らない項目「whatever」')
  })

  it('a package that writes names how to read its outside account (a connection is bound to one account, review §5.7)', () => {
    const without = crmWith('account_info: { method: GET, path: "/account-info/v3/details" }\n', '')
    expect(manifestErrors(without).join()).toContain('account_info')
    expect(manifestErrors(crmWith('account_info: { method: GET,', 'account_info: { method: POST,')).join()).toContain('account_info')
    // A package that only reads (the help desk) needs none.
    expect(validatePluginPackage(readPackage('sample-desk')).ok).toBe(true)
  })

  it('refuses a contract this build does not know', () => {
    expect(manifestErrors(crmWith('contract: 1', 'contract: 2')).join()).toContain('contract')
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
  const externalUpdate = crmWith('    reaches: internal\n    undo: restore_previous', '    reaches: external\n    undo: restore_previous')

  it('the declaration cannot make an external operation or its fields auto', () => {
    // field_policy_defaults has auto fields: refused once update_deal reaches outside people.
    expect(manifestErrors(externalUpdate).join()).toContain('「自動」にできません')
    const createExternal = crmWith('    reaches: internal\n    undo: archive', '    reaches: external\n    undo: archive\n    policy: auto')
    expect(manifestErrors(createExternal).join()).toContain('社外の人に届く操作は「自動」にできません')
  })

  it('a company mapping cannot set auto on a field an external operation writes', () => {
    const noAutoDefaults = externalUpdate.replace(/field_policy_defaults:[\s\S]*$/, '')
    const m = parsePluginManifest(noAutoDefaults)
    if (!m.ok) throw new Error(m.errors.join('\n'))
    const pkg = { manifest: m.value, types: crm().types }
    const r = parsePluginMapping(`${CRM.mapping}\n`.replace('  close_date: prior', '  close_date: auto'), pkg)
    expect(r.ok ? [] : r.errors.join()).toContain('「自動」にできません')
  })

  it('at run time an external operation is at least prior, whatever the stored settings say', () => {
    const p = crm()
    const manifest = { ...p.manifest, operations: { ...p.manifest.operations } }
    manifest.operations.update_deal = { ...manifest.operations.update_deal, reaches: 'external' }
    manifest.operations.add_note = { ...manifest.operations.add_note, reaches: 'external', policy: 'auto' }
    expect(effectiveFieldPolicy(p.manifest, p.mapping!, 'update_deal', 'next_step')).toBe('auto')
    expect(effectiveFieldPolicy(manifest, p.mapping!, 'update_deal', 'next_step')).toBe('prior')
    expect(effectiveOperationPolicy(manifest, 'add_note')).toBe('prior')
  })

  it('a field the mapping does not write is off; the company overrides the default', () => {
    const p = crm()
    expect(effectiveFieldPolicy(p.manifest, p.mapping!, 'update_deal', 'closed')).toBe('off')
    expect(effectiveFieldPolicy(p.manifest, p.mapping!, 'update_deal', 'close_date')).toBe('prior')
    expect(effectiveFieldPolicy(p.manifest, p.mapping!, 'update_deal', 'amount')).toBe('prior')
  })
})

describe('types (§8-2, §8-3)', () => {
  it('a type name does not carry its layer or the plugin name', () => {
    for (const bad of ['pack_deal', 'core_deal', 'company_deal', 'deal_custom', 'industry_deal', 'sample_crm_deal', 'crm_deal']) {
      expect(typeNameLayerProblem(bad, 'sample-crm'), bad).not.toBeNull()
    }
    for (const ok of ['deal', 'company', 'sales_deal', 'customer']) expect(typeNameLayerProblem(ok, 'sample-crm'), ok).toBeNull()
    expect(manifestErrors(crmWith('types: [deal]', 'types: [pack_deal]')).join()).toContain('置き場所')
  })

  it("a package's types are server-only, and every listed type has its file (no more, no less)", () => {
    const fileType = { ...CRM.types, deal: CRM.types.deal.replace('storage: server', 'storage: either') }
    const r = validatePluginPackage({ ...CRM, types: fileType })
    expect(r.ok ? [] : r.errors.join()).toContain('storage は server')
    const extra = validatePluginPackage({ ...CRM, types: { ...CRM.types, other: CRM.types.deal } })
    expect(extra.ok).toBe(false)
    const missing = validatePluginPackage({ ...CRM, types: {} })
    expect(missing.ok).toBe(false)
  })

  it("who names the type's person fields or the fixed actors only", () => {
    const r = validatePluginPackage({ ...CRM, manifest: crmWith('    who: [viewer, ai]', '    who: [viewer, ai, boss]') })
    expect(r.ok ? [] : r.errors.join()).toContain('who「boss」')
  })

  it('a plugin says viewer (can read the record), never anyone', () => {
    expect(manifestErrors(crmWith('    who: [viewer, ai]', '    who: [anyone, ai]')).join()).toContain('viewer')
  })
})

describe('owner rules of 2026-10-31 (review §5.3; decisions)', () => {
  it('stage is written only after an approval (milestone 4): never an auto default or policy; at least prior at run time', () => {
    const p = crm()
    const write = parsePluginMapping('deal:\n  fields:\n    stage: { from: dealstage, write: true, values: { qualifiedtobuy: proposal } }\npolicy:\n  stage: prior\n', p)
    if (!write.ok) throw new Error(write.errors.join())
    expect(effectiveFieldPolicy(p.manifest, write.value, 'update_deal', 'stage')).toBe('prior')
    expect(manifestErrors(crmWith('  stage: off', '  stage: auto')).join()).toContain('auto）にできません')
    const policy = parsePluginMapping('deal:\n  fields:\n    stage: { from: dealstage, write: true, values: { qualifiedtobuy: proposal } }\npolicy:\n  stage: auto\n', p)
    expect(policy.ok ? [] : policy.errors.join()).toContain('auto）にできません')
    // Whatever is stored: a mapping object built by hand still answers prior.
    const forged = { ...write.value, policy: { stage: 'auto' as const } }
    expect(effectiveFieldPolicy(p.manifest, forged, 'update_deal', 'stage')).toBe('prior')
    // A field reading the same property as the stage cannot be written automatically either.
    const shared = parsePluginMapping('deal:\n  fields:\n    next_step: { from: dealstage, write: true }\n    stage: { from: dealstage, write: false, values: { qualifiedtobuy: proposal } }\npolicy:\n  stage: prior\n', p)
    if (!shared.ok) throw new Error(shared.errors.join())
    expect(effectiveFieldPolicy(p.manifest, { ...shared.value, policy: { ...shared.value.policy, stage: 'auto' as const } }, 'update_deal', 'next_step')).toBe('prior')
  })

  it('the policy is judged on the outside property: an auto field cannot reach what a stricter field reads', () => {
    const p = crm()
    // `closed` (prior) and `next_step` (auto) read the same outside property: writing next_step is prior.
    const m = parsePluginMapping('deal:\n  fields:\n    next_step: { from: shared_prop, write: true }\n    closed: { from: shared_prop, write: false }\n', p)
    if (!m.ok) throw new Error(m.errors.join())
    expect(effectiveFieldPolicy(p.manifest, m.value, 'update_deal', 'next_step')).toBe('prior')
    const alone = parsePluginMapping('deal:\n  fields:\n    next_step: { from: own_prop, write: true }\n    closed: { from: shared_prop, write: false }\n', p)
    if (!alone.ok) throw new Error(alone.errors.join())
    expect(effectiveFieldPolicy(p.manifest, alone.value, 'update_deal', 'next_step')).toBe('auto')
  })

  it('decision: only on operations that write; update_deal is one', () => {
    expect(crm().manifest.operations.update_deal.decision).toBe(true)
    expect(crm().manifest.operations.refresh_deal.decision).toBe(false)
    expect(manifestErrors(crmWith('    who: [viewer, ai]\n', '    who: [viewer, ai]\n    decision: true\n')).join()).toContain('decision')
  })
})

describe('available_to (§8-4)', () => {
  it('absent = every company; present = only the listed ones', () => {
    expect(pluginAvailableTo(crm().manifest, 'any-company')).toBe(true)
    const desk = validatePluginPackage(readPackage('sample-desk'))
    if (!desk.ok) throw new Error(desk.errors.join())
    expect(pluginAvailableTo(desk.value.manifest, 'company-desk-only')).toBe(true)
    expect(pluginAvailableTo(desk.value.manifest, 'another-company')).toBe(false)
  })

  it('a company package must say which companies; the list is ids, unique, not empty', () => {
    const desk = readPackage('sample-desk').manifest
    expect(manifestErrors(desk.replace('available_to: [company-desk-only]\n', '')).join()).toContain('available_to')
    expect(manifestErrors(desk.replace('[company-desk-only]', '[]'))).not.toEqual([])
    expect(manifestErrors(desk.replace('[company-desk-only]', '[a, a]'))).not.toEqual([])
    expect(manifestErrors(desk.replace('[company-desk-only]', '["../x"]'))).not.toEqual([])
  })
})

describe('translating values', () => {
  const p = crm()
  const hubspotLike = { dealname: '研修導入', dealstage: 'qualifiedtobuy', kakudo: 'medium', next_step: '資料送付', closedate: '2026-12-15T00:00:00Z', amount: '1200000', is_closed_won: 'false', owner_id: '75123001' }

  it('outside → ACB through the mapping', () => {
    const r = externalToAcb(p, p.mapping!, 'deal', hubspotLike)
    expect(r.problems).toEqual([])
    expect(r.values).toEqual({ title: '研修導入', stage: 'proposal', confidence: 'b', next_step: '資料送付', close_date: '2026-12-15', amount: 1200000, closed: false, assignee: 'member-a' })
  })

  it('ACB → outside → ACB gives back what was written, for every writable field', () => {
    const change = { confidence: 'a', next_step: '11/7 デモ', close_date: '2027-01-31', amount: 1500000, assignee: 'member-b' }
    const out = acbToExternal(p, p.mapping!, 'deal', change)
    if (!out.ok) throw new Error(out.errors.join())
    expect(out.properties).toEqual({ kakudo: 'high', next_step: '11/7 デモ', closedate: '2027-01-31', amount: '1500000', owner_id: '75123002' })
    expect(externalToAcb(p, p.mapping!, 'deal', out.properties).values).toEqual(change)
  })

  it('the same ACB arguments become each company\'s own outside values (one plugin, two mappings)', () => {
    const other = parsePluginMapping('deal:\n  fields:\n    confidence: { from: forecast_probability, write: true, values: { "0.8": a, "0.5": b, "0.2": c } }\n', p)
    if (!other.ok) throw new Error(other.errors.join())
    const out = acbToExternal(p, other.value, 'deal', { confidence: 'a' })
    expect(out).toEqual({ ok: true, properties: { forecast_probability: '0.8' } })
    expect(externalToAcb(p, other.value, 'deal', { forecast_probability: '0.8' }).values).toEqual({ confidence: 'a' })
  })

  it('refuses to write a field the mapping does not write back, or a value it cannot translate, and writes nothing', () => {
    expect(acbToExternal(p, p.mapping!, 'deal', { next_step: 'x', closed: true }).ok).toBe(false)
    expect(acbToExternal(p, p.mapping!, 'deal', { next_step: 'x', title: 'renamed' }).ok).toBe(false)
    expect(acbToExternal(p, p.mapping!, 'deal', { confidence: 'z' }).ok).toBe(false)
    expect(acbToExternal(p, p.mapping!, 'deal', { assignee: 'member-unknown' }).ok).toBe(false)
    expect(acbToExternal(p, p.mapping!, 'deal', { amount: '100' }).ok).toBe(false)
  })

  it('an outside value the mapping does not know is left out and reported without the value', () => {
    const r = externalToAcb(p, p.mapping!, 'deal', { kakudo: 'secret-tier-xyz', owner_id: '999' })
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
    const desk = validatePluginPackage(readPackage('sample-desk'))
    if (!desk.ok) throw new Error(desk.errors.join())
    const r = parsePluginMapping('ticket:\n  fields:\n    opened: { from: created_at, write: true }\n', desk.value)
    expect(r.ok ? [] : r.errors.join()).toContain('書き換える操作がない')
  })

  it("against the outside system's properties: unknown or read-only properties are errors, auto-set ones a warning", () => {
    const props = [
      { name: 'dealname', readOnly: false, options: null }, { name: 'dealstage', readOnly: false, options: ['appointmentscheduled', 'qualifiedtobuy', 'presentationscheduled', 'decisionmakerboughtin'] },
      { name: 'kakudo', readOnly: false, options: ['high', 'medium'] }, { name: 'next_step', readOnly: false, options: null },
      { name: 'closedate', readOnly: false, options: null }, { name: 'amount', readOnly: true, options: null },
      { name: 'owner_id', readOnly: false, options: null },
    ]
    const r = checkMappingAgainstProperties(p.manifest, p.mapping!, 'deal', props)
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
    expect(manifestErrors(crmWith('    fields: mapped\n    who: [viewer, ai]\n', '    fields: mapped\n    who: [viewer, ai]\n    policy: auto\n')).join()).toContain('自動」にできません')
    const m = parsePluginMapping(`${CRM.mapping}  create_deal: auto\n`, p)
    expect(m.ok ? [] : m.errors.join()).toContain('自動」にできません')
    expect(effectiveOperationPolicy(p.manifest, 'create_deal', { policy: { create_deal: 'auto' } })).toBe('prior')
  })

  it('the company chooses whether a meeting log is automatic (design §9 q17)', () => {
    const p = crm()
    expect(effectiveOperationPolicy(p.manifest, 'log_meeting', p.mapping)).toBe('auto')
    const m = parsePluginMapping(`${CRM.mapping}  log_meeting: prior\n`, p)
    if (!m.ok) throw new Error(m.errors.join())
    expect(effectiveOperationPolicy(p.manifest, 'log_meeting', m.value)).toBe('prior')
  })
})

describe('who approves (design 節目4 §3-4, §9 q2/q3)', () => {
  it('defaults: the member for the stage and creating a deal, the department manager for the amount; the strictest field wins', () => {
    const p = crm()
    const m = p.mapping!
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
    const bad = parsePluginMapping(`${CRM.mapping}approval_by:\n  title: self\n  amount: boss\n`, p)
    expect(bad.ok ? [] : bad.errors.join()).toMatch(/title.*書き戻す欄か作る操作|amount.*self \/ dept_manager \/ admin/s)
  })
})
