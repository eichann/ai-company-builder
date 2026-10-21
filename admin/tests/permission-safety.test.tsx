// Safety nets around rule changes: the outdated-app dialog (409
// OUTDATED_CLIENTS) and rules whose folder disappeared (orphanedScopes).
import type { ReactNode } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import OverviewPage from '@/app/companies/[id]/page'
import PermissionsPage from '@/app/companies/[id]/permissions/page'
import type { OrphanedScope, OutdatedMember, PermissionScope } from '@/lib/api'
import { base, companyRoutes, renderInCompany } from './company-harness'
import {
  COMPANY_ID,
  effectiveAt,
  managerCapabilities,
  ok,
  ownerCapabilities,
  permissionScopes,
  quietOverview,
} from './fixtures'
import { mockApi, type Call } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => `/companies/${COMPANY_ID}`,
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const MESSAGE = '次のメンバーは古いアプリを使っているため、編集を制限すると同期できなくなります。先にアプリを更新してもらってください。'

const tanakaOld: OutdatedMember = {
  userId: 'u_member',
  name: '田中 太郎',
  email: 'tanaka@example.com',
  role: 'member',
  clientVersion: null,
  version: '不明',
  lastSeenAt: '2026-10-20T08:00:00.000Z',
}

const orphan: OrphanedScope = {
  scopeId: 's_old',
  path: '営業部/旧契約書',
  kind: 'folder',
  departmentId: null,
  rules: [
    { id: 'r_old_everyone', subjectType: 'everyone', subjectId: null, subjectLabel: '全員', canRead: true, canWrite: false },
    { id: 'r_old_tanaka', subjectType: 'user', subjectId: 'u_member', subjectLabel: '田中 太郎', canRead: true, canWrite: true },
  ],
  summary: 'everyone-r',
  since: '2026-10-21T00:00:00.000Z',
}

const orphanScope: PermissionScope = {
  id: orphan.scopeId,
  path: orphan.path,
  kind: 'folder',
  departmentId: null,
  repoId: null,
  inherited: false,
  rules: orphan.rules,
  effectiveSummary: 'everyone-r',
  inheritedFrom: null,
}

async function treeRow(name: string): Promise<HTMLElement> {
  const tree = await screen.findByRole('tree')
  const row = within(tree).getAllByRole('button').find((b) => b.hasAttribute('data-tree-row') && b.textContent?.startsWith(name))
  if (!row) throw new Error(`no tree row ${name}`)
  return row
}

function permissionRoutes(caps = ownerCapabilities, extra: { orphanedScopes?: OrphanedScope[]; scopes?: PermissionScope[] } = {}) {
  return {
    ...companyRoutes(caps),
    [`GET ${base}/permissions`]: { body: ok({ scopes: extra.scopes ?? permissionScopes, orphanedScopes: extra.orphanedScopes ?? [] }) },
    [`GET ${base}/permissions/effective?path=`]: { body: ok(effectiveAt('', '', ['u_member'])) },
    [`GET ${base}/permissions/effective?path=営業部`]: { body: ok(effectiveAt('営業部', '', ['u_member'])) },
    [`GET ${base}/permissions/effective?path=営業部/契約書`]: { body: ok(effectiveAt('営業部/契約書', '営業部/契約書', ['u_member'])) },
    [`GET ${base}/permissions/effective?path=営業部/旧契約書`]: { body: ok(effectiveAt('営業部/旧契約書', '営業部/旧契約書', ['u_member'])) },
  }
}

/** PUT answers 409 OUTDATED_CLIENTS unless the request says force. */
function outdatedPut(calls: () => Call[], canForce: boolean) {
  return () => {
    const last = calls().at(-1)
    if ((last?.body as { force?: boolean } | undefined)?.force) return { body: ok({ scope: null, rules: [] }) }
    return {
      status: 409,
      body: { error: 'Some members who would lose edit access use a desktop app that cannot recover from a write restriction', code: 'OUTDATED_CLIENTS', members: [tanakaOld], canForce },
    }
  }
}

/** 契約書 is 指定した人だけ（田中）; taking 田中 out and saving takes edit away from him. */
async function restrictContracts() {
  await userEvent.click(await treeRow('契約書'))
  const chips = await screen.findByRole('list', { name: '編集できる人' })
  await userEvent.click(within(chips).getByRole('button', { name: '田中 太郎を外す' }))
  await userEvent.click(screen.getByRole('button', { name: '保存' }))
  const confirm = await screen.findByRole('dialog')
  await userEvent.click(within(confirm).getByRole('button', { name: '保存する' }))
}

const puts = (calls: Call[]) => calls.filter((c) => c.method === 'PUT').map((c) => c.body)

