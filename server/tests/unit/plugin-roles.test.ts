/**
 * Business roles' rules in shared/core (plan C3, `.claude/rules/plugin-roles.md`).
 *
 * Guards:
 * - a role is approved only by its holders (or an owner / admin), never by a
 *   department manager as such; it ranks between dept_manager and admin, and
 *   two different roles in one request need an owner / admin;
 * - a package's type may name only roles the plugin declares (`role:<name>`
 *   in an action's `who`), so contract 1 none;
 * - a mapping's `approval_by` may name a declared role, never another.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { mayApprove, stricterApprover } from '../../../shared/core/approvals'
import { combineUse, parsePluginMapping, validatePluginPackage } from '../../../shared/core/plugins'
import { parseTypeFile } from '../../../shared/core/record-types'

const FIXTURES = join(__dirname, '../fixtures/plugins')
const read = (name: string) => {
  const dir = join(FIXTURES, name)
  const types = !existsSync(join(dir, 'types')) ? {} : Object.fromEntries(readdirSync(join(dir, 'types')).map(f => [f.replace(/\.md$/, ''), readFileSync(join(dir, 'types', f), 'utf8')]))
  return { manifest: readFileSync(join(dir, 'plugin.yaml'), 'utf8'), types, mapping: null, steps: {}, ui: [] as string[] }
}
const SALES = read('sample-sales')
const HUB = read('sample-hub')
const asContract2 = (m: string) => m.replace('contract: 1', 'contract: 2') + '\nroles:\n  sales_manager: { label: 営業の責任者 }\n'
const withAction = (who: string) => ({
  ...SALES.types,
  deal: SALES.types.deal.replace('final: [won, lost]\n', `final: [won, lost]\nactions:\n  close_won: { label: 受注にする, from: [open], to: won, who: [${who}] }\n`),
})

describe('who approves a role', () => {
  it('only its holders or an owner / admin — not a department manager as such', () => {
    const rule = 'role:sales_manager' as const
    expect(mayApprove(rule, { isRequester: false, isDeptManager: true, isAdmin: false, holdsRole: false })).toBe(false)
    expect(mayApprove(rule, { isRequester: true, isDeptManager: false, isAdmin: false })).toBe(false)
    expect(mayApprove(rule, { isRequester: false, isDeptManager: false, isAdmin: false, holdsRole: true })).toBe(true)
    expect(mayApprove(rule, { isRequester: false, isDeptManager: false, isAdmin: true })).toBe(true)
    // A role holder is not thereby a department manager.
    expect(mayApprove('dept_manager', { isRequester: false, isDeptManager: false, isAdmin: false, holdsRole: true })).toBe(false)
  })

  it('ranks between dept_manager and admin; two different roles need an owner / admin', () => {
    expect(stricterApprover('dept_manager', 'role:sales_manager')).toBe('role:sales_manager')
    expect(stricterApprover('role:sales_manager', 'self')).toBe('role:sales_manager')
    expect(stricterApprover('role:sales_manager', 'admin')).toBe('admin')
    expect(stricterApprover('role:sales_manager', 'role:sales_manager')).toBe('role:sales_manager')
    expect(stricterApprover('role:sales_manager', 'role:finance')).toBe('admin')
  })
})

describe('roles in a package and a mapping', () => {
  it('a type\'s action may name only a declared role (contract 1 declares none)', () => {
    expect(parseTypeFile('deal', withAction('role:sales_manager').deal).ok).toBe(true)
    expect(validatePluginPackage({ ...SALES, manifest: asContract2(SALES.manifest), types: withAction('assignee, role:sales_manager') }).ok).toBe(true)
    const undeclared = validatePluginPackage({ ...SALES, manifest: asContract2(SALES.manifest), types: withAction('role:finance') })
    expect(undeclared.ok).toBe(false)
    expect(JSON.stringify(undeclared)).toContain('role:finance')
    expect(validatePluginPackage({ ...SALES, types: withAction('role:sales_manager') }).ok).toBe(false)
  })

  it('a mapping\'s approval_by names a declared role, never another', () => {
    const business = validatePluginPackage({ ...SALES, manifest: asContract2(SALES.manifest) })
    const connector = validatePluginPackage(HUB)
    if (!business.ok || !connector.ok) throw new Error('fixtures')
    const use = combineUse(business.value, connector.value.manifest)
    if (!use.ok) throw new Error(use.errors.join(' / '))
    const mapping = (who: string) => `deal:\n  fields:\n    amount: { from: amount, write: true }\napproval_by:\n  amount: ${who}\n`
    const ok = parsePluginMapping(mapping('role:sales_manager'), use.value)
    expect(ok.ok && ok.value.approvalBy.amount).toBe('role:sales_manager')
    expect(parsePluginMapping(mapping('role:finance'), use.value).ok).toBe(false)
    expect(parsePluginMapping(mapping('role'), use.value).ok).toBe(false)
  })
})