describe('outdated apps (409 OUTDATED_CLIENTS)', () => {
  it('explains who must update, links to the members screen, and lets an owner save anyway', async () => {
    const success = vi.spyOn(toast, 'success')
    const error = vi.spyOn(toast, 'error')
    let calls: Call[] = []
    const api = mockApi({ ...permissionRoutes(), [`PUT ${base}/permissions/scopes/by-path`]: outdatedPut(() => calls, true) })
    calls = api.calls
    renderInCompany(<PermissionsPage />)
    await restrictContracts()

    const dialog = await screen.findByRole('dialog', { name: /アプリの更新が必要なメンバーがいます/ })
    expect(within(dialog).getByText(MESSAGE)).toBeInTheDocument()
    const list = within(dialog).getByRole('list', { name: '古いアプリを使っているメンバー' })
    expect(within(list).getByText('田中 太郎')).toBeInTheDocument()
    expect(within(list).getByText('tanaka@example.com')).toBeInTheDocument()
    expect(within(list).getByText('不明')).toBeInTheDocument()
    expect(within(list).getByText(/^最終接続/)).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: /メンバー画面で確認/ })).toHaveAttribute('href', `/companies/${COMPANY_ID}/members`)
    expect(error).not.toHaveBeenCalled()
    expect(puts(calls)).toHaveLength(1)

    await userEvent.click(within(dialog).getByRole('button', { name: 'それでも保存する' }))
    await waitFor(() =>
      expect(puts(calls)[1]).toEqual({
        path: '営業部/契約書',
        rules: [{ subjectType: 'everyone', subjectId: null, canWrite: false }],
        force: true,
      })
    )
    await waitFor(() => expect(success).toHaveBeenCalledWith(expect.stringContaining('契約書：編集できる人を'), expect.anything()))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('closing the dialog saves nothing', async () => {
    let calls: Call[] = []
    const api = mockApi({ ...permissionRoutes(), [`PUT ${base}/permissions/scopes/by-path`]: outdatedPut(() => calls, true) })
    calls = api.calls
    renderInCompany(<PermissionsPage />)
    await restrictContracts()
    const dialog = await screen.findByRole('dialog', { name: /アプリの更新が必要なメンバーがいます/ })
    await userEvent.click(within(dialog).getByRole('button', { name: '保存せずに戻る' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(puts(calls)).toHaveLength(1)
    // The draft is still there to save later.
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
  })

  it('a department manager gets the explanation but no override', async () => {
    let calls: Call[] = []
    const subtree = permissionScopes.filter((s) => s.path.startsWith('営業部'))
    const api = mockApi({
      ...permissionRoutes(managerCapabilities, { scopes: subtree }),
      [`PUT ${base}/permissions/scopes/by-path`]: outdatedPut(() => calls, false),
    })
    calls = api.calls
    renderInCompany(<PermissionsPage />)
    await restrictContracts()
    const dialog = await screen.findByRole('dialog', { name: /アプリの更新が必要なメンバーがいます/ })
    expect(within(dialog).getByText(MESSAGE)).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'それでも保存する' })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: /メンバー画面で確認/ })).toBeInTheDocument()
  })
})

describe('rules whose folder is missing (orphanedScopes)', () => {
  const title = 'ルールが付いているフォルダが見つかりません（名前の変更・削除の可能性）'

  it('権限: warns, marks the tree row, and moves the rules to a picked folder', async () => {
    const success = vi.spyOn(toast, 'success')
    const { calls } = mockApi({
      ...permissionRoutes(ownerCapabilities, { orphanedScopes: [orphan], scopes: [...permissionScopes, orphanScope] }),
      [`GET ${base}/permissions/folders?path=営業部`]: {
        body: ok({
          path: '営業部',
          folders: [
            { name: '契約書', path: '営業部/契約書', scopeId: 's_sales_contracts', hasRules: true },
            { name: '契約書2026', path: '営業部/契約書2026', scopeId: null, hasRules: false },
          ],
        }),
      },
      [`POST ${base}/permissions/scopes/s_old/move`]: { body: ok({ moved: 2, toPath: '営業部/契約書2026', scopeId: 's_new' }) },
    })
    renderInCompany(<PermissionsPage />)
    const card = await screen.findByRole('region', { name: title })
    expect(within(card).getByText('営業部/旧契約書')).toBeInTheDocument()
    expect(within(card).getByText(/編集できる人：指定した人だけ（田中 太郎）/)).toBeInTheDocument()
    expect(within(await treeRow('旧契約書')).getByText('見つかりません')).toBeInTheDocument()

    await userEvent.click(within(card).getByRole('button', { name: '新しい場所に移す' }))
    const dialog = await screen.findByRole('dialog', { name: '新しい場所に移す' })
    const options = await within(dialog).findAllByRole('option')
    expect(options[0]).toBeDisabled() // already has rules
    expect(within(dialog).getByRole('button', { name: 'ここに移す' })).toBeDisabled()
    await userEvent.click(within(dialog).getByRole('option', { name: /契約書2026/ }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'ここに移す' }))
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.body])).toEqual([
        [`${base}/permissions/scopes/s_old/move`, { toPath: '営業部/契約書2026' }],
      ])
    )
    await waitFor(() => expect(success).toHaveBeenCalledWith('ルールを「営業部/契約書2026」に移しました'))
  })

  it('権限: the move dialog goes up when the old parent is gone too', async () => {
    const gone: OrphanedScope = { ...orphan, scopeId: 's_gone', path: '旧部署/資料' }
    mockApi({
      ...permissionRoutes(ownerCapabilities, { orphanedScopes: [gone] }),
      [`GET ${base}/permissions/folders?path=旧部署`]: { status: 404, body: { error: 'Folder not found in the company repository' } },
      [`GET ${base}/permissions/folders?path=`]: {
        body: ok({ path: '', folders: [{ name: '営業部', path: '営業部', scopeId: 's_sales', hasRules: false }] }),
      },
    })
    renderInCompany(<PermissionsPage />)
    const card = await screen.findByRole('region', { name: title })
    await userEvent.click(within(card).getByRole('button', { name: '新しい場所に移す' }))
    const dialog = await screen.findByRole('dialog', { name: '新しい場所に移す' })
    expect(await within(dialog).findByRole('option', { name: /営業部/ })).toBeEnabled()
    expect(within(dialog).getByText('会社のフォルダ全体')).toBeInTheDocument()
  })

  it('権限: ルールを削除 asks first, then removes the rules', async () => {
    const { calls } = mockApi({
      ...permissionRoutes(ownerCapabilities, { orphanedScopes: [orphan] }),
      [`DELETE ${base}/permissions/scopes/s_old/rules`]: { body: ok({ removed: 2 }) },
    })
    renderInCompany(<PermissionsPage />)
    const card = await screen.findByRole('region', { name: title })
    await userEvent.click(within(card).getByRole('button', { name: 'ルールを削除' }))
    const dialog = await screen.findByRole('dialog', { name: 'ルールを削除しますか？' })
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    await userEvent.click(within(dialog).getByRole('button', { name: 'ルールを削除' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([`${base}/permissions/scopes/s_old/rules`]))
  })

  it('権限: removing is guarded against outdated apps too, and an owner can force it', async () => {
    let calls: Call[] = []
    const api = mockApi({
      ...permissionRoutes(ownerCapabilities, { orphanedScopes: [orphan] }),
      [`DELETE ${base}/permissions/scopes/s_old/rules`]: {
        status: 409,
        body: { error: 'x cannot recover from a write restriction', code: 'OUTDATED_CLIENTS', members: [tanakaOld], canForce: true },
      },
      [`DELETE ${base}/permissions/scopes/s_old/rules?force=true`]: { body: ok({ removed: 2 }) },
    })
    calls = api.calls
    renderInCompany(<PermissionsPage />)
    const card = await screen.findByRole('region', { name: title })
    await userEvent.click(within(card).getByRole('button', { name: 'ルールを削除' }))
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'ルールを削除しますか？' })).getByRole('button', { name: 'ルールを削除' }))
    const outdated = await screen.findByRole('dialog', { name: /アプリの更新が必要なメンバーがいます/ })
    await userEvent.click(within(outdated).getByRole('button', { name: 'それでも保存する' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url).at(-1)).toBe(`${base}/permissions/scopes/s_old/rules?force=true`))
  })

  it('権限: no card when nothing is missing (or the server is older)', async () => {
    mockApi({ ...companyRoutes(), [`GET ${base}/permissions`]: { body: ok({ scopes: permissionScopes }) }, [`GET ${base}/permissions/effective?path=`]: { body: ok(effectiveAt('', '', [])) } })
    renderInCompany(<PermissionsPage />)
    expect(await screen.findByText('会社全体の基本ルール')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: title })).not.toBeInTheDocument()
  })

  it('概要: lists them under 要対応 with a link to 権限', async () => {
    mockApi({
      ...companyRoutes(),
      [`GET ${base}/overview`]: {
        body: ok({
          ...quietOverview,
          attention: {
            ...quietOverview.attention,
            orphanedScopes: [{ scopeId: 's_old', path: '営業部/旧契約書', kind: 'folder', ruleCount: 2, summary: 'everyone-r', since: '2026-10-21T00:00:00.000Z' }],
          },
        }),
      },
    })
    renderInCompany(<OverviewPage />)
    expect(await screen.findByText(title)).toBeInTheDocument()
    expect(screen.getByText(/要対応/)).toHaveTextContent('1件')
    expect(screen.getByText('営業部/旧契約書')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /権限の画面で対応する/ })).toHaveAttribute('href', `/companies/${COMPANY_ID}/permissions`)
  })
})
